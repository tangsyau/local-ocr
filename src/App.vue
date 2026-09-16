<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import TableResultViewer from "./components/TableResultViewer.vue";
import ImagePreview from "./components/ImagePreview.vue";
import { defaultTextSettings, normalizeTextSettings, projectText, verifyTextProcessingRuntime, type TextSettings } from "./lib/text-processing";
import { ocrSidecar, SidecarRequestError } from "./lib/sidecar";
import { displayTables, imageBatchTables, mergeTablePages, tableToTsv } from "./lib/table-results";
import { naturalPathCompare, naturalSortPaths } from "./lib/file-order";
import { appendResultPage, beginStreamingResult, canResumeResult, completeStreamingResult, finalizeResult } from "./lib/result-state";
import { localImagePreview, createId, isWebkitGtk40Build, listenBeforeClose, listenFileDrop, openLocalDialog } from "./lib/tauri-bridge";
import { loadSession, saveSession, sessionHeader, listHistory, readHistory, deleteHistory, type HistoryEntry, type AppSettings, type PageCheckpoint, type SavedSession } from "./lib/session";
import type { DiagnosticInfo, ModelCacheStatus, ModelProfile, OcrPage, OcrResult, OcrTable, OcrTask, OcrTaskStatus, RecognitionMode, SidecarEvent } from "./lib/types";

type AppPhase = "starting" | "idle" | "preparing" | "recognizing" | "paused" | "error";
type SavePhase = "loading" | "idle" | "saving" | "saved" | "error";

const phase = ref<AppPhase>("starting");
const status = ref("正在启动本地识别进程……");
const tasks = ref<OcrTask[]>([]);
const selectedTaskId = ref("");
const scoreThreshold = ref(0.5);
const modelProfile = ref<ModelProfile>("fast");
const recognitionMode = ref<RecognitionMode>("text");
const preparedProfile = ref<ModelProfile | null>(null);
const preparedMode = ref<RecognitionMode | null>(null);
const resultView = ref<"text" | "tables">("text");
const textSettings = ref<TextSettings>({ ...defaultTextSettings });
const rawTextView = ref(false);
const rubyPreview = ref(true);
const textProjection = computed(() => rawTextView.value ? rawTextProjection.value : formattedTextProjection.value);
const formattedTextProjection = computed(() => selectedResult.value
  ? projectText(selectedResult.value, textSettings.value, selectedTask.value?.textEdited, false)
  : { text: "", html: "", raw: "", warnings: [] });
const rawTextProjection = computed(() => selectedResult.value
  ? projectText(selectedResult.value, textSettings.value, false, true)
  : { text: "", html: "", raw: "", warnings: [] });
const resultFocusMode = ref(false);
const mergeCrossPageTables = ref(true);
const exportTxt = ref(true);
const exportXlsx = ref(true);
const exportHtml = ref(false);
const exportGrouping = ref<"separate" | "combined">("separate");
const exportCollision = ref<"rename" | "skip" | "overwrite">("rename");
const exportPrefix = ref("");
const exportSuffix = ref("");
const exportName = ref("批量识别结果");
const exportBusy = ref(false);
const autoExport = ref(false);
const autoExportDirectory = ref("");
const historyOpen = ref(false);
const historyBusy = ref(false);
const historyError = ref("");
const historyEntries = ref<HistoryEntry[]>([]);
const historySearch = ref("");
const historyPage = ref(1);
const historySelected = ref<string[]>([]);
const filteredHistory = computed(() => historyEntries.value.filter(entry => entry.task.fileName.toLocaleLowerCase().includes(historySearch.value.toLocaleLowerCase())));
const historyPageCount = computed(() => Math.max(1, Math.ceil(filteredHistory.value.length / 20)));
const visibleHistory = computed(() => filteredHistory.value.slice((historyPage.value - 1) * 20, historyPage.value * 20));
watch(historySearch, () => { historyPage.value = 1; });
function exportState(task: OcrTask): string {
  if (!task.result) return "";
  if (task.exportError) return `导出失败：${task.exportError}`;
  return task.exportedRevision === (task.revision ?? 0) ? "已导出" : "未导出当前结果";
}

const exportTextVersion = ref<"original" | "formatted">("formatted");
const exportScope = ref<"all" | "current" | "checked">("all");
const exportScopeLabel = computed(() => ({all:"全部已有结果",current:"当前文件",checked:"勾选任务"})[exportScope.value]);
const feedback = ref("");
const preparationCancelled = ref(false);
const preparationStage = ref("");
const queueTransition = ref<"" | "pausing" | "resuming" | "cancelling">("");
let pageValidation: Promise<boolean> | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
watch(feedback, value => {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  if (value && !/失败|错误|请先|无法/.test(value)) feedbackTimer = setTimeout(() => { feedback.value = ""; }, 5000);
});
const checkedTaskIds = ref<string[]>([]);
const saveStatus = ref("正在读取上次任务……");
const saveFailed = ref(false);
const savePhase = ref<SavePhase>("loading");
let sessionLoaded = false;
let restoringSettings = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveChain: Promise<void> = Promise.resolve();
let saveSequence = 0;
const pendingPageSaves = new Map<string, PageCheckpoint>();
const pendingPageResets = new Set<string>();
const cleanupListeners: Array<() => void> = [];
let skipRequestedTaskId = "";
let activeTaskId = "";
const sidecarReady = ref(false);
const queueRunning = ref(false);
const queueStarting = ref(false);
const queuePaused = ref(false);
const stopRequested = ref(false);
const modelCache = ref<ModelCacheStatus | null>(null);
const modelManagerBusy = ref(false);
const localModelsOnly = ref(false);
const transferBusy = ref(false);
const transferMessage = ref("");
const transferPercent = ref<number | null>(null);
const transferCommitting = ref(false);
const transferCapabilities = ref(["fast:text"]);
const pageRangeMode = ref("all");
const pageRangeDraft = ref("");
const documentSettingsBusy = ref(false);
const documentSettingsError = ref("");
const errorSummary = ref("");
const errorDetails = ref("");

const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskId.value) ?? null);
const selectedResult = computed(() => selectedTask.value?.result ?? null);
const selectedPath = computed(() => selectedTask.value?.path ?? "");
const fileName = computed(() => selectedTask.value?.fileName ?? "");
const extension = computed(() => fileName.value.split(".").pop()?.toLowerCase() ?? "");
const isPdf = computed(() => extension.value === "pdf");
watch(selectedTaskId, () => {
  pageRangeDraft.value = selectedTask.value?.pageRange ?? "";
  pageRangeMode.value = pageRangeDraft.value ? "custom" : "all";
  documentSettingsError.value = "";
});
const pageRangeDirty = computed(() => isPdf.value && (pageRangeMode.value === "custom" && !pageRangeDraft.value.trim()
  || (pageRangeMode.value === "all" ? "" : pageRangeDraft.value.trim()) !== (selectedTask.value?.pageRange ?? "")));
const hasRecognizedRuby = computed(() => selectedResult.value?.pages.some(page => page.rubyEnabled || page.blocks.some(block => block.ruby?.length)));
const previewUrl = ref("");
const previewError = ref("");
watch(selectedPath, async (path, _, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  previewUrl.value = "";
  previewError.value = "";
  if (!path || isPdfPath(path)) return;
  try {
    const url = await localImagePreview(path);
    if (current) previewUrl.value = url;
  } catch {
    if (current) previewError.value = "无法读取原图片预览，请检查文件是否仍在原路径；已保存的识别结果不受影响。";
  }
});
const modelsReady = computed(
  () => preparedProfile.value === modelProfile.value && preparedMode.value === recognitionMode.value
);
const setupBusy = computed(() => phase.value === "starting" || phase.value === "preparing" || modelManagerBusy.value);
const modelControlsBusy = computed(() => queueRunning.value || queueStarting.value || setupBusy.value || exportBusy.value || historyBusy.value || documentSettingsBusy.value);
const queuedCount = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const completedCount = computed(() => tasks.value.filter((task) => task.status === "completed").length);
const allResultTasks = computed(() => tasks.value.filter((task) => task.result && task.result.pageCount > 0));
const exportableTasks = computed(() => allResultTasks.value.filter(task => exportScope.value === "all"
  || (exportScope.value === "current" ? task.id === selectedTaskId.value : checkedTaskIds.value.includes(task.id))));
const hasUnexported = computed(() => allResultTasks.value.some((task) => (task.exportedRevision ?? -1) !== (task.revision ?? 0)));
const failedCount = computed(() => tasks.value.filter((task) => task.status === "failed" || task.status === "cancelled").length);
const checkedPdfCount = computed(() => tasks.value.filter((task) => checkedTaskIds.value.includes(task.id) && isPdfPath(task.path)).length);
const saveBadgeLabel = computed(() => ({
  loading: "正在读取本机记录",
  idle: "自动保存已启用",
  saving: "正在自动保存",
  saved: "已自动保存",
  error: "自动保存失败"
})[savePhase.value]);
const tableTasks = computed(() => exportableTasks.value.filter((task) => (task.result?.rawTableCount ?? 0) > 0));
const selectedImageBatchTasks = computed(() => {
  const task = selectedTask.value;
  if (!task || isPdfPath(task.path)) return [];
  return tasks.value
    .filter((item) => item.batchId === task.batchId && !isPdfPath(item.path))
    .sort((left, right) => left.batchIndex - right.batchIndex);
});
const selectedUsesImageBatch = computed(
  () => !queueRunning.value && selectedImageBatchTasks.value.length > 1 && selectedImageBatchTasks.value.some((task) => task.result)
);
const selectedBatchResults = computed(() => selectedImageBatchTasks.value.map((task) => task.result ?? null));
const selectedTables = computed(() => selectedUsesImageBatch.value
  ? imageBatchTables(selectedBatchResults.value, mergeCrossPageTables.value)
  : displayTables(selectedResult.value, mergeCrossPageTables.value)
);
const selectedRawTableCount = computed(() => selectedUsesImageBatch.value
  ? imageBatchTables(selectedBatchResults.value, false).length
  : selectedResult.value?.rawTableCount ?? 0
);
const selectedMergedTableCount = computed(() => selectedUsesImageBatch.value
  ? imageBatchTables(selectedBatchResults.value, true).length
  : selectedResult.value?.tableCount ?? 0
);
const selectedHasMergedTables = computed(() => selectedRawTableCount.value > selectedMergedTableCount.value);
const selectedPageCount = computed(() => selectedUsesImageBatch.value
  ? selectedImageBatchTasks.value.filter((task) => task.result).length
  : selectedResult.value?.pageCount ?? 0
);
const selectedTotalPageCount = computed(() => selectedUsesImageBatch.value
  ? selectedImageBatchTasks.value.length
  : selectedResult.value?.selectedPageCount ?? selectedResult.value?.totalPageCount ?? 0
);
const selectedBlockCount = computed(() => selectedUsesImageBatch.value
  ? selectedImageBatchTasks.value.reduce((total, task) => total + (task.result?.blockCount ?? 0), 0)
  : selectedResult.value?.blockCount ?? 0
);
const selectedElapsedMs = computed(() => selectedUsesImageBatch.value
  ? selectedImageBatchTasks.value.reduce((total, task) => total + (task.result?.elapsedMs ?? 0), 0)
  : selectedResult.value?.elapsedMs ?? 0
);
const exportFormatSelected = computed(() => exportTxt.value || exportXlsx.value || exportHtml.value);
const canExportSelectedFormats = computed(() => !queueRunning.value && !queueStarting.value && !setupBusy.value && !exportBusy.value && exportFormatSelected.value && (
  (exportTxt.value && exportableTasks.value.length > 0)
  || (exportHtml.value && exportableTasks.value.length > 0)
  || (exportXlsx.value && tableTasks.value.length > 0)
));
const exportEstimate = computed(() => {
  const textCount = exportableTasks.value.length;
  const tableCount = tableExportItems().length;
  if (exportGrouping.value === "combined") return Number(exportTxt.value && textCount > 0)
    + Number(exportXlsx.value && tableCount > 0)
    + Number(exportHtml.value && (tableCount > 0 || exportableTasks.value.some(t=>t.resultType === "text")));
  return Number(exportTxt.value) * textCount
    + (Number(exportXlsx.value) + Number(exportHtml.value)) * tableCount
    + Number(exportHtml.value) * exportableTasks.value.filter(t=>t.resultType === "text").length;
});

const statusLabels: Record<OcrTaskStatus, string> = {
  queued: "等待",
  running: "识别中",
  paused: "已暂停",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消"
};

onMounted(async () => {
  window.addEventListener("keydown", handleGlobalKeydown);
  try {
    const saved = await loadSession();
    if (saved) {
      tasks.value = saved.tasks;
      selectedTaskId.value = saved.selectedTaskId;
      applySettings(saved.settings);
    }
    sessionLoaded = true;
    if (saved?.needsPageMigration) {
      for (const task of saved.tasks) for (const page of task.result?.pages ?? []) queuePageSave(task.id, page);
      void flushSave().catch(() => {});
    }
    saveStatus.value = saved ? `已恢复 ${saved.tasks.length} 个任务；未完成项等待手动开始` : "任务和校对内容将自动保存在本机";
    savePhase.value = saved ? "saved" : "idle";
  } catch (error) {
    saveFailed.value = true;
    savePhase.value = "error";
    saveStatus.value = error instanceof Error ? error.message : "读取自动保存失败";
  }
  cleanupListeners.push(ocrSidecar.onExit(() => {
    sidecarReady.value = false;
    preparedProfile.value = null;
    preparedMode.value = null;
    if (phase.value !== "starting") {
      phase.value = "error";
      status.value = "识别进程已退出，结果和等待队列仍保留。可点击“重启识别进程”后继续。";
    }
  }));
  for (const install of [() => listenFileDrop(addFiles), () => listenBeforeClose(beforeClose)]) {
    try { cleanupListeners.push(await install()); }
    catch { console.warn("当前环境不支持桌面窗口事件"); }
  }
  if (await startSidecar()) {
    await validateTaskPaths();
    await reportPackagedUiReady();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
  if (feedbackTimer) clearTimeout(feedbackTimer);
  for (const cleanup of cleanupListeners) cleanup();
  if (saveTimer) clearTimeout(saveTimer);
  void ocrSidecar.stop();
});

watch([() => sessionHeader({schema: 2, savedAt: "", selectedTaskId: "", settings: {} as AppSettings, tasks: tasks.value}).tasks, selectedTaskId, scoreThreshold, modelProfile, recognitionMode, mergeCrossPageTables,
  exportTxt, exportXlsx, exportHtml, exportGrouping, exportCollision, exportPrefix, exportSuffix, exportName, localModelsOnly, textSettings, exportTextVersion, autoExport, autoExportDirectory], () => {
  if (!sessionLoaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  savePhase.value = "saving";
  saveTimer = setTimeout(() => { void flushSave().catch(() => {}); }, 400);
}, { deep: true });

watch([() => textSettings.value.textMode, () => textSettings.value.rubyFormat, () => textSettings.value.crossPageText, exportTextVersion, mergeCrossPageTables], () => {
  if (restoringSettings) return;
  for (const task of tasks.value) if (task.result) task.revision = (task.revision ?? 0) + 1;
}, { deep: true });

function applySettings(settings: AppSettings): void {
  restoringSettings = true;
  modelProfile.value = settings.profile;
  recognitionMode.value = settings.mode;
  scoreThreshold.value = settings.threshold;
  mergeCrossPageTables.value = settings.merge;
  exportTxt.value = settings.formats.includes("txt");
  exportXlsx.value = settings.formats.includes("xlsx");
  exportHtml.value = settings.formats.includes("html");
  exportGrouping.value = settings.exportGrouping;
  exportCollision.value = settings.exportCollision;
  exportPrefix.value = settings.exportPrefix;
  exportSuffix.value = settings.exportSuffix;
  exportName.value = settings.exportName;
  localModelsOnly.value = settings.localModelsOnly === true;
  textSettings.value = normalizeTextSettings(settings.textSettings);
  rawTextView.value = false;
  exportTextVersion.value = settings.exportTextVersion ?? "formatted";
  autoExport.value = settings.autoExport === true;
  autoExportDirectory.value = settings.autoExportDirectory ?? "";
  void nextTick(() => { restoringSettings = false; });
}

function outputFormats(): string[] {
  return [exportTxt.value ? "txt" : "", exportXlsx.value ? "xlsx" : "", exportHtml.value ? "html" : ""].filter(Boolean);
}

async function flushSave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!sessionLoaded) throw new Error("自动保存尚未就绪");
  const sequence = ++saveSequence;
  savePhase.value = "saving";
  const snapshot = sessionHeader({
    schema: 2, savedAt: new Date().toISOString(), selectedTaskId: selectedTaskId.value, tasks: tasks.value,
    settings: { profile: modelProfile.value, mode: recognitionMode.value, threshold: scoreThreshold.value,
      merge: mergeCrossPageTables.value, formats: outputFormats(), exportGrouping: exportGrouping.value,
      exportCollision: exportCollision.value, exportPrefix: exportPrefix.value, exportSuffix: exportSuffix.value, exportName: exportName.value, localModelsOnly: localModelsOnly.value,
      textSettings: { ...textSettings.value }, rawTextView: false, exportTextVersion: exportTextVersion.value, autoExport: autoExport.value, autoExportDirectory: autoExportDirectory.value }
  });
  const pages = [...pendingPageSaves.values()];
  const resets = [...pendingPageResets];
  pendingPageSaves.clear();
  pendingPageResets.clear();
  saveChain = saveChain.catch(() => {}).then(() => saveSession(snapshot, { pages, resetTaskIds: resets }));
  try {
    await saveChain;
    if (sequence === saveSequence) {
      saveStatus.value = "任务与校对内容已自动保存（仅在本机）";
      saveFailed.value = false;
      savePhase.value = "saved";
    }
  } catch (error) {
    for (const page of pages) if (!pendingPageSaves.has(`${page.taskId}:${page.pageIndex}`)) {
      pendingPageSaves.set(`${page.taskId}:${page.pageIndex}`, page);
    }
    for (const taskId of resets) pendingPageResets.add(taskId);
    if (sequence === saveSequence) {
      saveFailed.value = true;
      savePhase.value = "error";
      saveStatus.value = error instanceof Error ? error.message : "自动保存失败";
    }
    throw error;
  }
}

function queuePageSave(taskId: string, page: OcrPage): void {
  const plainPage = JSON.parse(JSON.stringify(page)) as OcrPage;
  pendingPageSaves.set(`${taskId}:${Number(page.pageIndex)}`, { taskId, pageIndex: Number(page.pageIndex), page: plainPage });
}

function resetSavedPages(taskId: string): void {
  pendingPageResets.add(taskId);
  for (const key of [...pendingPageSaves.keys()]) if (key.startsWith(`${taskId}:`)) pendingPageSaves.delete(key);
}

async function beforeClose(): Promise<boolean> {
  if (historyBusy.value) { feedback.value = "正在保存或恢复历史，请稍后关闭。"; return false; }
  if ((modelControlsBusy.value || hasUnexported.value) && !window.confirm(
    "仍有未导出结果或正在处理的任务。关闭将停止当前操作，已自动保存的结果可在下次打开时恢复。确定关闭？"
  )) return false;
  try { await flushSave(); }
  catch { if (!window.confirm("自动保存未成功，关闭可能丢失本次结果。仍然关闭？")) return false; }
  stopRequested.value = true;
  await ocrSidecar.stop();
  return true;
}

async function validateTaskPaths(): Promise<void> {
  if (!tasks.value.length || !ocrSidecar.running) return;
  const result = await ocrSidecar.request<{ items: Array<{ id: string; exists: boolean; sourceSize?: number; sourceMtimeNs?: string }> }>("validate_paths", {
    items: tasks.value.map((task) => ({ id: task.id, path: task.path }))
  });
  for (const item of result.items) {
    const task = tasks.value.find((candidate) => candidate.id === item.id);
    if (task) {
      task.missing = !item.exists;
      task.sourceSize = item.sourceSize;
      task.sourceMtimeNs = item.sourceMtimeNs;
    }
  }
}

async function reportPackagedUiReady(): Promise<void> {
  const probe = await ocrSidecar.request<{ enabled: boolean }>("ui_smoke_status");
  if (!probe.enabled) return;
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  await ocrSidecar.request("ui_smoke_ready", { width: innerWidth, height: innerHeight,
    sidebarFits: sidebar ? sidebar.scrollHeight <= sidebar.clientHeight + 2 : false,
    textProcessing: verifyTextProcessingRuntime() });
}

watch(selectedTaskId, () => {
  resultView.value = "text";
});

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (historyOpen.value) {
    if (event.key === "Escape" && !historyBusy.value) { event.preventDefault(); closeHistory(); }
    if (event.key === "Tab") {
      const elements = [...document.querySelectorAll<HTMLElement>('.history-dialog button:not(:disabled), .history-dialog input:not(:disabled)')];
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
  if (event.key === "Escape" && resultFocusMode.value) resultFocusMode.value = false;
}

function toggleResultFocus(): void {
  if (!selectedResult.value) return;
  resultFocusMode.value = !resultFocusMode.value;
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

async function applyPageRange(toChecked = false): Promise<boolean> {
  if (pageValidation) { await pageValidation; if (!toChecked) return !documentSettingsError.value; }
  if (queueRunning.value || setupBusy.value || exportBusy.value || !selectedTask.value || !isPdf.value) return false;
  const targets = toChecked ? tasks.value.filter(task => checkedTaskIds.value.includes(task.id) && isPdfPath(task.path)) : [selectedTask.value];
  if (!targets.length) { documentSettingsError.value = "请先勾选至少一个 PDF。"; return false; }
  const range = pageRangeMode.value === "all" ? "" : pageRangeDraft.value.trim();
  if (pageRangeMode.value === "custom" && !range) { documentSettingsError.value = "请输入页码，例如 1,3-5,8。"; return false; }
  const owner = selectedTaskId.value;
  documentSettingsBusy.value = true;
  documentSettingsError.value = "";
  pageValidation = (async () => {
    try {
      const updates = [];
      for (const task of targets) {
        try {
          const info = await ocrSidecar.request<{ totalPageCount: number; selectedPageCount: number; sourceSize: number; sourceMtimeNs: string }>("document_info", { path: task.path, pageRange: range });
          updates.push({ task, info });
        } catch (error) { throw new Error(`${task.fileName}：${error instanceof Error ? error.message : error}；本次设置未应用。`); }
      }
      for (const { task, info } of updates) {
        if (task.pageRange !== range) task.resumeEligible = false;
        task.pageRange = range;
        task.sourcePageCount = info.totalPageCount;
        task.totalPages = info.selectedPageCount;
        task.sourceSize = info.sourceSize;
        task.sourceMtimeNs = info.sourceMtimeNs;
      }
      status.value = `已设置 ${targets.length} 个 PDF：${range || "全部页"}；已有结果保留。`;
      return true;
    } catch (error) {
      if (owner === selectedTaskId.value) documentSettingsError.value = error instanceof Error ? error.message : String(error);
      return false;
    } finally { documentSettingsBusy.value = false; }
  })();
  try { return await pageValidation; } finally { pageValidation = null; }
}

function rotateImage(delta: number | null, toChecked = false): void {
  if (modelControlsBusy.value || !selectedTask.value || isPdf.value) return;
  const angle = delta === null ? 0 : ((selectedTask.value.rotation ?? 0) + delta + 360) % 360;
  const targets = toChecked ? tasks.value.filter(task => checkedTaskIds.value.includes(task.id) && !isPdfPath(task.path)) : [selectedTask.value];
  for (const task of targets) task.rotation = angle;
  for (const task of targets) task.resumeEligible = false;
  status.value = `已设置 ${targets.length} 张图片的旋转角度为 ${angle}°；不修改原文件，再次识别时生效。`;
}

function requeueSelected(): void {
  const task = selectedTask.value;
  if (!task || modelControlsBusy.value) return;
  task.status = "queued";
  task.error = undefined;
  task.resumeEligible = false;
  if (task.result) {
    recognitionMode.value = task.resultType;
    modelProfile.value = task.result.profile;
  }
  status.value = "已加入等待队列；点击开始批量识别后，将确认替换旧结果。";
}

async function chooseFiles(): Promise<void> {
  const selected = await openLocalDialog({
    multiple: true,
    filters: [
      { name: "图片或 PDF", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "pdf"] }
    ]
  });
  const paths = typeof selected === "string" ? [selected] : selected;
  if (!paths?.length) return;
  addFiles(paths);
}

function addFiles(paths: string[]): void {
  if (setupBusy.value || queueStarting.value || exportBusy.value) return;
  const key = (path: string) => /^[a-z]:[\\/]/i.test(path) ? path.toLowerCase() : path;
  const existing = new Set(tasks.value.map((task) => key(task.path)));
  const batchId = createId();
  const additions: OcrTask[] = [];
  for (const path of naturalSortPaths(paths)) {
    if (!/\.(png|jpe?g|webp|bmp|tiff?|pdf)$/i.test(path) || existing.has(key(path))) continue;
    existing.add(key(path));
    additions.push({
      id: createId(),
      batchId,
      batchIndex: additions.length,
      path,
      fileName: path.split(/[\\/]/).pop() ?? path,
      status: "queued",
      resultType: recognitionMode.value,
      revision: 0,
      pageRange: "",
      rotation: 0
    });
  }
  tasks.value.push(...additions);
  if (additions.length && !selectedTaskId.value) selectedTaskId.value = additions[0].id;
  status.value = additions.length
    ? `已添加 ${additions.length} 个文件，队列共 ${tasks.value.length} 个`
    : "没有新增文件：已在队列中，或格式不是支持的图片/PDF";
}

function removeTask(task: OcrTask): void {
  removeTasks([task.id]);
}

async function removeTasks(ids: string[]): Promise<void> {
  if (queueRunning.value || queueStarting.value || exportBusy.value || historyBusy.value) return;
  historyBusy.value = true;
  const previous = [...tasks.value];
  const selected = selectedTaskId.value;
  try {
    // Commit edits/pages first. A failed save must never clear the queue.
    await flushSave();
    const removed = new Set(ids);
    tasks.value = tasks.value.filter(task => !removed.has(task.id));
    if (!tasks.value.some(task => task.id === selectedTaskId.value)) selectedTaskId.value = tasks.value[0]?.id ?? "";
    await flushSave();
    checkedTaskIds.value = checkedTaskIds.value.filter(id => !removed.has(id));
    feedback.value = "已从队列移除；识别结果保留在“识别历史”中。";
  } catch (error) {
    tasks.value = previous; selectedTaskId.value = selected;
    showError(error);
  } finally { historyBusy.value = false; }
}

function closeHistory(): void {
  historyOpen.value = false;
  void nextTick(() => document.querySelector<HTMLButtonElement>(".history-open-button")?.focus());
}
async function openHistory(): Promise<void> {
  if (modelControlsBusy.value) return;
  historyBusy.value = true;
  try {
    await flushSave();
    historyEntries.value = await listHistory();
    historyError.value = "";
    historySelected.value = []; historyPage.value = 1; historyOpen.value = true;
    await nextTick(); document.querySelector<HTMLInputElement>('.history-dialog input[type="search"]')?.focus();
  } catch (error) { showError(error); }
  finally { historyBusy.value = false; }
}
async function restoreHistoryEntry(id: string): Promise<void> {
  if (historyBusy.value || queueRunning.value) return;
  historyBusy.value = true; historyError.value = "";
  try {
    if (!tasks.value.some(task => task.id === id)) {
      const entry = await readHistory(id);
      tasks.value.push(entry.task);
      for (const page of entry.task.result?.pages ?? []) queuePageSave(id, page);
      textSettings.value = normalizeTextSettings(entry.settings.textSettings);
      mergeCrossPageTables.value = entry.settings.merge;
      exportTextVersion.value = entry.settings.exportTextVersion ?? "formatted";
    }
    selectedTaskId.value = id; exportScope.value = "current";
    await flushSave(); historyOpen.value = false;
    feedback.value = "已打开历史结果，可查看、复制或导出；无需重新识别。";
  } catch (error) { historyError.value = error instanceof Error ? error.message : String(error); showError(error); }
  finally { historyBusy.value = false; }
}
async function permanentlyDeleteHistory(): Promise<void> {
  if (historyBusy.value || !historySelected.value.length) return;
  const selected = historyEntries.value.filter(entry => historySelected.value.includes(entry.task.id));
  const unexported = selected.filter(entry => entry.task.exportedRevision !== (entry.task.revision ?? 0)).length;
  if (!window.confirm(`永久删除 ${selected.length} 个文件的识别结果，其中 ${unexported} 个未导出当前结果。\n此操作不可恢复，原始图片/PDF 不会删除。是否继续？`)) return;
  historyBusy.value = true; historyError.value = "";
  try {
    await flushSave(); await deleteHistory(selected.map(entry => entry.task.id));
    historyEntries.value = await listHistory(); historySelected.value = [];
    historyPage.value = Math.min(historyPage.value, historyPageCount.value);
  } catch (error) { historyError.value = error instanceof Error ? error.message : String(error); showError(error); }
  finally { historyBusy.value = false; }
}

async function chooseAutoExportDirectory(): Promise<void> {
  if (modelControlsBusy.value) return;
  try {
    const directory = await openLocalDialog({ directory: true, multiple: false, title: "选择自动导出文件夹" });
    if (typeof directory === "string") { autoExportDirectory.value = directory; await flushSave(); }
  } catch (error) { showError(error); }
}
async function exportCompletedTask(task: OcrTask, directory = autoExportDirectory.value): Promise<void> {
  if (!task.result) return;
  exportBusy.value = true;
  const revision = task.revision ?? 0;
  try {
    if (!directory || !outputFormats().length) throw new Error("请先选择自动导出目录和格式");
    if (!ocrSidecar.running && !(await startSidecar())) throw new Error("导出进程未就绪，请重试");
    const output = projectText(task.result, textSettings.value, task.textEdited, exportTextVersion.value === "original");
    const tables = displayTables(task.result, mergeCrossPageTables.value);
    const response = await ocrSidecar.request<{count: number; exportedIds: string[]}>("export_results", {
      directory, formats: outputFormats(),
      textItems: [{ id: task.id, fileName: task.fileName, text: output.text, html: output.html, profile: task.result.profile, mode: task.resultType }],
      tableItems: tables.length ? [{ fileName: task.fileName, tables, ids: [task.id], profile: task.result.profile, mode: task.resultType }] : [],
      // Automatic export never overwrites and never waits for other image files.
      options: { grouping: "separate", collision: "rename", prefix: exportPrefix.value, suffix: exportSuffix.value, name: exportName.value }
    }, undefined, null);
    if (!response.count || !response.exportedIds.includes(task.id)) throw new Error("所选格式没有生成文件；无表格时请选择 TXT 或 HTML");
    if (revision === (task.revision ?? 0)) task.exportedRevision = revision;
    task.exportError = undefined; task.exportDirectory = directory; task.exportedAt = new Date().toISOString();
  } catch (error) {
    task.exportError = error instanceof Error ? error.message : String(error);
    if (directory) task.exportDirectory = directory;
    feedback.value = `${task.fileName} 导出失败，识别结果仍保留，可单独重试导出。`;
  } finally { exportBusy.value = false; await flushSave().catch(() => {}); }
}
async function retryTaskExport(task: OcrTask): Promise<void> {
  if (modelControlsBusy.value) return;
  let directory = autoExportDirectory.value || task.exportDirectory;
  if (!directory) {
    try {
      const chosen = await openLocalDialog({directory: true, multiple: false, title: "选择重试导出的文件夹"});
      if (typeof chosen !== "string") return;
      directory = chosen;
    } catch (error) { showError(error); return; }
  }
  await exportCompletedTask(task, directory);
}

function resetBatchIndices(): void {
  const positions = new Map<string, number>();
  for (const item of tasks.value) {
    item.batchIndex = positions.get(item.batchId) ?? 0;
    positions.set(item.batchId, item.batchIndex + 1);
  }
}

function sortTasksNaturally(): void {
  if (modelControlsBusy.value) return;
  tasks.value.sort((left, right) => naturalPathCompare(left.path, right.path));
  resetBatchIndices();
  status.value = "已按文件名自然排序（例如第 2 页排在第 10 页之前）";
}

function selectAllTasks(): void {
  checkedTaskIds.value = checkedTaskIds.value.length === tasks.value.length ? [] : tasks.value.map((task) => task.id);
}

function moveTask(task: OcrTask, direction: number): void {
  if (modelControlsBusy.value) return;
  const index = tasks.value.findIndex((item) => item.id === task.id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= tasks.value.length) return;
  tasks.value.splice(index, 1);
  tasks.value.splice(next, 0, task);
  resetBatchIndices();
}

function retryTasks(selectedOnly = false): void {
  if (modelControlsBusy.value) return;
  for (const task of tasks.value) if (!selectedOnly || checkedTaskIds.value.includes(task.id)) retryTask(task);
}

function clearFinished(): void {
  const removable = new Set<OcrTaskStatus>(["completed", "failed", "cancelled"]);
  removeTasks(tasks.value.filter((task) => removable.has(task.status)).map((task) => task.id));
}

function retryTask(task: OcrTask): void {
  if (task.status !== "failed" && task.status !== "cancelled") return;
  const hasCheckpoint = Boolean(isPdfPath(task.path) && task.result?.pages.length
    && task.result.pageCount < (task.result.selectedPageCount ?? task.result.totalPageCount));
  task.status = "queued";
  task.error = undefined;
  task.currentPage = hasCheckpoint ? task.result?.pageCount : undefined;
  task.totalPages = hasCheckpoint ? task.result?.selectedPageCount ?? task.result?.totalPageCount : undefined;
  task.resumeEligible = hasCheckpoint;
  status.value = task.resumeEligible
    ? `${task.fileName} 已重新加入队列；文件和设置未变化时从已保存的下一页继续`
    : `${task.fileName} 已重新加入队列；将从本次所选的第一页开始`;
}

async function startSidecar(): Promise<boolean> {
  phase.value = "starting";
  status.value = "正在启动本地识别进程，首次启动可能需要等待安全软件扫描……";
  try {
    await ocrSidecar.start();
    sidecarReady.value = true;
    phase.value = "idle";
    status.value = "识别进程已就绪，请选择模型并添加图片、PDF";
    void refreshModelStatus();
    return true;
  } catch (error) {
    sidecarReady.value = false;
    showError(error);
    return false;
  }
}

async function prepareModels(): Promise<boolean> {
  if (queueStarting.value) return false;
  return runModelPreparation();
}

async function runModelPreparation(inQueue = false): Promise<boolean> {
  if ((queueRunning.value && !inQueue) || exportBusy.value || setupBusy.value) return false;
  preparationCancelled.value = false;
  preparationStage.value = "检查缓存与运行环境";
  const changingLoadedModel = ocrSidecar.running
    && preparedProfile.value !== null
    && (preparedProfile.value !== modelProfile.value || preparedMode.value !== recognitionMode.value);
  if (changingLoadedModel) {
    status.value = "正在重启识别进程以安全切换模型……";
    await ocrSidecar.forceStop();
    preparedProfile.value = null;
    preparedMode.value = null;
    sidecarReady.value = false;
  }
  if (!ocrSidecar.running) {
    sidecarReady.value = false;
    if (!(await startSidecar())) return false;
  }

  phase.value = "preparing";
  preparedProfile.value = null;
  preparedMode.value = null;
  const profileLabel = modelProfile.value === "fast" ? "轻量" : "高精度";
  const modeLabel = recognitionMode.value === "table" ? "表格与文字" : "普通文字";
  status.value = `正在准备${modeLabel}模式的${profileLabel}模型，首次运行可能需要下载……`;
  let checking = false;
  let importsFinished = false;
  const poll = setInterval(async () => {
    // Cold imports temporarily occupy the Python command thread. Do not fill its
    // stdin queue with cache queries until it starts the background model worker.
    if (checking || !importsFinished) return;
    checking = true;
    try { await refreshModelStatus(); } finally { checking = false; }
  }, 2000);
  try {
    await ocrSidecar.request(
      "prepare",
      { profile: modelProfile.value, mode: recognitionMode.value, reload: true, localOnly: localModelsOnly.value },
      (event) => {
        if (["imports_ready", "create_pipeline", "model"].includes(event.event)) importsFinished = true;
        preparationStage.value = event.message ?? "正在载入模型";
        updateGlobalStatus(event);
      },
      30 * 60_000
    );
    preparedProfile.value = modelProfile.value;
    preparedMode.value = recognitionMode.value;
    phase.value = "idle";
    status.value = `${modeLabel}模式的${profileLabel}模型已载入；识别期间将禁用 Python 网络连接`;
    await refreshModelStatus();
    return true;
  } catch (error) {
    sidecarReady.value = ocrSidecar.running;
    if (preparationCancelled.value) {
      phase.value = "idle";
      status.value = "模型准备已停止；完整缓存保留，下次可重新准备。";
    } else showError(error);
    return false;
  } finally {
    clearInterval(poll);
  }
}

async function cancelPreparation(): Promise<void> {
  preparationCancelled.value = true;
  if (queueRunning.value) stopRequested.value = true;
  preparationStage.value = "正在停止识别进程；完整缓存保留";
  await ocrSidecar.forceStop();
  sidecarReady.value = false;
  preparedProfile.value = null; preparedMode.value = null;
  phase.value = "idle";
  feedback.value = "模型准备已停止，可重新准备。";
}

function modelChanged(): void {
  if (!modelsReady.value) status.value = "识别设置已切换，开始识别时将准备对应模型";
  void refreshModelStatus();
}

async function transferModels(direction: "export" | "import"): Promise<void> {
  if (modelControlsBusy.value || (direction === "export" && !transferCapabilities.value.length)) return;
  try {
    const directory = await openLocalDialog({ directory: true, title: direction === "export" ? "选择离线模型包保存位置" : "选择包含 model-pack.json 的离线模型文件夹" });
    if (typeof directory !== "string" || modelControlsBusy.value) return;
    if (direction === "import" && !window.confirm("请只导入自己导出或来自可信来源的模型包。校验和用于检查损坏，不是数字签名。验证成功后会替换包中同名模型；其他模型、原文档和识别结果不受影响。继续？")) return;
    if (!ocrSidecar.running && !(await startSidecar())) return;
    modelManagerBusy.value = transferBusy.value = true;
    transferCommitting.value = false;
    transferPercent.value = null;
    transferMessage.value = direction === "export" ? "正在准备并导出模型，首次下载可能较久……" : "正在检查离线模型包……";
    // Native model validation uses separate short-lived processes. Release the
    // main predictor first to avoid holding two server-size models in memory.
    if (preparedProfile.value !== null) {
      await ocrSidecar.forceStop();
      preparedProfile.value = preparedMode.value = null;
      sidecarReady.value = false;
      await ocrSidecar.start();
      sidecarReady.value = true;
    }
    const result = await ocrSidecar.request<{ cancelled?: boolean; message?: string; path: string; modelCount: number; capabilities: Array<{ profile: ModelProfile; mode: RecognitionMode }> }>(
      direction === "export" ? "export_model_pack" : "import_model_pack",
      { directory, capabilities: transferCapabilities.value.map(value => { const [profile, mode] = value.split(":"); return { profile, mode }; }) },
      event => {
        transferMessage.value = event.message ?? transferMessage.value;
        transferPercent.value = event.event === "transfer" && event.pageCount ? Math.min(100, Math.round((event.page ?? 0) / event.pageCount * 100)) : null;
        transferCommitting.value = event.event === "commit";
        preparationStage.value = event.message ?? "正在载入模型";
        updateGlobalStatus(event);
      }, null);
    if (result.cancelled) transferMessage.value = result.message ?? "模型迁移已取消";
    else if (direction === "export") transferMessage.value = `已导出 ${result.modelCount} 个模型：${result.path}。请将整个文件夹和对应系统的软件安装包一并复制过去。`;
    else {
      localModelsOnly.value = true;
      if (result.capabilities?.length) {
        modelProfile.value = result.capabilities[0].profile;
        recognitionMode.value = result.capabilities[0].mode;
      }
      transferMessage.value = `已导入并通过本地试识别，共 ${result.modelCount} 个模型。已开启“仅使用本地模型”，可以拔出 U 盘；点击准备当前模型即可使用。`;
    }
    status.value = transferMessage.value;
    phase.value = "idle";
  } catch (error) {
    transferMessage.value = error instanceof Error ? error.message : String(error);
    showError(error);
  } finally {
    modelManagerBusy.value = transferBusy.value = false;
    transferCommitting.value = false;
    await refreshModelStatus();
  }
}

async function cancelModelTransfer(): Promise<void> {
  if (!transferBusy.value || transferCommitting.value) return;
  try {
    await ocrSidecar.request("cancel_model_transfer");
    transferMessage.value = "正在取消并清理临时文件，请稍候……";
  } catch (error) { showError(error); }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

async function refreshModelStatus(): Promise<void> {
  if (!ocrSidecar.running) {
    modelCache.value = null;
    return;
  }
  try {
    modelCache.value = await ocrSidecar.request<ModelCacheStatus>(
      "model_status",
      { profile: modelProfile.value, mode: recognitionMode.value },
      undefined,
      30_000
    );
  } catch (error) {
    console.warn("读取模型缓存状态失败", error);
  }
}

async function deleteCurrentModels(): Promise<void> {
  if (modelControlsBusy.value) return;
  const label = recognitionMode.value === "table" ? "当前表格与文字模型" : "当前文字模型";
  const modelCount = modelCache.value?.modelCount ?? 0;
  if (!window.confirm(`确定删除${label}的本地缓存吗？这会删除当前组合涉及的 ${modelCount} 个模型目录；原文档和识别结果不受影响。下次准备模型时需要重新联网下载。`)) return;
  modelManagerBusy.value = true;
  try {
    const result = await ocrSidecar.request<{ removed: string[]; freedBytes: number; status: ModelCacheStatus }>(
      "delete_models",
      { profile: modelProfile.value, mode: recognitionMode.value },
      undefined,
      2 * 60_000
    );
    preparedProfile.value = null;
    preparedMode.value = null;
    modelCache.value = result.status;
    status.value = result.removed.length
      ? `已删除 ${result.removed.length} 个模型目录，释放 ${formatBytes(result.freedBytes)}`
      : "当前模型没有可删除的本地缓存";
  } catch (error) {
    showError(error);
  } finally {
    modelManagerBusy.value = false;
  }
}

async function copyDiagnostics(): Promise<void> {
  let remote: Partial<DiagnosticInfo> = {};
  if (ocrSidecar.running) {
    try {
      remote = await ocrSidecar.request<Partial<DiagnosticInfo>>("diagnostics", {}, undefined, 30_000);
    } catch (error) {
      console.warn("读取 sidecar 诊断信息失败", error);
    }
  }
  let runtimeCheck = false;
  try { runtimeCheck = verifyTextProcessingRuntime(); } catch { /* report failure without document contents */ }
  const diagnostics: DiagnosticInfo = {
    appVersion: "0.14.3",
    sidecarRunning: ocrSidecar.running,
    sidecarStderr: ocrSidecar.stderr ? "运行日志已省略，以免复制文档路径或识别相关输出" : "",
    ...remote,
    textProcessing: { runtimeCheck, webkitGtk40Build: isWebkitGtk40Build,
      textMode: textSettings.value.textMode, rawView: rawTextView.value,
      edited: selectedTask.value?.textEdited === true,
      resultType: selectedResult.value?.resultType ?? "none",
      pageCount: selectedResult.value?.pages.length ?? 0,
      layoutPageCount: selectedResult.value?.pages.filter(p => p.schemaVersion && p.blocks.length && !p.tables.length).length ?? 0 }
  };
  await copyText(JSON.stringify(diagnostics, null, 2), "诊断信息");
}

async function openLogs(): Promise<void> {
  try {
    if (!ocrSidecar.running && !(await startSidecar())) return;
    await ocrSidecar.request("open_logs");
  } catch (error) { showError(error); }
}

async function exportDiagnostics(): Promise<void> {
  const directory = await openLocalDialog({ directory: true, title: "选择诊断包保存目录" });
  if (typeof directory !== "string") return;
  try {
    if (!ocrSidecar.running && !(await startSidecar())) return;
    const result = await ocrSidecar.request<{ path: string }>("export_diagnostics", { directory });
    status.value = `诊断包已保存：${result.path}（不含文档内容、识别文字和私人路径）`;
  } catch (error) { showError(error); }
}

async function restartSidecar(): Promise<void> {
  if (modelControlsBusy.value) return;
  await ocrSidecar.forceStop();
  preparedProfile.value = null;
  preparedMode.value = null;
  if (await startSidecar()) status.value = "识别进程已重启，原结果与等待队列保留；点击开始可继续，失败项可批量重试。";
}

function updateGlobalStatus(event: SidecarEvent): void {
  if (event.message) status.value = event.message;
}

function updateTaskStatus(task: OcrTask, event: SidecarEvent): void {
  if (event.page !== undefined) {
    if (event.event === "source_page") task.sourcePage = event.page;
    else task.currentPage = event.page;
  }
  if (event.pageCount !== undefined) task.totalPages = event.pageCount;
  if (event.event === "paused") {
    task.status = "paused";
    queuePaused.value = true;
    if (queueTransition.value !== "cancelling") queueTransition.value = "";
    phase.value = "paused";
  } else if (event.event === "resumed") {
    task.status = "running";
    queuePaused.value = false;
    if (queueTransition.value !== "cancelling") queueTransition.value = "";
    phase.value = "recognizing";
  }
  if (event.message) status.value = `${task.fileName}：${event.message}`;
}

async function runQueue(): Promise<void> {
  if (queueRunning.value || queueStarting.value || setupBusy.value || exportBusy.value || !queuedCount.value) return;
  if (!ocrSidecar.running && !(await startSidecar())) return;
  if (pageValidation) await pageValidation;
  if (isPdf.value && !(await applyPageRange())) { feedback.value = "请先修正当前 PDF 的页码设置。"; return; }
  if (modelControlsBusy.value) return;
  if (autoExport.value && (!autoExportDirectory.value || !outputFormats().length)) {
    feedback.value = "启用自动导出后，请先选择导出目录和至少一种格式。"; return;
  }
  if (autoExport.value && recognitionMode.value === "text" && !exportTxt.value && !exportHtml.value) {
    feedback.value = "普通文字无法生成 XLSX，请为自动导出选择 TXT 或 HTML。"; return;
  }
  if (tasks.value.some(task => task.status === "queued" && task.result && !task.resumeEligible)
    && !window.confirm("等待任务中已有识别结果（可能包含手动校对）。重新识别将替换这些结果，是否继续？")) return;
  queueStarting.value = true;
  try {
    if (!ocrSidecar.running && !(await startSidecar())) return;
    if (autoExport.value) await ocrSidecar.request("export_preview", {
      directory: autoExportDirectory.value, formats: outputFormats(), textItems: [], tableItems: [],
      options: { grouping: "separate", collision: "rename" }
    });
    await validateTaskPaths();
    for (const task of tasks.value) if (task.status === "queued" && task.missing) {
      task.status = "failed";
      task.error = "原文件已移动、删除或当前不可访问；已保存的识别结果仍可导出。请恢复原路径后重试，或移除并重新添加文件。";
    }
    if (!queuedCount.value) { status.value = "等待任务的原文件均不可访问，请检查文件路径。"; return; }
    for (const task of tasks.value.filter(item => item.status === "queued" && isPdfPath(item.path))) {
      try {
        const info = await ocrSidecar.request<{ totalPageCount: number; selectedPageCount: number; sourceSize: number; sourceMtimeNs: string }>("document_info", { path: task.path, pageRange: task.pageRange ?? "" });
        task.sourcePageCount = info.totalPageCount;
        task.totalPages = info.selectedPageCount;
        task.sourceSize = info.sourceSize;
        task.sourceMtimeNs = info.sourceMtimeNs;
      } catch (error) {
        task.status = "failed";
        task.error = error instanceof Error ? error.message : String(error);
      }
    }
    if (!queuedCount.value) { status.value = "PDF 页码或文件检查未通过，请选择失败任务查看原因并调整。"; return; }
    const first = tasks.value.find(task => task.status === "queued");
    const canExtractFirst = first && isPdfPath(first.path) && recognitionMode.value === "text" && textSettings.value.pdfSource === "auto";
    if (!canExtractFirst && !modelsReady.value && !(await runModelPreparation())) return;
  } catch (error) {
    showError(error);
    return;
  } finally {
    queueStarting.value = false;
  }

  queueRunning.value = true;
  queuePaused.value = false;
  queueTransition.value = "";
  stopRequested.value = false;
  phase.value = "recognizing";

  try {
    while (!stopRequested.value) {
      const task = tasks.value.find((item) => item.status === "queued");
      if (!task) break;
      task.status = "running";
      task.resultType = recognitionMode.value;
      task.error = undefined;
      task.exportError = undefined;
      const previousResult = task.result;
      const previousTextEdited = task.textEdited;
      const resume = isPdfPath(task.path) && task.resumeEligible === true && canResumeResult(previousResult, {
        profile: modelProfile.value, mode: recognitionMode.value, threshold: scoreThreshold.value,
        pageRange: task.pageRange ?? "", rotation: task.rotation ?? 0,
        sourceSize: task.sourceSize, sourceMtimeNs: task.sourceMtimeNs,
        pdfSource: textSettings.value.pdfSource, rubyEnabled: textSettings.value.rubyEnabled
      });
      let liveResult = resume ? beginStreamingResult({
        path: task.path, profile: modelProfile.value, mode: recognitionMode.value, threshold: scoreThreshold.value,
        totalPageCount: task.sourcePageCount ?? previousResult?.totalPageCount ?? 0,
        selectedPageCount: task.totalPages ?? previousResult?.selectedPageCount ?? 0,
        pageRange: task.pageRange ?? "", rotation: task.rotation ?? 0,
        sourceSize: task.sourceSize, sourceMtimeNs: task.sourceMtimeNs,
        previous: previousResult, keepEditedText: previousTextEdited,
        pdfSource: textSettings.value.pdfSource, rubyEnabled: textSettings.value.rubyEnabled
      }) : undefined;
      task.result = liveResult;
      if (task.result) liveResult = task.result;
      task.textEdited = resume ? previousTextEdited : false;
      task.currentPage = liveResult?.pages.length ?? 0;
      task.sourcePage = undefined;
      activeTaskId = task.id;
      skipRequestedTaskId = "";
      let resetQueued = false;
      const completedPages = liveResult?.pages.map((page) => Number(page.pageIndex)) ?? [];
      status.value = `正在识别 ${tasks.value.indexOf(task) + 1}/${tasks.value.length}：${task.fileName}`;
      if (resume) status.value += `（从 ${completedPages.length}/${task.totalPages ?? completedPages.length} 页继续）`;

      try {
        const result = await ocrSidecar.request<OcrResult>(
          "recognize",
          { path: task.path, profile: modelProfile.value, scoreThreshold: scoreThreshold.value, mode: recognitionMode.value,
            pageRange: task.pageRange ?? "", rotation: task.rotation ?? 0, completedPages,
            pdfSource: textSettings.value.pdfSource, rubyEnabled: textSettings.value.rubyEnabled },
          (event) => {
            updateTaskStatus(task, event);
            if (event.pageResult) {
              const positions = selectedTaskId.value === task.id
                ? Array.from(document.querySelectorAll<HTMLElement>(".result-body textarea, .ruby-text-preview")).map(element => ({ element,
                  top: element.scrollTop, left: element.scrollLeft,
                  start: element instanceof HTMLTextAreaElement ? element.selectionStart : null,
                  end: element instanceof HTMLTextAreaElement ? element.selectionEnd : null })) : [];
              if (!liveResult) {
                resetSavedPages(task.id);
                resetQueued = true;
                liveResult = beginStreamingResult({
                  path: task.path, profile: modelProfile.value, mode: recognitionMode.value, threshold: scoreThreshold.value,
                  totalPageCount: task.sourcePageCount ?? event.pageCount ?? 0,
                  selectedPageCount: event.pageCount ?? 0, pageRange: task.pageRange ?? "", rotation: task.rotation ?? 0,
                  sourceSize: task.sourceSize, sourceMtimeNs: task.sourceMtimeNs,
                  pdfSource: textSettings.value.pdfSource, rubyEnabled: textSettings.value.rubyEnabled
                });
                task.result = liveResult;
                liveResult = task.result;
              }
              if (appendResultPage(liveResult, event.pageResult, task.textEdited === true)) {
                liveResult.elapsedMs = (resume ? previousResult?.elapsedMs ?? 0 : 0) + (event.elapsedMs ?? 0);
                queuePageSave(task.id, event.pageResult);
                task.revision = (task.revision ?? 0) + 1;
              }
              if (positions.length) void nextTick(() => {
                if (selectedTaskId.value !== task.id) return;
                for (const position of positions) {
                  if (!position.element.isConnected) continue;
                  if (position.element instanceof HTMLTextAreaElement && position.start !== null) position.element.setSelectionRange(position.start, position.end);
                  position.element.scrollTop = position.top; position.element.scrollLeft = position.left;
                }
              });
            }
          },
          null
        );
        status.value = `${task.fileName}：正在整理文本……`;
        await nextTick();
        if (liveResult) {
          task.result = completeStreamingResult(liveResult, result.cancelled,
            (resume ? previousResult?.elapsedMs ?? 0 : 0) + result.elapsedMs);
          task.result.sourceSize = result.sourceSize ?? task.result.sourceSize;
          task.result.sourceMtimeNs = result.sourceMtimeNs ?? task.result.sourceMtimeNs;
        } else if (result.pageCount) {
          resetSavedPages(task.id);
          resetQueued = true;
          task.result = finalizeResult(result, result.pages, false);
          for (const page of task.result.pages) queuePageSave(task.id, page);
        } else if (previousResult) {
          task.result = previousResult;
          task.textEdited = previousTextEdited;
        } else task.result = finalizeResult(result, result.pages, false);
        task.revision = (task.revision ?? 0) + 1;
        task.currentPage = task.result.pageCount;
        task.totalPages = result.selectedPageCount ?? result.totalPageCount;
        task.status = result.cancelled ? "cancelled" : "completed";
        task.resumeEligible = Boolean(result.cancelled && isPdfPath(task.path)
          && task.result.pageCount < (task.result.selectedPageCount ?? task.result.totalPageCount));
        if (skipRequestedTaskId === task.id) task.error = "已跳过此文件；已完成页面的部分结果已保留";
      } catch (error) {
        if (error instanceof SidecarRequestError && error.category === "model_required" && !stopRequested.value) {
          if (!liveResult?.pages.length && previousResult) { task.result = previousResult; task.textEdited = previousTextEdited; }
          task.resumeEligible = Boolean(liveResult?.pages.length);
          await flushSave().catch(() => {});
          status.value = `${task.fileName}：后续页面需要 OCR 模型，已完成页保留。`;
          if (await runModelPreparation(true)) {
            task.status = "queued";
            phase.value = "recognizing";
            activeTaskId = "";
            continue;
          }
          task.status = preparationCancelled.value ? "cancelled" : "failed";
          task.error = preparationCancelled.value ? "已停止准备模型；已完成页面保留" : status.value;
          stopRequested.value = true;
          break;
        }
        if (!liveResult?.pages.length && previousResult) {
          task.result = previousResult;
          task.textEdited = previousTextEdited;
          if (resetQueued) for (const page of previousResult.pages) queuePageSave(task.id, page);
        }
        task.resumeEligible = Boolean(isPdfPath(task.path) && task.result?.pages.length
          && task.result.pageCount < (task.result.selectedPageCount ?? task.result.totalPageCount));
        task.status = stopRequested.value ? "cancelled" : "failed";
        task.error = error instanceof Error ? error.message : String(error);
        if (!ocrSidecar.running) {
          sidecarReady.value = false;
          preparedProfile.value = null;
          preparedMode.value = null;
          throw error;
        }
      }
      // Persist recognition independently: export failure cannot turn a
      // completed OCR task into a failed recognition task.
      try { await flushSave(); }
      catch { stopRequested.value = true; feedback.value = "保存结果失败，队列已停止。请先导出已有结果并检查磁盘空间。"; break; }
      if (autoExport.value && task.status === "completed") await exportCompletedTask(task);
      activeTaskId = "";

      if (String(queueTransition.value) === "pausing") queuePaused.value = true;
      if (queuePaused.value) break;
    }

    if (stopRequested.value) {
      status.value = "批量识别已取消；已完成和部分完成的结果仍然保留";
    } else if (queuePaused.value) {
      status.value = "队列已暂停";
    } else {
      status.value = `队列处理完成：识别成功 ${completedCount.value} 个，共 ${tasks.value.length} 个；导出失败 ${tasks.value.filter(task => task.exportError).length} 个。结果已保留，可从识别历史重新打开。`;
    }
  } catch (error) {
    showError(error);
  } finally {
    activeTaskId = "";
    queueRunning.value = false;
    queueTransition.value = "";
    if (String(phase.value) !== "error") phase.value = queuePaused.value ? "paused" : "idle";
    await flushSave().catch(() => {});
  }
}

async function skipCurrentTask(): Promise<void> {
  if (!queueRunning.value || !activeTaskId) return;
  skipRequestedTaskId = activeTaskId;
  queuePaused.value = false;
  phase.value = "recognizing";
  status.value = "将在当前页结束后跳过本文件，并继续下一项……";
  try { await ocrSidecar.request("cancel", {}, undefined, 10_000); }
  catch (error) { showError(error); }
}

async function pauseQueue(): Promise<void> {
  if (!queueRunning.value || queueTransition.value) return;
  queueTransition.value = "pausing";
  status.value = "正在请求暂停，将在当前页完成后暂停……";
  try {
    await ocrSidecar.request("pause", {}, undefined, 10_000);
  } catch (error) {
    showError(error);
  }
}

async function resumeQueue(): Promise<void> {
  if (!queuePaused.value || queueTransition.value) return;
  queueTransition.value = "resuming";
  const pausedTask = tasks.value.find((task) => task.status === "paused");
  if (pausedTask && queueRunning.value) {
    pausedTask.status = "running";
    phase.value = "recognizing";
    status.value = `继续识别 ${pausedTask.fileName}……`;
    try {
      await ocrSidecar.request("resume", {}, undefined, 10_000);
    } catch (error) {
      showError(error);
    }
  } else {
    queuePaused.value = false;
    queueTransition.value = "";
    void runQueue();
  }
}

async function cancelQueue(): Promise<void> {
  queueTransition.value = "cancelling";
  stopRequested.value = true;
  queuePaused.value = false;
  for (const task of tasks.value) {
    if (task.status === "queued") task.status = "cancelled";
  }
  status.value = "正在取消，将在当前页完成后停止……";
  if (queueRunning.value) {
    try {
      await ocrSidecar.request("cancel", {}, undefined, 10_000);
    } catch (error) {
      showError(error);
    }
  }
}

async function forceStopQueue(): Promise<void> {
  stopRequested.value = true;
  queuePaused.value = false;
  for (const task of tasks.value) {
    if (task.status === "running" || task.status === "paused" || task.status === "queued") task.status = "cancelled";
  }
  await ocrSidecar.forceStop();
  sidecarReady.value = false;
  preparedProfile.value = null;
  preparedMode.value = null;
  status.value = "识别进程已强制停止；下次识别会重新启动并载入模型";
  phase.value = "idle";
}

interface TableExportItem {
  fileName: string;
  tables: OcrTable[];
  ids: string[];
  profile: ModelProfile;
  mode: RecognitionMode;
}

function imageBatchExportName(task: OcrTask): string {
  const stem = task.fileName.replace(/\.[^.]+$/, "") || "批量图片";
  return `${stem}-批量图片.pdf`;
}

function tableExportItems(): TableExportItem[] {
  const items: TableExportItem[] = [];
  const emittedImageBatches = new Set<string>();
  for (const task of tableTasks.value) {
    if (isPdfPath(task.path)) {
      items.push({
        fileName: task.fileName,
        tables: displayTables(task.result ?? null, mergeCrossPageTables.value),
        ids: [task.id], profile: task.result!.profile, mode: task.resultType
      });
      continue;
    }
    if (emittedImageBatches.has(task.batchId)) continue;
    emittedImageBatches.add(task.batchId);
    const batchTasks = tasks.value
      .filter((item) => item.batchId === task.batchId && !isPdfPath(item.path))
      .sort((left, right) => left.batchIndex - right.batchIndex);
    const included = new Set(exportableTasks.value.map(item => item.id));
    const tables = batchTasks.length > 1
      ? imageBatchTables(batchTasks.map((item) => included.has(item.id) ? item.result ?? null : null), mergeCrossPageTables.value)
      : displayTables(task.result ?? null, mergeCrossPageTables.value);
    if (tables.length) {
      items.push({
        fileName: batchTasks.filter(item => included.has(item.id)).length > 1 ? imageBatchExportName(batchTasks.find(item => included.has(item.id))!) : task.fileName,
        tables,
        ids: batchTasks.filter((item) => included.has(item.id) && (item.result?.rawTableCount ?? 0) > 0).map((item) => item.id),
        profile: task.result!.profile, mode: task.resultType
      });
    }
  }
  return items;
}

async function exportSelectedFormats(): Promise<void> {
  if (!canExportSelectedFormats.value) return;
  exportBusy.value = true;
  const attemptedTasks = [...exportableTasks.value];
  let attemptedDirectory = "";
  let attemptedWrite = false;
  try {
    const directory = await openLocalDialog({ directory: true, multiple: false, title: "选择导出文件夹" });
    if (typeof directory !== "string") return;
    if (!ocrSidecar.running && !(await startSidecar())) return;
    const revisions = new Map(exportableTasks.value.map((task) => [task.id, task.revision ?? 0]));
    const payload = JSON.parse(JSON.stringify({
      directory, formats: outputFormats(),
      textItems: exportableTasks.value.map((task) => {
        const output = projectText(task.result!, textSettings.value, task.textEdited, exportTextVersion.value === "original");
        return { id: task.id, fileName: task.fileName, text: output.text, html: output.html,
          profile: task.result?.profile, mode: task.resultType };
      }),
      tableItems: tableExportItems(),
      options: { grouping: exportGrouping.value, collision: exportCollision.value,
        prefix: exportPrefix.value, suffix: exportSuffix.value, name: exportName.value }
    }));
    const preview = await ocrSidecar.request<{ count: number; skipped: number; overwrites: number; noTableCount: number;
      files: Array<{ name: string; action: string }> }>("export_preview", payload);
    if (!preview.count) { status.value = `没有需要写入的文件（同名跳过 ${preview.skipped} 个）；未识别到表格的任务不会生成 XLSX。`; return; }
    const filenames = preview.files.filter((file) => file.action !== "skip").slice(0, 12).map((file) => file.name).join("\n");
    if (!window.confirm(`导出范围：${exportScopeLabel.value}（${exportableTasks.value.length} 个任务，包含部分完成结果）\n文本版本：${exportTextVersion.value === "original" ? "整理前" : "整理后（保留手动校对）"}\n格式：${outputFormats().join("、")}\n表格：${mergeCrossPageTables.value ? "合并连续页" : "按页拆分"}\n\n将生成 ${preview.count} 个文件，覆盖 ${preview.overwrites} 个，跳过 ${preview.skipped} 个。\n${preview.noTableCount} 个任务没有表格，不会生成 XLSX；文字模式支持 HTML。\n\n${filenames}${preview.count > 12 ? "\n……" : ""}\n\n是否导出？`)) return;
    attemptedDirectory = directory; attemptedWrite = true;
    const response = await ocrSidecar.request<{ count: number; skipped: number; exportedIds: string[]; fullyExportedIds?: string[] }>(
      "export_results", payload, undefined, null
    );
    for (const task of tasks.value) if ((response.fullyExportedIds ?? response.exportedIds).includes(task.id) && revisions.get(task.id) === (task.revision ?? 0)) {
      task.exportedRevision = task.revision ?? 0;
      task.exportError = undefined; task.exportDirectory = directory; task.exportedAt = new Date().toISOString();
    }
    feedback.value = `已导出 ${response.count} 个文件：${directory}`;
    status.value = `已导出 ${response.count} 个文件，跳过 ${response.skipped} 个；位置：${directory}`;
    await flushSave().catch(() => {});
  } catch (error) {
    if (attemptedWrite) for (const task of attemptedTasks) {
      task.exportError = error instanceof Error ? error.message : String(error);
      task.exportDirectory = attemptedDirectory;
    }
    await flushSave().catch(() => {});
    showError(error);
  } finally {
    exportBusy.value = false;
  }
}

async function copyText(value: string, label = "识别文本"): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    feedback.value = `${label}已复制`;
    status.value = `${fileName.value} 的${label}已复制到剪贴板`;
  } catch { feedback.value = "复制失败，请选中文本后使用系统复制操作。"; }
}

async function copyCurrentResult(): Promise<void> {
  if (!selectedResult.value) return;
  if (resultView.value === "tables") {
    if (!selectedTables.value.length) return;
    const tsv = selectedTables.value.map(tableToTsv).filter(Boolean).join("\n\n");
    await copyText(tsv, `${selectedTables.value.length} 个表格（TSV）`);
    return;
  }
  await copyText(textProjection.value.text);
}

function updateSelectedText(event: Event): void {
  if (selectedTask.value?.result) {
    selectedTask.value.result.text = (event.target as HTMLTextAreaElement).value;
    selectedTask.value.result.editedPageCount = selectedTask.value.result.pages.length;
    selectedTask.value.textEdited = true;
    selectedTask.value.revision = (selectedTask.value.revision ?? 0) + 1;
  }
}

function discardTextEdits(): void {
  const task = selectedTask.value;
  if (!task?.result || !window.confirm("放弃当前手工校对内容，恢复由原始识别数据生成的文本？")) return;
  task.textEdited = false;
  task.result.editedPageCount = undefined;
  task.result.text = task.result.pages.map(p=>p.text).join("\n\n");
  task.revision = (task.revision ?? 0) + 1;
}

function showError(error: unknown): void {
  queueTransition.value = "";
  feedback.value = error instanceof Error ? error.message : String(error);
  phase.value = "error";
  errorSummary.value = error instanceof Error ? error.message : String(error);
  errorDetails.value = error instanceof SidecarRequestError
    ? error.details
    : error instanceof Error
      ? error.stack ?? ""
      : "";
  const help: Record<string, string> = {
    download: "模型下载失败：请检查网络；如缓存异常，可删除当前模型缓存后重新准备。",
    model: localModelsOnly.value ? "请导入所需的本地模型；当前不会联网补下载。" : "模型无法载入：可从可信离线包导入，或删除对应缓存后重新准备。",
    runtime: "原生运行库错误：请保留版本与平台信息，并导出诊断包。",
    file: "原文件不可访问：请检查是否移动、删除或没有读取权限。",
    storage: "本机文件操作失败：请检查剩余磁盘空间与目录权限。"
  };
  status.value = `${error instanceof SidecarRequestError ? help[error.category] ?? "" : ""} ${errorSummary.value}`.trim();
}
</script>

<template>
  <main :class="['app-shell', { 'result-focus-mode': resultFocusMode }]">
    <header class="topbar">
      <div><p class="eyebrow">LOCAL DOCUMENT TOOL</p><h1>本地 OCR</h1></div>
      <div class="header-actions">
        <span v-if="isWebkitGtk40Build" class="compat-badge">WebKitGTK 4.0 兼容版</span>
        <span v-if="tasks.length" class="queue-summary">完成 {{ completedCount }} / {{ tasks.length }}</span>
        <div :class="['save-badge', { error: saveFailed }]" :title="saveStatus"><span></span>{{ saveBadgeLabel }}</div>
        <div class="privacy-badge"><span></span>文档仅在本机处理</div>
      </div>
    </header>

    <section class="workspace">
      <aside class="sidebar">
        <div class="step-card">
          <div class="step-heading"><b>01</b><span>选择识别方式</span></div>
          <div class="mode-options">
            <label title="输出连续文本与文字框" :class="{ selected: recognitionMode === 'text' }">
              <input v-model="recognitionMode" type="radio" value="text" :disabled="modelControlsBusy" @change="modelChanged" />
              <span><strong>普通文字</strong><small>输出连续文本与文字框</small></span>
            </label>
            <label title="恢复行列和合并单元格，可导出 XLSX" :class="{ selected: recognitionMode === 'table' }">
              <input v-model="recognitionMode" type="radio" value="table" :disabled="modelControlsBusy" @change="modelChanged" />
              <span><strong>表格与文字</strong><small>恢复行列和合并单元格，可导出 XLSX</small></span>
            </label>
          </div>
          <p class="option-caption">文字模型档位</p>
          <div class="model-options">
            <label title="轻量模型，适合批量普通文档" :class="{ selected: modelProfile === 'fast' }">
              <input v-model="modelProfile" type="radio" value="fast" :disabled="modelControlsBusy" @change="modelChanged" />
              <span><strong>快速</strong><small>轻量模型，适合批量普通文档</small></span>
            </label>
            <label title="更大更慢，适合小字和复杂背景" :class="{ selected: modelProfile === 'accurate' }">
              <input v-model="modelProfile" type="radio" value="accurate" :disabled="modelControlsBusy" @change="modelChanged" />
              <span><strong>高精度</strong><small>更大更慢，适合小字和复杂背景</small></span>
            </label>
          </div>
          <p v-if="phase === 'error' && !sidecarReady" class="error-help">识别进程没有启动，请重试并保留底部错误。</p>
          <button class="secondary-button" :disabled="modelControlsBusy" @click="prepareModels">
            {{ !sidecarReady ? "启动并准备模型" : modelsReady ? "重新载入当前模型" : "准备当前模型" }}
          </button>
          <div v-if="phase === 'preparing'" class="model-progress">
            <progress aria-label="正在下载或载入模型"></progress>
            <small>{{ preparationStage }}</small><button class="secondary-button" :disabled="preparationCancelled" @click="cancelPreparation">停止准备模型</button>
            <small>正在下载或载入；已缓存 {{ formatBytes(modelCache?.sizeBytes ?? 0) }}。下载源未提供总量时不显示百分比。</small>
          </div>
          <p v-if="phase === 'error' && sidecarReady && errorSummary" class="error-help" role="alert">{{ errorSummary }}</p>
          <div class="model-managers">
          <details class="model-manager">
            <summary>模型管理</summary>
            <div v-if="modelCache" class="model-status-card">
              <div><span>当前组合</span><strong>{{ modelCache.installed ? "必要文件已齐全" : `${modelCache.installedCount}/${modelCache.modelCount} 个模型完整` }}</strong></div>
              <div><span>占用空间</span><strong>{{ formatBytes(modelCache.sizeBytes) }}</strong></div>
              <p class="model-path" :title="modelCache.cacheRoot">{{ modelCache.cacheRoot }}</p>
              <ul>
                <li v-for="model in modelCache.models" :key="model.name">
                  <span class="model-name" :title="model.name">{{ model.name }}</span>
                  <small class="model-state">{{ model.state === "ready" ? "就绪" : model.state === "incomplete" ? "不完整" : "未下载" }}</small>
                  <small class="model-size">{{ model.sizeBytes ? formatBytes(model.sizeBytes) : "—" }}</small>
                </li>
              </ul>
            </div>
            <p v-else class="model-status-empty">启动识别进程后可查看模型状态。</p>
            <div class="model-actions model-cache-actions">
              <button :disabled="!sidecarReady || modelManagerBusy" @click="refreshModelStatus">刷新</button>
              <button class="delete-model" :disabled="!modelCache?.sizeBytes || modelControlsBusy" @click="deleteCurrentModels">删除当前模型缓存</button>
            </div>
            <details class="offline-manager">
              <summary>在离线电脑上使用</summary>
              <p>联网电脑：选择需要的能力，准备并导出模型文件夹；连同对应系统的软件安装包复制过去。</p>
              <div class="offline-capabilities">
                <label><input v-model="transferCapabilities" type="checkbox" value="fast:text" :disabled="modelControlsBusy" />轻量文字</label>
                <label><input v-model="transferCapabilities" type="checkbox" value="accurate:text" :disabled="modelControlsBusy" />高精度文字</label>
                <label><input v-model="transferCapabilities" type="checkbox" value="fast:table" :disabled="modelControlsBusy" />表格＋轻量文字</label>
                <label><input v-model="transferCapabilities" type="checkbox" value="accurate:table" :disabled="modelControlsBusy" />表格＋高精度文字</label>
              </div>
              <div class="model-actions model-cache-actions">
                <button :disabled="modelControlsBusy || !transferCapabilities.length" @click="transferModels('export')">准备并导出模型</button>
                <button :disabled="modelControlsBusy" @click="transferModels('import')">从本地导入模型</button>
              </div>
              <p>离线电脑：导入整个 LocalOCR-models 文件夹。校验、试识别通过后可拔出 U 盘；仅导入可信来源的模型。</p>
              <label class="local-only-setting"><input v-model="localModelsOnly" type="checkbox" :disabled="modelControlsBusy" />仅使用本地模型（不补下载）</label>
              <p v-if="transferMessage" class="transfer-message" role="status">{{ transferMessage }}</p>
              <progress v-if="transferBusy" class="transfer-progress" :value="transferPercent ?? undefined" max="100"></progress>
              <button v-if="transferBusy" class="text-button" :disabled="transferCommitting" @click="cancelModelTransfer">{{ transferCommitting ? "正在提交，请稍候" : "取消模型迁移" }}</button>
              <p class="offline-runtime-note">Windows 若无法打开且提示缺少 WebView2，请另行携带微软的 x64 完整离线安装包（Evergreen Standalone Installer）。Linux 仍需选择匹配系统的兼容版本。</p>
            </details>
          </details>
          <details class="model-manager maintenance-manager">
            <summary>维护与自动保存</summary>
            <p :class="['save-notice', { 'save-error': saveFailed }]">{{ saveStatus }}</p>
            <p class="save-notice">保存本机路径和识别结果，不复制原文档；结果未加密，不会放入诊断包。</p>
            <div class="model-actions">
              <button :disabled="modelControlsBusy" @click="restartSidecar">重启识别进程</button>
              <button :disabled="setupBusy" @click="openLogs">打开日志目录</button>
              <button :disabled="setupBusy" @click="exportDiagnostics">导出诊断包</button>
            </div>
          </details>
          </div>
        </div>

        <div class="step-card queue-card">
          <div class="step-heading"><b>02</b><span>批量任务</span><button class="history-open-button" :disabled="modelControlsBusy" @click="openHistory">识别历史</button></div>
          <button class="file-picker" :disabled="setupBusy || queueStarting || exportBusy" @click="chooseFiles"><span class="plus">＋</span><span>添加图片或 PDF</span></button>
          <div v-if="tasks.length" class="queue-toolbar"><span>{{ queuedCount }} 等待 · {{ checkedTaskIds.length }} 勾选</span><button :disabled="modelControlsBusy" @click="clearFinished">清理已结束（保留历史）</button></div>
          <div v-if="tasks.length" class="batch-actions">
            <button @click="selectAllTasks">全选 / 取消</button>
            <button :disabled="modelControlsBusy" @click="sortTasksNaturally">自然排序</button>
            <button :disabled="!checkedTaskIds.length || modelControlsBusy" @click="removeTasks(checkedTaskIds)">移除勾选</button>
            <button :disabled="!checkedTaskIds.length || queueRunning || exportBusy" @click="retryTasks(true)">重试勾选</button>
            <button :disabled="!failedCount || queueRunning || exportBusy" @click="retryTasks()">重试失败项</button>
          </div>
          <div v-if="tasks.length" class="task-list" aria-label="批量任务列表">
            <div v-for="task in tasks" :key="task.id" :class="['task-item', task.status, { selected: task.id === selectedTaskId }]" role="group" :aria-label="task.fileName" :aria-current="task.id === selectedTaskId ? 'true' : undefined" @click="selectedTaskId = task.id">
              <input v-model="checkedTaskIds" class="task-check" type="checkbox" :value="task.id" :aria-label="`勾选 ${task.fileName}`" @click.stop @keydown.stop />
              <button class="task-main" type="button" :aria-pressed="task.id === selectedTaskId" @click.stop="selectedTaskId = task.id">
                <span class="task-name" :title="task.path">{{ task.fileName }}</span>
                <small v-if="task.missing" class="missing-file">原文件不可访问，已存结果仍可导出</small>
                <small v-if="task.result" :class="{'missing-file': task.exportError}" :title="task.exportDirectory">{{ exportState(task) }}</small>
                <small v-if="task.pageRange">原文页码：{{ task.pageRange }}</small>
                <small v-if="task.rotation">图片顺时针 {{ task.rotation }}°</small>
                <small v-if="task.totalPages">
                  <template v-if="task.status === 'running'">{{ task.sourcePage ? `正在识别原文第 ${task.sourcePage} 页 · ` : "" }}已完成 {{ task.currentPage ?? 0 }}/{{ task.totalPages }} 页</template>
                  <template v-else>已完成 {{ task.currentPage ?? 0 }}/{{ task.totalPages }} 页</template>
                  <span v-if="task.status === 'running' || task.status === 'paused'"> · {{ Math.round(((task.currentPage ?? 0) / task.totalPages) * 100) }}%</span>
                </small>
              </button>
              <span class="task-status">{{ statusLabels[task.status] }}</span>
              <div class="task-actions" @keydown.stop>
                <button :disabled="queueRunning || exportBusy || tasks[0]?.id === task.id" aria-label="上移任务" @click.stop="moveTask(task, -1)">上移</button>
                <button :disabled="queueRunning || exportBusy || tasks[tasks.length - 1]?.id === task.id" aria-label="下移任务" @click.stop="moveTask(task, 1)">下移</button>
                <button v-if="task.exportError" :disabled="modelControlsBusy" @click.stop="retryTaskExport(task)">重试导出</button>
                <button v-if="task.status === 'failed' || task.status === 'cancelled'" :disabled="exportBusy || queueRunning" @click.stop="retryTask(task)">重试</button>
                <button v-if="task.status !== 'running' && task.status !== 'paused'" :disabled="modelControlsBusy" @click.stop="removeTask(task)">移除</button>
              </div>
              <progress v-if="task.totalPages && (task.status === 'running' || task.status === 'paused')" :aria-label="`${task.fileName} 识别进度`" class="task-progress" :value="task.currentPage ?? 0" :max="task.totalPages"></progress>
            </div>
          </div>
          <p v-else class="queue-empty">支持多选或拖入文件，按队列顺序识别。</p>
        </div>

        <div class="step-card settings-card">
          <div class="step-heading"><b>03</b><span>识别与导出</span></div>
          <label for="threshold"><span>最低置信度</span><strong>{{ scoreThreshold.toFixed(2) }}</strong></label>
          <p class="threshold-help">调高可能漏掉更多文字；下次 OCR 生效，文本层提取不受影响。</p>
          <input id="threshold" v-model.number="scoreThreshold" type="range" min="0" max="1" step="0.05" :disabled="modelControlsBusy" />
          <label v-if="recognitionMode === 'table'" class="merge-setting">
            <input v-model="mergeCrossPageTables" type="checkbox" :disabled="modelControlsBusy" />
            <span>合并 PDF 或同批图片的连续表格</span>
          </label>
          <div class="export-options">
            <span>导出格式</span>
            <label><input v-model="exportTxt" type="checkbox" :disabled="modelControlsBusy" />TXT</label>
            <label><input v-model="exportXlsx" type="checkbox" :disabled="modelControlsBusy" />XLSX</label>
            <label><input v-model="exportHtml" type="checkbox" :disabled="modelControlsBusy" />HTML</label>
          </div>
          <label class="merge-setting"><input v-model="autoExport" type="checkbox" :disabled="modelControlsBusy" />每个文件完成后自动导出</label>
          <div v-if="autoExport" class="auto-export-settings">
            <button :disabled="modelControlsBusy" @click="chooseAutoExportDirectory">选择自动导出目录</button>
            <p class="export-directory" :title="autoExportDirectory">{{ autoExportDirectory || '尚未选择目录' }}</p>
            <p>按文件导出，重名自动编号；跨图片合并请使用手动导出。采用下方选择的文本版本与文件名前后缀。</p>
          </div>
          <button v-if="!queueRunning && !queuePaused" class="primary-button" :disabled="setupBusy || queueStarting || exportBusy || !queuedCount" @click="runQueue">开始批量识别</button>
          <div v-else class="control-grid">
            <button v-if="!queuePaused" class="secondary-button" :disabled="!!queueTransition || phase === 'preparing'" @click="pauseQueue">{{ queueTransition === 'pausing' ? '正在暂停……' : '暂停' }}</button>
            <button v-else class="primary-button compact" :disabled="!!queueTransition" @click="resumeQueue">{{ queueTransition === 'resuming' ? '正在继续……' : '继续' }}</button>
            <button class="danger-button" :disabled="queueTransition === 'cancelling' || phase === 'preparing'" @click="cancelQueue">{{ queueTransition === 'cancelling' ? '正在取消……' : '取消队列' }}</button>
          </div>
          <button v-if="queueRunning" :disabled="!!queueTransition || phase === 'preparing'" class="secondary-button skip-button" @click="skipCurrentTask">跳过当前文件，继续下一项</button>
          <button v-if="queueRunning" class="force-button" @click="forceStopQueue">长时间无响应？强制停止</button>
          <template v-if="tasks.length">
          <div class="export-targets">
            <label>导出范围<select v-model="exportScope" :disabled="exportBusy || queueRunning" aria-label="导出范围"><option value="all">全部已有结果</option><option value="current">当前文件</option><option value="checked">勾选任务</option></select></label>
            <label>文本版本<select v-model="exportTextVersion" :disabled="exportBusy || queueRunning" aria-label="导出文本版本"><option value="formatted">整理后（含校对）</option><option value="original">整理前</option></select></label>
          </div>
          <details class="export-settings">
            <summary>导出规则 · 预计 {{ exportEstimate }} 个文件</summary>
            <label>文件组织<select v-model="exportGrouping" :disabled="exportBusy || queueRunning"><option value="separate">分别导出（同批图片表格合为一份）</option><option value="combined">全部合并为一份 / 每种格式</option></select></label>
            <label>同名文件<select v-model="exportCollision" :disabled="exportBusy || queueRunning"><option value="rename">自动编号，不覆盖</option><option value="skip">跳过已有文件</option><option value="overwrite">覆盖（导出前再次确认）</option></select></label>
            <label v-if="exportGrouping === 'combined'">合并文件名<input v-model="exportName" :disabled="exportBusy || queueRunning" maxlength="100" /></label>
            <label>文件名前缀<input v-model="exportPrefix" :disabled="exportBusy || queueRunning" placeholder="例如 {date}_" maxlength="100" /></label>
            <label>文件名后缀<input v-model="exportSuffix" :disabled="exportBusy || queueRunning" placeholder="例如 _{profile}_{mode}" maxlength="100" /></label>
            <p>支持 {date} 日期、{profile} 档位、{mode} 模式。无表格不生成 XLSX；文字模式可导出 HTML。</p>
          </details>
          <button class="secondary-button export-button" :disabled="!canExportSelectedFormats" @click="exportSelectedFormats">{{ exportBusy ? "正在导出……" : `导出所选格式（${exportEstimate}）` }}</button>
          <p class="export-hint" v-if="exportScope !== 'all' && !exportableTasks.length">此范围暂无可导出结果。</p>
          <p v-if="!exportFormatSelected" class="export-hint">请至少选择一种格式。</p>
          </template>
          <p v-else class="pause-note">识别结果自动保留在本机历史；导出后才会生成外部文件。</p>
          <p v-if="tasks.length" class="pause-note">暂停和普通取消会在当前页识别结束后生效。</p>
        </div>
      </aside>

      <section :class="['content-grid', {'pdf-workspace': isPdf}]">
        <article class="panel preview-panel">
          <div class="panel-title"><span>{{ isPdf ? "文档信息与设置" : "文档预览" }}</span><small>{{ fileName || "尚未选择任务" }}</small></div>
          <div class="preview-content">
          <details class="text-settings" open>
            <summary><span>文档设置</span><small>识别设置用于整个队列 · 整理设置用于所有结果</small></summary>
            <div class="text-settings-grid">
              <label class="text-setting-field">
                <span class="text-setting-name">PDF 文字来源</span>
                <select v-model="textSettings.pdfSource" :disabled="modelControlsBusy" aria-label="PDF 文字来源"><option value="auto">自动（优先提取文本层）</option><option value="ocr">强制 OCR</option></select>
              </label>
              <label class="text-setting-field">
                <span class="text-setting-name">文本整理</span>
                <select v-model="textSettings.textMode" :disabled="queueRunning || exportBusy" aria-label="文本整理"><option value="original">保留原始断行</option><option value="smart">智能整理</option><option value="continuous">合并为连续文本</option></select>
              </label>
              <label class="text-setting-field">
                <span class="text-setting-name">跨页正文</span>
                <span class="text-setting-toggle"><input v-model="textSettings.crossPageText" type="checkbox" :disabled="queueRunning || exportBusy" />合并相邻完整页面</span>
              </label>
              <label class="text-setting-field">
                <span class="text-setting-name">日语注音</span>
                <span class="text-setting-toggle"><input v-model="textSettings.rubyEnabled" type="checkbox" :disabled="modelControlsBusy" aria-label="识别日语注音" />识别横排与竖排注音</span>
              </label>
              <label class="text-setting-field">
                <span class="text-setting-name">注音输出</span>
                <select v-model="textSettings.rubyFormat" :disabled="queueRunning || exportBusy || (!textSettings.rubyEnabled && !hasRecognizedRuby)" aria-label="注音输出"><option value="ignore">忽略注音</option><option value="parentheses">括号保留</option><option value="ruby">Ruby 小字（HTML）</option></select>
              </label>
            </div>
            <p class="text-settings-help">文字来源和注音识别用于下次识别；整理与注音格式立即作用于已有文字结果，保留手动校对。页码和旋转仅用于当前文件。文本层内容异常时可用强制 OCR。</p>
          </details>
          <div v-if="selectedTask" class="document-controls">
            <template v-if="isPdf">
              <div class="document-control-row page-range-row">
                <span class="page-range-label">当前 PDF 页码</span>
                <label class="page-range-radio"><input v-model="pageRangeMode" value="all" type="radio" name="page-range-mode" :disabled="modelControlsBusy" @change="applyPageRange()" />全部页</label>
                <label class="page-range-radio"><input v-model="pageRangeMode" value="custom" type="radio" name="page-range-mode" :disabled="modelControlsBusy" />指定页码</label>
                <input v-model="pageRangeDraft" aria-label="指定 PDF 页码" placeholder="输入页码，例如 1,3-5,8" maxlength="2000" :disabled="modelControlsBusy" @focus="pageRangeMode = 'custom'" @input="pageRangeMode = 'custom'; documentSettingsError = ''" @change="applyPageRange()" />
              </div>
              <div class="page-range-scope">
                <span class="page-range-scope-label">页码设置应用范围</span>
                <div class="page-range-actions">
                  <button :disabled="modelControlsBusy || !checkedPdfCount" @click="applyPageRange(true)">应用到勾选的 PDF（{{ checkedPdfCount }}）</button>
                </div>
              </div>
              <div class="page-range-context">
                <span>当前 PDF：{{ selectedTask.fileName }}</span>
                <span>已勾选 PDF：{{ checkedPdfCount }} 个</span>
              </div>
              <p role="status">{{ documentSettingsBusy ? "正在校验……" : documentSettingsError ? "输入有误，上次范围：" : pageRangeDirty ? "尚未生效，上次范围：" : "已生效：" }}{{ selectedTask.pageRange || "全部页" }}{{ selectedTask.sourcePageCount ? ` · 原文共 ${selectedTask.sourcePageCount} 页` : "" }}。页码按 PDF 实际顺序计算，不是正文印刷页码；设置会在下次识别时生效。</p>
              <p v-if="documentSettingsError" class="document-settings-error" role="alert">{{ documentSettingsError }}</p>
            </template>
            <template v-else>
              <div class="document-control-row">
                <span>图片旋转 {{ selectedTask.rotation ?? 0 }}°</span>
                <button :disabled="modelControlsBusy" @click="rotateImage(-90)">左转 90°</button>
                <button :disabled="modelControlsBusy" @click="rotateImage(90)">右转 90°</button>
                <button :disabled="modelControlsBusy" @click="rotateImage(null)">还原</button>
                <button :disabled="modelControlsBusy || !checkedTaskIds.length" @click="rotateImage(0, true)">应用角度到勾选图片</button>
              </div>
              <p>仅调整预览与识别方向，不修改原文件。</p>
            </template>
            <div v-if="selectedTask.result || selectedTask.status === 'failed'" class="document-control-row rerun-row">
              <span>{{ selectedTask.result ? '设置变更后，已有结果不会自动重跑。' : selectedTask.error }}</span>
              <button :disabled="modelControlsBusy || selectedTask.status === 'queued'" @click="requeueSelected">重新识别当前文件</button>
            </div>
          </div>
          <div v-if="previewError" class="empty-state"><p>{{ previewError }}</p></div>
          <ImagePreview v-else-if="previewUrl" :src="previewUrl" :alt="fileName" :rotation="selectedTask?.rotation ?? 0" @error="previewError = '无法显示此图片格式或文件已不可读，仍可尝试识别或查看已保存的结果。'" />
          <p v-else-if="isPdf" class="pdf-info">PDF 按实际页序处理；自动模式优先读取文本层，需要 OCR 时才准备模型。</p>
          <div v-else class="empty-state"><div class="scan-mark"><i></i><i></i><i></i><i></i></div><p>从左侧添加并选择图片或 PDF</p></div>
          </div>
        </article>

        <article class="panel result-panel">
          <div class="panel-title">
            <span>{{ resultFocusMode ? fileName || "识别结果" : "识别结果" }}</span>
            <div class="result-actions">
              <span v-if="resultFocusMode" :class="['focus-save', { 'save-error': saveFailed }]" :title="saveStatus" role="status">{{ saveBadgeLabel }}</span>
              <div v-if="selectedResult" class="result-tabs">
                <button :class="{ active: resultView === 'text' }" @click="resultView = 'text'">文本</button>
                <button :class="{ active: resultView === 'tables' }" :disabled="!selectedTables.length" @click="resultView = 'tables'">表格 {{ selectedTables.length }}</button>
              </div>
              <button
                v-if="resultView === 'tables' && selectedHasMergedTables"
                class="text-button merge-toggle"
                @click="mergeCrossPageTables = !mergeCrossPageTables"
              >{{ mergeCrossPageTables ? "按页拆分" : "合并连续页" }}</button>
              <button
                v-if="!resultFocusMode || resultView === 'tables'"
                class="text-button"
                :disabled="resultView === 'tables' ? !selectedTables.length : !selectedResult?.text"
                @click="copyCurrentResult"
              >{{ resultView === "tables" ? "复制表格（TSV）" : "复制全文" }}</button>
              <button
                class="focus-button"
                :disabled="!selectedResult"
                :title="resultFocusMode ? '退出专注模式（Esc）' : '专注查看识别结果'"
                :aria-label="resultFocusMode ? '退出专注模式' : '进入专注模式'"
                @click="toggleResultFocus"
              >
                <svg v-if="!resultFocusMode" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8H3V3M16 8h5V3M8 16H3v5M16 16h5v5" /></svg>
              </button>
            </div>
          </div>
          <div v-if="selectedResult" class="result-body">
            <div v-if="resultView === 'text'" class="text-result-tools">
              <div v-if="!resultFocusMode" class="text-view-switch" role="tablist" aria-label="识别结果版本">
                <button type="button" :class="{ active: rawTextView }" role="tab" :aria-selected="rawTextView" :disabled="exportBusy || queueRunning" @click="rawTextView = true">整理前</button>
                <button type="button" :class="{ active: !rawTextView }" role="tab" :aria-selected="!rawTextView" :disabled="exportBusy || queueRunning" @click="rawTextView = false">整理后</button>
              </div>
              <label v-if="textSettings.rubyFormat === 'ruby' && (resultFocusMode || !rawTextView) && !selectedTask?.textEdited" title="关闭后以普通文本显示，便于直接校对"><input v-model="rubyPreview" type="checkbox" />显示日语注音（Ruby）</label>
              <button v-if="selectedTask?.textEdited" :disabled="queueRunning || exportBusy" @click="discardTextEdits">恢复自动整理版</button>
              <small v-for="message in textProjection.warnings" :key="message">{{ message }}</small>
              <small>来源：文本层 {{ selectedResult.pages.filter(p=>p.source === 'pdf-text').length }} 页 · OCR {{ selectedResult.pages.filter(p=>p.source === 'ocr').length }} 页 · 旧结果未记录 {{ selectedResult.pages.filter(p=>!p.source).length }} 页。</small>
              <small>本结果：{{ selectedResult.profile === 'fast' ? '轻量' : '高精度' }} · {{ selectedTask?.resultType === 'table' ? '表格与文字' : '普通文字' }} · 页码 {{ selectedResult.pageRange || '全部页' }} · 注音{{ selectedResult.rubyEnabled ? '已启用' : '未启用' }}。</small>
            </div>
            <div class="metrics">
              <div><b>{{ selectedPageCount }} / {{ selectedTotalPageCount }}</b><span>{{ selectedUsesImageBatch ? "同批图片完成 / 总数" : selectedResult.pageRange ? "已完成 / 所选页数" : "已完成 / 总页数" }}</span></div>
              <div><b>{{ selectedBlockCount }}</b><span>文本块</span></div>
              <div><b>{{ selectedTables.length }}</b><span>{{ mergeCrossPageTables && selectedRawTableCount > selectedMergedTableCount ? `跨页合并（原 ${selectedRawTableCount}）` : "表格" }}</span></div>
              <div><b>{{ (selectedElapsedMs / 1000).toFixed(2) }}s</b><span>用时</span></div>
            </div>
            <div v-if="resultFocusMode && resultView === 'text'" class="focus-text-compare">
              <section class="focus-text-column"><div class="focus-text-heading"><span>整理前</span><button class="text-button" :disabled="!rawTextProjection.text" @click="copyText(rawTextProjection.text, '整理前文本')">复制全文</button></div><textarea :value="rawTextProjection.text" readonly spellcheck="false" aria-label="整理前文本"></textarea></section>
              <section class="focus-text-column"><div class="focus-text-heading"><span>整理后</span><button class="text-button" :disabled="!formattedTextProjection.text" @click="copyText(formattedTextProjection.text, '整理后文本')">复制全文</button></div><div v-if="textSettings.rubyFormat === 'ruby' && rubyPreview && !selectedTask?.textEdited" class="ruby-text-preview" aria-label="整理后注音预览" v-html="formattedTextProjection.html"></div><textarea v-else :value="formattedTextProjection.text" :readonly="exportBusy" spellcheck="false" aria-label="整理后文本" @input="updateSelectedText"></textarea></section>
            </div>
            <div v-else-if="resultView === 'text' && textSettings.rubyFormat === 'ruby' && rubyPreview && !rawTextView && !selectedTask?.textEdited" class="ruby-text-preview" aria-label="Ruby 文本预览" v-html="textProjection.html"></div>
            <textarea v-else-if="resultView === 'text'" :value="textProjection.text" :readonly="exportBusy || rawTextView" spellcheck="false" aria-label="识别文本" @input="updateSelectedText"></textarea>
            <TableResultViewer v-else :tables="selectedTables" :view-key="`${selectedTaskId}:${mergeCrossPageTables}`" />
          </div>
          <div v-else-if="selectedTask?.error" class="empty-state result-empty error-state"><p>{{ selectedTask.error }}</p></div>
          <div v-else class="empty-state result-empty"><p>选择任务后，识别结果将在这里显示并可直接校对</p></div>
        </article>
      </section>
    </section>

    <div v-if="historyOpen" class="history-backdrop">
      <section class="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header><h2 id="history-title">识别历史</h2><button :disabled="historyBusy" @click="closeHistory">关闭历史</button></header>
        <p>清理队列不会删除结果。打开后可查看、复制或导出；原始文件已移动也可查看。历史不会自动清理。</p>
        <p v-if="historyError" class="save-error" role="alert">{{ historyError }}</p>
        <input v-model="historySearch" type="search" placeholder="按文件名查找" aria-label="查找识别历史" />
        <div class="history-list">
          <div v-for="entry in visibleHistory" :key="entry.task.id" class="history-row">
            <input v-model="historySelected" type="checkbox" :value="entry.task.id" :disabled="historyBusy || tasks.some(task => task.id === entry.task.id)" :aria-label="`选择历史 ${entry.task.fileName}`" />
            <div><strong>{{ entry.task.fileName }}</strong><small>{{ new Date(entry.savedAt).toLocaleString() }} · {{ entry.task.result?.pageCount ?? 0 }} 页 · {{ exportState(entry.task) }}</small><small>{{ tasks.some(task => task.id === entry.task.id) ? '在当前队列中；移除后才可永久删除' : '已保留，可恢复到队列' }}</small></div>
            <button :disabled="historyBusy" @click="restoreHistoryEntry(entry.task.id)">打开结果</button>
          </div>
          <p v-if="!filteredHistory.length">暂无匹配的识别记录。</p>
        </div>
        <footer><button :disabled="historyBusy || historyPage <= 1" @click="historyPage--">上一页</button><span>{{ historyPage }} / {{ historyPageCount }} · 共 {{ filteredHistory.length }} 项</span><button :disabled="historyBusy || historyPage >= historyPageCount" @click="historyPage++">下一页</button><button class="danger-button" :disabled="historyBusy || !historySelected.length" @click="permanentlyDeleteHistory">永久删除勾选（{{ historySelected.length }}）</button></footer>
      </section>
    </div>
    <div v-if="feedback" class="action-feedback" role="status"><span>{{ feedback }}</span><button aria-label="关闭提示" @click="feedback = ''">关闭</button></div>
    <footer role="status" aria-live="polite" :class="['statusbar', { error: phase === 'error' }]" :title="status">
      <span class="status-dot"></span>
      <div class="status-content">
        <span>{{ status }}</span>
        <button v-if="!sidecarReady && !setupBusy" class="text-button" :disabled="queueRunning" @click="restartSidecar">重启识别进程</button>
        <details v-if="phase === 'error' && errorDetails" class="error-details"><summary>查看技术详情</summary><pre>{{ errorDetails }}</pre></details>
      </div>
      <button class="diagnostic-button" @click="copyDiagnostics">复制诊断信息</button>
    </footer>
  </main>
</template>
