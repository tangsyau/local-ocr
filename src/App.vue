<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import TableResultViewer from "./components/TableResultViewer.vue";
import { ocrSidecar, SidecarRequestError } from "./lib/sidecar";
import { displayTables, imageBatchTables, mergeTablePages, tableToTsv } from "./lib/table-results";
import { localImagePreview, createId, isWebkitGtk40Build, listenBeforeClose, listenFileDrop, openLocalDialog } from "./lib/tauri-bridge";
import { loadSession, saveSession, type AppSettings, type SavedSession } from "./lib/session";
import type { DiagnosticInfo, ModelCacheStatus, ModelProfile, OcrPage, OcrResult, OcrTable, OcrTask, OcrTaskStatus, RecognitionMode, SidecarEvent } from "./lib/types";

type AppPhase = "starting" | "idle" | "preparing" | "recognizing" | "paused" | "error";

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
const checkedTaskIds = ref<string[]>([]);
const saveStatus = ref("正在读取上次任务……");
const saveFailed = ref(false);
let sessionLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveChain: Promise<void> = Promise.resolve();
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
const errorSummary = ref("");
const errorDetails = ref("");

const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskId.value) ?? null);
const selectedResult = computed(() => selectedTask.value?.result ?? null);
const selectedPath = computed(() => selectedTask.value?.path ?? "");
const fileName = computed(() => selectedTask.value?.fileName ?? "");
const extension = computed(() => fileName.value.split(".").pop()?.toLowerCase() ?? "");
const isPdf = computed(() => extension.value === "pdf");
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
const modelControlsBusy = computed(() => queueRunning.value || queueStarting.value || setupBusy.value || exportBusy.value);
const queuedCount = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const completedCount = computed(() => tasks.value.filter((task) => task.status === "completed").length);
const exportableTasks = computed(() => tasks.value.filter((task) => task.result && task.result.pageCount > 0));
const hasUnexported = computed(() => exportableTasks.value.some((task) => (task.exportedRevision ?? -1) !== (task.revision ?? 0)));
const failedCount = computed(() => tasks.value.filter((task) => task.status === "failed" || task.status === "cancelled").length);
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
  : selectedResult.value?.totalPageCount ?? 0
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
  || ((exportXlsx.value || exportHtml.value) && tableTasks.value.length > 0)
));
const exportEstimate = computed(() => {
  const textCount = exportableTasks.value.length;
  const tableCount = tableExportItems().length;
  return (exportTxt.value ? (exportGrouping.value === "combined" ? Number(textCount > 0) : textCount) : 0)
    + (Number(exportXlsx.value) + Number(exportHtml.value)) * (exportGrouping.value === "combined" ? Number(tableCount > 0) : tableCount);
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
    saveStatus.value = saved ? `已恢复 ${saved.tasks.length} 个任务；未完成项等待手动开始` : "任务和校对内容将自动保存在本机";
  } catch (error) {
    saveFailed.value = true;
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
  for (const cleanup of cleanupListeners) cleanup();
  if (saveTimer) clearTimeout(saveTimer);
  void ocrSidecar.stop();
});

watch([tasks, selectedTaskId, scoreThreshold, modelProfile, recognitionMode, mergeCrossPageTables,
  exportTxt, exportXlsx, exportHtml, exportGrouping, exportCollision, exportPrefix, exportSuffix, exportName], () => {
  if (!sessionLoaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushSave().catch(() => {}); }, 400);
}, { deep: true });

function applySettings(settings: AppSettings): void {
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
}

function outputFormats(): string[] {
  return [exportTxt.value ? "txt" : "", exportXlsx.value ? "xlsx" : "", exportHtml.value ? "html" : ""].filter(Boolean);
}

async function flushSave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!sessionLoaded) throw new Error("自动保存尚未就绪");
  const snapshot: SavedSession = JSON.parse(JSON.stringify({
    schema: 1, savedAt: new Date().toISOString(), selectedTaskId: selectedTaskId.value, tasks: tasks.value,
    settings: { profile: modelProfile.value, mode: recognitionMode.value, threshold: scoreThreshold.value,
      merge: mergeCrossPageTables.value, formats: outputFormats(), exportGrouping: exportGrouping.value,
      exportCollision: exportCollision.value, exportPrefix: exportPrefix.value, exportSuffix: exportSuffix.value, exportName: exportName.value }
  }));
  saveChain = saveChain.catch(() => {}).then(() => saveSession(snapshot));
  try {
    await saveChain;
    saveStatus.value = "任务与校对内容已自动保存（仅在本机）";
    saveFailed.value = false;
  } catch (error) {
    saveFailed.value = true;
    saveStatus.value = error instanceof Error ? error.message : "自动保存失败";
    throw error;
  }
}

async function beforeClose(): Promise<boolean> {
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
  const result = await ocrSidecar.request<{ items: Array<{ id: string; exists: boolean }> }>("validate_paths", {
    items: tasks.value.map((task) => ({ id: task.id, path: task.path }))
  });
  for (const item of result.items) {
    const task = tasks.value.find((candidate) => candidate.id === item.id);
    if (task) task.missing = !item.exists;
  }
}

async function reportPackagedUiReady(): Promise<void> {
  const probe = await ocrSidecar.request<{ enabled: boolean }>("ui_smoke_status");
  if (!probe.enabled) return;
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  await ocrSidecar.request("ui_smoke_ready", { width: innerWidth, height: innerHeight,
    sidebarFits: sidebar ? sidebar.scrollHeight <= sidebar.clientHeight + 2 : false });
}

watch(selectedTaskId, () => {
  resultView.value = "text";
});

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && resultFocusMode.value) resultFocusMode.value = false;
}

function toggleResultFocus(): void {
  if (!selectedResult.value) return;
  resultFocusMode.value = !resultFocusMode.value;
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
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
  for (const [batchIndex, path] of paths.entries()) {
    if (!/\.(png|jpe?g|webp|bmp|tiff?|pdf)$/i.test(path) || existing.has(key(path))) continue;
    existing.add(key(path));
    additions.push({
      id: createId(),
      batchId,
      batchIndex,
      path,
      fileName: path.split(/[\\/]/).pop() ?? path,
      status: "queued",
      resultType: recognitionMode.value,
      revision: 0
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

function removeTasks(ids: string[]): void {
  if (queueStarting.value || exportBusy.value) return;
  const targets = tasks.value.filter((task) => ids.includes(task.id) && !["running", "paused"].includes(task.status));
  if (targets.some((task) => task.result && task.exportedRevision !== (task.revision ?? 0)) && !window.confirm("选中任务含未导出的结果。移除后自动保存记录中也会删除这些结果，确定移除？")) return;
  const removed = new Set(targets.map((task) => task.id));
  tasks.value = tasks.value.filter((task) => !removed.has(task.id));
  checkedTaskIds.value = checkedTaskIds.value.filter((id) => !removed.has(id));
  if (!tasks.value.some((task) => task.id === selectedTaskId.value)) selectedTaskId.value = tasks.value[0]?.id ?? "";
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
  const positions = new Map<string, number>();
  for (const item of tasks.value) {
    item.batchIndex = positions.get(item.batchId) ?? 0;
    positions.set(item.batchId, item.batchIndex + 1);
  }
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
  task.status = "queued";
  task.error = undefined;
  task.currentPage = undefined;
  task.totalPages = undefined;
  status.value = `${task.fileName} 已重新加入队列；重试会从文件首页开始`;
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

async function repairModels(name?: string): Promise<void> {
  if (modelControlsBusy.value) return;
  if (!window.confirm(name
    ? `重新下载 ${name}？现有缓存会移动到模型目录下的备份文件夹，可手动恢复；不删除原缓存。`
    : "将不完整的模型缓存移到备份文件夹，并下载缺失模型。完整模型保持不变。是否继续？")) return;
  await runModelPreparation(name ? [name] : null);
}

async function runModelPreparation(repairNames?: string[] | null): Promise<boolean> {
  if (queueRunning.value || exportBusy.value || setupBusy.value) return false;
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
  const poll = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await refreshModelStatus(); } finally { checking = false; }
  }, 2000);
  try {
    await ocrSidecar.request(
      repairNames === undefined ? "prepare" : "repair_models",
      { profile: modelProfile.value, mode: recognitionMode.value, reload: true, ...(repairNames ? { names: repairNames } : {}) },
      updateGlobalStatus,
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
    showError(error);
    return false;
  } finally {
    clearInterval(poll);
  }
}

function modelChanged(): void {
  if (!modelsReady.value) status.value = "识别设置已切换，开始识别时将准备对应模型";
  void refreshModelStatus();
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
  if (!window.confirm(`确定删除${label}的本地缓存吗？下次准备模型时需要重新联网下载。`)) return;
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
  const diagnostics: DiagnosticInfo = {
    appVersion: "0.7.0",
    sidecarRunning: ocrSidecar.running,
    sidecarStderr: ocrSidecar.stderr ? "运行日志已省略，以免复制文档路径或识别相关输出" : "",
    ...remote
  };
  await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  status.value = "诊断信息已复制；其中不包含识别文字或文档内容";
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
  if (event.page !== undefined) task.currentPage = event.page;
  if (event.pageCount !== undefined) task.totalPages = event.pageCount;
  if (event.event === "paused") {
    task.status = "paused";
    phase.value = "paused";
  } else if (event.event === "resumed") {
    task.status = "running";
    phase.value = "recognizing";
  }
  if (event.message) status.value = `${task.fileName}：${event.message}`;
}

async function runQueue(): Promise<void> {
  if (queueRunning.value || queueStarting.value || exportBusy.value || setupBusy.value || !queuedCount.value) return;
  queueStarting.value = true;
  try {
    if (!ocrSidecar.running && !(await startSidecar())) return;
    await validateTaskPaths();
    for (const task of tasks.value) if (task.status === "queued" && task.missing) {
      task.status = "failed";
      task.error = "原文件已移动、删除或当前不可访问；已保存的识别结果仍可导出。请恢复原路径后重试，或移除并重新添加文件。";
    }
    if (!queuedCount.value) { status.value = "等待任务的原文件均不可访问，请检查文件路径。"; return; }
    if (!modelsReady.value && !(await runModelPreparation())) return;
  } catch (error) {
    showError(error);
    return;
  } finally {
    queueStarting.value = false;
  }

  queueRunning.value = true;
  queuePaused.value = false;
  stopRequested.value = false;
  phase.value = "recognizing";

  try {
    while (!stopRequested.value) {
      const task = tasks.value.find((item) => item.status === "queued");
      if (!task) break;
      task.status = "running";
      task.resultType = recognitionMode.value;
      task.error = undefined;
      task.textEdited = false;
      activeTaskId = task.id;
      skipRequestedTaskId = "";
      const receivedPages: OcrPage[] = [];
      status.value = `正在识别 ${completedCount.value + 1}/${tasks.value.length}：${task.fileName}`;

      try {
        const result = await ocrSidecar.request<OcrResult>(
          "recognize",
          { path: task.path, scoreThreshold: scoreThreshold.value, mode: recognitionMode.value },
          (event) => {
            updateTaskStatus(task, event);
            if (event.pageResult) {
              const editor = selectedTaskId.value === task.id ? document.querySelector<HTMLTextAreaElement>(".result-body textarea") : null;
              const position = editor ? { start: editor.selectionStart, end: editor.selectionEnd, top: editor.scrollTop } : null;
              receivedPages.push(event.pageResult);
              const tables = recognitionMode.value === "table" ? mergeTablePages(receivedPages.map((page) => page.tables)) : [];
              const originalText = task.result?.text;
              task.result = {
                path: task.path, profile: modelProfile.value, resultType: recognitionMode.value,
                cancelled: false, text: task.textEdited
                  ? [originalText ?? "", event.pageResult.text].filter(Boolean).join("\n\n")
                  : receivedPages.map((page) => page.text).join("\n\n"),
                pageCount: receivedPages.length, totalPageCount: event.pageCount ?? receivedPages.length,
                blockCount: receivedPages.reduce((sum, page) => sum + page.blocks.length, 0),
                tableCount: tables.length, rawTableCount: receivedPages.reduce((sum, page) => sum + page.tables.length, 0),
                elapsedMs: event.elapsedMs ?? 0, pages: [...receivedPages], tables
              };
              task.revision = (task.revision ?? 0) + 1;
              if (editor && position) void nextTick(() => {
                if (selectedTaskId.value !== task.id || !editor.isConnected) return;
                editor.setSelectionRange(position.start, position.end);
                editor.scrollTop = position.top;
              });
            }
          },
          null
        );
        if (task.textEdited && task.result) result.text = task.result.text;
        task.result = result;
        task.revision = (task.revision ?? 0) + 1;
        task.currentPage = result.pageCount;
        task.totalPages = result.totalPageCount;
        task.status = result.cancelled ? "cancelled" : "completed";
        if (skipRequestedTaskId === task.id) task.error = "已跳过此文件；已完成页面的部分结果已保留";
      } catch (error) {
        task.status = stopRequested.value ? "cancelled" : "failed";
        task.error = error instanceof Error ? error.message : String(error);
        if (!ocrSidecar.running) {
          sidecarReady.value = false;
          preparedProfile.value = null;
          preparedMode.value = null;
          throw error;
        }
      }
      activeTaskId = "";

      if (queuePaused.value) break;
    }

    if (stopRequested.value) {
      status.value = "批量识别已取消；已完成和部分完成的结果仍然保留";
    } else if (queuePaused.value) {
      status.value = "队列已暂停";
    } else {
      status.value = `队列处理完成：成功 ${completedCount.value} 个，共 ${tasks.value.length} 个`;
    }
  } catch (error) {
    showError(error);
  } finally {
    activeTaskId = "";
    queueRunning.value = false;
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
  if (!queueRunning.value) return;
  queuePaused.value = true;
  phase.value = "paused";
  status.value = "正在请求暂停，将在当前页完成后暂停……";
  try {
    await ocrSidecar.request("pause", {}, undefined, 10_000);
  } catch (error) {
    showError(error);
  }
}

async function resumeQueue(): Promise<void> {
  if (!queuePaused.value) return;
  queuePaused.value = false;
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
    void runQueue();
  }
}

async function cancelQueue(): Promise<void> {
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
    const tables = batchTasks.length > 1
      ? imageBatchTables(batchTasks.map((item) => item.result ?? null), mergeCrossPageTables.value)
      : displayTables(task.result ?? null, mergeCrossPageTables.value);
    if (tables.length) {
      items.push({
        fileName: batchTasks.length > 1 ? imageBatchExportName(batchTasks[0]) : task.fileName,
        tables,
        ids: batchTasks.filter((item) => (item.result?.rawTableCount ?? 0) > 0).map((item) => item.id),
        profile: task.result!.profile, mode: task.resultType
      });
    }
  }
  return items;
}

async function exportSelectedFormats(): Promise<void> {
  if (!canExportSelectedFormats.value) return;
  exportBusy.value = true;
  try {
    const directory = await openLocalDialog({ directory: true, multiple: false, title: "选择导出文件夹" });
    if (typeof directory !== "string") return;
    if (!ocrSidecar.running && !(await startSidecar())) return;
    const revisions = new Map(exportableTasks.value.map((task) => [task.id, task.revision ?? 0]));
    const payload = JSON.parse(JSON.stringify({
      directory, formats: outputFormats(),
      textItems: exportableTasks.value.map((task) => ({ id: task.id, fileName: task.fileName, text: task.result?.text ?? "",
        profile: task.result?.profile, mode: task.resultType })),
      tableItems: tableExportItems(),
      options: { grouping: exportGrouping.value, collision: exportCollision.value,
        prefix: exportPrefix.value, suffix: exportSuffix.value, name: exportName.value }
    }));
    const preview = await ocrSidecar.request<{ count: number; skipped: number; overwrites: number; noTableCount: number;
      files: Array<{ name: string; action: string }> }>("export_preview", payload);
    if (!preview.count) { status.value = `没有需要写入的文件（同名跳过 ${preview.skipped} 个）；未识别到表格的任务不会生成 XLSX/HTML。`; return; }
    const filenames = preview.files.filter((file) => file.action !== "skip").slice(0, 12).map((file) => file.name).join("\n");
    if (!window.confirm(`将生成 ${preview.count} 个文件，覆盖 ${preview.overwrites} 个，跳过 ${preview.skipped} 个。\n${preview.noTableCount} 个任务没有表格，不会生成 XLSX/HTML。\n\n${filenames}${preview.count > 12 ? "\n……" : ""}\n\n是否导出？`)) return;
    const response = await ocrSidecar.request<{ count: number; skipped: number; exportedIds: string[] }>(
      "export_results", payload, undefined, null
    );
    for (const task of tasks.value) if (response.exportedIds.includes(task.id) && revisions.get(task.id) === (task.revision ?? 0)) {
      task.exportedRevision = task.revision ?? 0;
    }
    status.value = `已导出 ${response.count} 个文件，跳过 ${response.skipped} 个；位置：${directory}`;
    await flushSave().catch(() => {});
  } catch (error) {
    showError(error);
  } finally {
    exportBusy.value = false;
  }
}

async function copyCurrentResult(): Promise<void> {
  if (!selectedResult.value) return;
  if (resultView.value === "tables") {
    if (!selectedTables.value.length) return;
    const tsv = selectedTables.value.map(tableToTsv).filter(Boolean).join("\n\n");
    await navigator.clipboard.writeText(tsv);
    status.value = `已复制 ${selectedTables.value.length} 个表格的制表符文本，可直接粘贴到 Excel`;
    return;
  }
  if (!selectedResult.value.text) return;
  await navigator.clipboard.writeText(selectedResult.value.text);
  status.value = `${fileName.value} 的识别文本已复制到剪贴板`;
}

function updateSelectedText(event: Event): void {
  if (selectedTask.value?.result) {
    selectedTask.value.result.text = (event.target as HTMLTextAreaElement).value;
    selectedTask.value.textEdited = true;
    selectedTask.value.revision = (selectedTask.value.revision ?? 0) + 1;
  }
}

function showError(error: unknown): void {
  phase.value = "error";
  errorSummary.value = error instanceof Error ? error.message : String(error);
  errorDetails.value = error instanceof SidecarRequestError
    ? error.details
    : error instanceof Error
      ? error.stack ?? ""
      : "";
  const help: Record<string, string> = {
    download: "模型下载失败：请检查网络，或使用“修复缺失模型”后重试。",
    model: "模型无法载入：可对对应模型重新下载；旧缓存会保留备份。",
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
        <div class="privacy-badge"><span></span>文档仅在本机处理</div>
      </div>
    </header>

    <section class="workspace">
      <aside class="sidebar">
        <div class="step-card">
          <div class="step-heading"><b>01</b><span>选择识别方式</span></div>
          <div class="mode-options">
            <label :class="{ selected: recognitionMode === 'text' }">
              <input v-model="recognitionMode" type="radio" value="text" :disabled="modelControlsBusy" @change="modelChanged" />
              <span><strong>普通文字</strong><small>输出连续文本与文字框</small></span>
            </label>
            <label :class="{ selected: recognitionMode === 'table' }">
              <input v-model="recognitionMode" type="radio" value="table" :disabled="modelControlsBusy" @change="modelChanged" />
              <span><strong>表格与文字</strong><small>恢复行列和合并单元格，可导出 XLSX</small></span>
            </label>
          </div>
          <p class="option-caption">文字模型档位</p>
          <div class="model-options">
            <label :class="{ selected: modelProfile === 'fast' }">
              <input v-model="modelProfile" type="radio" value="fast" :disabled="modelControlsBusy" @change="modelChanged" />
              <span><strong>快速</strong><small>轻量模型，适合批量普通文档</small></span>
            </label>
            <label :class="{ selected: modelProfile === 'accurate' }">
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
            <small>正在下载或载入；已缓存 {{ formatBytes(modelCache?.sizeBytes ?? 0) }}。下载源未提供总量时不显示百分比。</small>
          </div>
          <div class="model-managers">
          <details class="model-manager">
            <summary>模型管理</summary>
            <div v-if="modelCache" class="model-status-card">
              <div><span>当前组合</span><strong>{{ modelCache.installed ? "必要文件已齐全" : `${modelCache.installedCount}/${modelCache.modelCount} 个模型完整` }}</strong></div>
              <div><span>占用空间</span><strong>{{ formatBytes(modelCache.sizeBytes) }}</strong></div>
              <p class="model-path" :title="modelCache.cacheRoot">{{ modelCache.cacheRoot }}</p>
              <ul>
                <li v-for="model in modelCache.models" :key="model.name">
                  <span>{{ model.name }}</span><small>{{ model.state === 'incomplete' ? '不完整 · ' : '' }}{{ model.sizeBytes ? formatBytes(model.sizeBytes) : "未下载" }}</small>
                  <button :disabled="modelControlsBusy" @click="repairModels(model.name)">重下</button>
                </li>
              </ul>
            </div>
            <p v-else class="model-status-empty">启动识别进程后可查看模型状态。</p>
            <div class="model-actions">
              <button :disabled="!sidecarReady || modelManagerBusy" @click="refreshModelStatus">刷新</button>
              <button :disabled="!sidecarReady || modelControlsBusy" @click="repairModels()">修复缺失模型</button>
              <button class="delete-model" :disabled="!modelCache?.sizeBytes || modelControlsBusy" @click="deleteCurrentModels">删除缓存</button>
            </div>
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
          <div class="step-heading"><b>02</b><span>批量任务</span></div>
          <button class="file-picker" :disabled="setupBusy || queueStarting || exportBusy" @click="chooseFiles"><span class="plus">＋</span><span>添加图片或 PDF</span></button>
          <div v-if="tasks.length" class="queue-toolbar"><span>{{ queuedCount }} 等待 · {{ checkedTaskIds.length }} 勾选</span><button :disabled="queueRunning || exportBusy" @click="clearFinished">清理已结束</button></div>
          <div v-if="tasks.length" class="batch-actions">
            <button @click="selectAllTasks">全选 / 取消</button>
            <button :disabled="!checkedTaskIds.length || exportBusy" @click="removeTasks(checkedTaskIds)">移除勾选</button>
            <button :disabled="!checkedTaskIds.length || queueRunning || exportBusy" @click="retryTasks(true)">重试勾选</button>
            <button :disabled="!failedCount || queueRunning || exportBusy" @click="retryTasks()">重试失败项</button>
          </div>
          <div v-if="tasks.length" class="task-list">
            <div v-for="task in tasks" :key="task.id" :class="['task-item', task.status, { selected: task.id === selectedTaskId }]" role="button" tabindex="0" @click="selectedTaskId = task.id" @keydown.enter="selectedTaskId = task.id">
              <input v-model="checkedTaskIds" class="task-check" type="checkbox" :value="task.id" :aria-label="`勾选 ${task.fileName}`" @click.stop @keydown.stop />
              <div class="task-main">
                <span class="task-name" :title="task.path">{{ task.fileName }}</span>
                <small v-if="task.missing" class="missing-file">原文件不可访问，已存结果仍可导出</small>
                <small v-if="task.totalPages">
                  <template v-if="task.status === 'running'">正在处理第 {{ Math.min((task.currentPage ?? 0) + 1, task.totalPages) }}/{{ task.totalPages }} 页</template>
                  <template v-else>已完成 {{ task.currentPage ?? 0 }}/{{ task.totalPages }} 页</template>
                  <span v-if="task.status === 'running' || task.status === 'paused'"> · {{ Math.round(((task.currentPage ?? 0) / task.totalPages) * 100) }}%</span>
                </small>
              </div>
              <span class="task-status">{{ statusLabels[task.status] }}</span>
              <div class="task-actions">
                <button :disabled="queueRunning || exportBusy || tasks[0]?.id === task.id" aria-label="上移任务" @click.stop="moveTask(task, -1)">上移</button>
                <button :disabled="queueRunning || exportBusy || tasks[tasks.length - 1]?.id === task.id" aria-label="下移任务" @click.stop="moveTask(task, 1)">下移</button>
                <button v-if="task.status === 'failed' || task.status === 'cancelled'" :disabled="exportBusy" @click.stop="retryTask(task)">重试</button>
                <button v-if="task.status !== 'running' && task.status !== 'paused'" :disabled="exportBusy" @click.stop="removeTask(task)">移除</button>
              </div>
              <progress v-if="task.totalPages && (task.status === 'running' || task.status === 'paused')" class="task-progress" :value="task.currentPage ?? 0" :max="task.totalPages"></progress>
            </div>
          </div>
          <p v-else class="queue-empty">支持多选或拖入文件，按队列顺序识别。</p>
        </div>

        <div class="step-card settings-card">
          <div class="step-heading"><b>03</b><span>识别与导出</span></div>
          <label for="threshold"><span>最低置信度</span><strong>{{ scoreThreshold.toFixed(2) }}</strong></label>
          <input id="threshold" v-model.number="scoreThreshold" type="range" min="0" max="1" step="0.05" :disabled="modelControlsBusy" />
          <label v-if="recognitionMode === 'table'" class="merge-setting">
            <input v-model="mergeCrossPageTables" type="checkbox" />
            <span>合并 PDF 或同批图片的连续表格</span>
          </label>
          <button v-if="!queueRunning && !queuePaused" class="primary-button" :disabled="setupBusy || queueStarting || exportBusy || !queuedCount" @click="runQueue">开始批量识别</button>
          <div v-else class="control-grid">
            <button v-if="!queuePaused" class="secondary-button" @click="pauseQueue">暂停</button>
            <button v-else class="primary-button compact" @click="resumeQueue">继续</button>
            <button class="danger-button" @click="cancelQueue">取消队列</button>
          </div>
          <button v-if="queueRunning" class="secondary-button skip-button" @click="skipCurrentTask">跳过当前文件，继续下一项</button>
          <button v-if="queueRunning" class="force-button" @click="forceStopQueue">长时间无响应？强制停止</button>
          <div class="export-options">
            <span>导出格式</span>
            <label><input v-model="exportTxt" type="checkbox" />TXT</label>
            <label><input v-model="exportXlsx" type="checkbox" />XLSX</label>
            <label><input v-model="exportHtml" type="checkbox" />HTML</label>
          </div>
          <details class="export-settings">
            <summary>导出规则 · 预计 {{ exportEstimate }} 个文件</summary>
            <label>文件组织<select v-model="exportGrouping" :disabled="exportBusy"><option value="separate">分别导出（同批图片表格合为一份）</option><option value="combined">全部合并为一份 / 每种格式</option></select></label>
            <label>同名文件<select v-model="exportCollision" :disabled="exportBusy"><option value="rename">自动编号，不覆盖</option><option value="skip">跳过已有文件</option><option value="overwrite">覆盖（导出前再次确认）</option></select></label>
            <label v-if="exportGrouping === 'combined'">合并文件名<input v-model="exportName" :disabled="exportBusy" maxlength="100" /></label>
            <label>文件名前缀<input v-model="exportPrefix" :disabled="exportBusy" placeholder="例如 {date}_" maxlength="100" /></label>
            <label>文件名后缀<input v-model="exportSuffix" :disabled="exportBusy" placeholder="例如 _{profile}_{mode}" maxlength="100" /></label>
            <p>支持 {date} 日期、{profile} 档位、{mode} 模式。未识别到表格的任务不生成 XLSX/HTML。</p>
          </details>
          <button class="secondary-button export-button" :disabled="!canExportSelectedFormats" @click="exportSelectedFormats">{{ exportBusy ? "正在导出……" : `导出所选格式（${exportEstimate}）` }}</button>
          <p v-if="!exportFormatSelected" class="export-hint">请至少选择一种格式。</p>
          <p v-if="tasks.length" class="pause-note">暂停和普通取消会在当前页识别结束后生效。</p>
        </div>
      </aside>

      <section class="content-grid">
        <article class="panel preview-panel">
          <div class="panel-title"><span>文档预览</span><small>{{ fileName || "尚未选择任务" }}</small></div>
          <div v-if="previewError" class="empty-state"><p>{{ previewError }}</p></div>
          <div v-else-if="previewUrl" class="image-stage"><img :src="previewUrl" :alt="fileName" @error="previewError = '无法显示此图片格式或文件已不可读，仍可尝试识别或查看已保存的结果。'" /></div>
          <div v-else-if="isPdf" class="empty-state pdf-state"><div class="document-icon">PDF</div><p>PDF 已加入队列，将逐页识别</p></div>
          <div v-else class="empty-state"><div class="scan-mark"><i></i><i></i><i></i><i></i></div><p>从左侧添加并选择图片或 PDF</p></div>
        </article>

        <article class="panel result-panel">
          <div class="panel-title">
            <span>{{ resultFocusMode ? fileName || "识别结果" : "识别结果" }}</span>
            <div class="result-actions">
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
            <div class="metrics">
              <div><b>{{ selectedPageCount }} / {{ selectedTotalPageCount }}</b><span>{{ selectedUsesImageBatch ? "同批图片完成 / 总数" : "已完成 / 总页数" }}</span></div>
              <div><b>{{ selectedBlockCount }}</b><span>文本块</span></div>
              <div><b>{{ selectedTables.length }}</b><span>{{ mergeCrossPageTables && selectedRawTableCount > selectedMergedTableCount ? `跨页合并（原 ${selectedRawTableCount}）` : "表格" }}</span></div>
              <div><b>{{ (selectedElapsedMs / 1000).toFixed(2) }}s</b><span>用时</span></div>
            </div>
            <textarea v-if="resultView === 'text'" :value="selectedResult.text" :readonly="exportBusy" spellcheck="false" aria-label="识别文本" @input="updateSelectedText"></textarea>
            <TableResultViewer v-else :tables="selectedTables" :view-key="`${selectedTaskId}:${mergeCrossPageTables}`" />
          </div>
          <div v-else-if="selectedTask?.error" class="empty-state result-empty error-state"><p>{{ selectedTask.error }}</p></div>
          <div v-else class="empty-state result-empty"><p>选择任务后，识别结果将在这里显示并可直接校对</p></div>
        </article>
      </section>
    </section>

    <footer :class="['statusbar', { error: phase === 'error' }]" :title="status">
      <span class="status-dot"></span>
      <div class="status-content">
        <span>{{ status }}</span>
        <small :class="{ 'save-error': saveFailed }">{{ saveFailed ? saveStatus : '● 本机自动保存' }}</small>
        <button v-if="!sidecarReady && !setupBusy" class="text-button" :disabled="queueRunning" @click="restartSidecar">重启识别进程</button>
        <details v-if="phase === 'error' && errorDetails" class="error-details"><summary>查看技术详情</summary><pre>{{ errorDetails }}</pre></details>
      </div>
      <button class="diagnostic-button" @click="copyDiagnostics">复制诊断信息</button>
    </footer>
  </main>
</template>
