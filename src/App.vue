<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ocrSidecar } from "./lib/sidecar";
import { convertLocalFileSrc, createId, isWebkitGtk40Build, openLocalDialog } from "./lib/tauri-bridge";
import type { ModelProfile, OcrResult, OcrTask, OcrTaskStatus, SidecarEvent } from "./lib/types";

type AppPhase = "starting" | "idle" | "preparing" | "recognizing" | "paused" | "error";

const phase = ref<AppPhase>("starting");
const status = ref("正在启动本地识别进程……");
const tasks = ref<OcrTask[]>([]);
const selectedTaskId = ref("");
const scoreThreshold = ref(0.5);
const modelProfile = ref<ModelProfile>("fast");
const preparedProfile = ref<ModelProfile | null>(null);
const sidecarReady = ref(false);
const queueRunning = ref(false);
const queuePaused = ref(false);
const stopRequested = ref(false);

const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskId.value) ?? null);
const selectedResult = computed(() => selectedTask.value?.result ?? null);
const selectedPath = computed(() => selectedTask.value?.path ?? "");
const fileName = computed(() => selectedTask.value?.fileName ?? "");
const extension = computed(() => fileName.value.split(".").pop()?.toLowerCase() ?? "");
const isPdf = computed(() => extension.value === "pdf");
const previewUrl = computed(() => selectedPath.value && !isPdf.value ? convertLocalFileSrc(selectedPath.value) : "");
const modelsReady = computed(() => preparedProfile.value === modelProfile.value);
const setupBusy = computed(() => phase.value === "starting" || phase.value === "preparing");
const queuedCount = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const completedCount = computed(() => tasks.value.filter((task) => task.status === "completed").length);
const exportableTasks = computed(() => tasks.value.filter((task) => task.status === "completed" && task.result));
const averageScore = computed(() => {
  const scores = selectedResult.value?.pages.flatMap((page) => page.blocks.map((block) => block.score)) ?? [];
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
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
  await startSidecar();
});

onBeforeUnmount(() => {
  void ocrSidecar.stop();
});

async function chooseFiles(): Promise<void> {
  const selected = await openLocalDialog({
    multiple: true,
    filters: [
      { name: "图片或 PDF", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "pdf"] }
    ]
  });
  const paths = typeof selected === "string" ? [selected] : selected;
  if (!paths?.length) return;

  const existing = new Set(tasks.value.map((task) => task.path.toLowerCase()));
  const additions: OcrTask[] = [];
  for (const path of paths) {
    if (existing.has(path.toLowerCase())) continue;
    existing.add(path.toLowerCase());
    additions.push({
      id: createId(),
      path,
      fileName: path.split(/[\\/]/).pop() ?? path,
      status: "queued",
      resultType: "text"
    });
  }
  tasks.value.push(...additions);
  if (additions.length) selectedTaskId.value = additions[0].id;
  status.value = additions.length
    ? `已添加 ${additions.length} 个文件，队列共 ${tasks.value.length} 个`
    : "所选文件已经在任务队列中";
}

function removeTask(task: OcrTask): void {
  if (task.status === "running" || task.status === "paused") return;
  tasks.value = tasks.value.filter((item) => item.id !== task.id);
  if (selectedTaskId.value === task.id) selectedTaskId.value = tasks.value[0]?.id ?? "";
}

function clearFinished(): void {
  const removable = new Set<OcrTaskStatus>(["completed", "failed", "cancelled"]);
  tasks.value = tasks.value.filter((task) => !removable.has(task.status));
  if (!tasks.value.some((task) => task.id === selectedTaskId.value)) {
    selectedTaskId.value = tasks.value[0]?.id ?? "";
  }
}

function retryTask(task: OcrTask): void {
  if (task.status !== "failed" && task.status !== "cancelled") return;
  task.status = "queued";
  task.error = undefined;
  task.currentPage = undefined;
  task.totalPages = undefined;
  task.result = undefined;
  status.value = `${task.fileName} 已重新加入队列`;
}

async function startSidecar(): Promise<boolean> {
  phase.value = "starting";
  status.value = "正在启动本地识别进程，首次启动可能需要等待安全软件扫描……";
  try {
    await ocrSidecar.start();
    sidecarReady.value = true;
    phase.value = "idle";
    status.value = "识别进程已就绪，请选择模型并添加图片、PDF";
    return true;
  } catch (error) {
    sidecarReady.value = false;
    showError(error);
    return false;
  }
}

async function prepareModels(): Promise<boolean> {
  if (queueRunning.value) return false;
  if (!ocrSidecar.running) {
    sidecarReady.value = false;
    if (!(await startSidecar())) return false;
  }

  phase.value = "preparing";
  const label = modelProfile.value === "fast" ? "轻量" : "高精度";
  status.value = `正在准备 PP-OCRv5 ${label}模型，首次运行可能需要下载……`;
  try {
    await ocrSidecar.request("prepare", { profile: modelProfile.value }, updateGlobalStatus, 30 * 60_000);
    preparedProfile.value = modelProfile.value;
    phase.value = "idle";
    status.value = `${label}模型已载入；识别期间将禁用 Python 网络连接`;
    return true;
  } catch (error) {
    sidecarReady.value = ocrSidecar.running;
    showError(error);
    return false;
  }
}

function modelChanged(): void {
  if (!modelsReady.value) status.value = "模型档位已切换，开始识别时将准备对应模型";
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
  if (queueRunning.value || !queuedCount.value) return;
  if (!modelsReady.value && !(await prepareModels())) return;

  queueRunning.value = true;
  queuePaused.value = false;
  stopRequested.value = false;
  phase.value = "recognizing";

  try {
    while (!stopRequested.value) {
      const task = tasks.value.find((item) => item.status === "queued");
      if (!task) break;
      task.status = "running";
      task.error = undefined;
      selectedTaskId.value = task.id;
      status.value = `正在识别 ${completedCount.value + 1}/${tasks.value.length}：${task.fileName}`;

      try {
        const result = await ocrSidecar.request<OcrResult>(
          "recognize",
          { path: task.path, scoreThreshold: scoreThreshold.value },
          (event) => updateTaskStatus(task, event),
          null
        );
        task.result = result;
        task.currentPage = result.pageCount;
        task.totalPages = result.totalPageCount;
        task.status = result.cancelled ? "cancelled" : "completed";
      } catch (error) {
        task.status = stopRequested.value ? "cancelled" : "failed";
        task.error = error instanceof Error ? error.message : String(error);
        if (!ocrSidecar.running) {
          sidecarReady.value = false;
          preparedProfile.value = null;
          throw error;
        }
      }

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
    queueRunning.value = false;
    if (String(phase.value) !== "error") phase.value = queuePaused.value ? "paused" : "idle";
  }
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
  status.value = "识别进程已强制停止；下次识别会重新启动并载入模型";
  phase.value = "idle";
}

async function exportAllText(): Promise<void> {
  if (!exportableTasks.value.length) return;
  const directory = await openLocalDialog({ directory: true, multiple: false, title: "选择 TXT 导出文件夹" });
  if (typeof directory !== "string") return;
  if (!ocrSidecar.running && !(await startSidecar())) return;
  try {
    const response = await ocrSidecar.request<{ count: number }>(
      "export_texts",
      {
        directory,
        items: exportableTasks.value.map((task) => ({ fileName: task.fileName, text: task.result?.text ?? "" }))
      },
      undefined,
      60_000
    );
    status.value = `已导出 ${response.count} 个 TXT 文件到 ${directory}`;
  } catch (error) {
    showError(error);
  }
}

async function copyText(): Promise<void> {
  if (!selectedResult.value?.text) return;
  await navigator.clipboard.writeText(selectedResult.value.text);
  status.value = `${fileName.value} 的识别文本已复制到剪贴板`;
}

function updateSelectedText(event: Event): void {
  if (selectedTask.value?.result) selectedTask.value.result.text = (event.target as HTMLTextAreaElement).value;
}

function showError(error: unknown): void {
  phase.value = "error";
  status.value = error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <main class="app-shell">
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
          <div class="step-heading"><b>01</b><span>选择识别模型</span></div>
          <div class="model-options">
            <label :class="{ selected: modelProfile === 'fast' }">
              <input v-model="modelProfile" type="radio" value="fast" :disabled="queueRunning" @change="modelChanged" />
              <span><strong>快速</strong><small>轻量模型，适合批量普通文档</small></span>
            </label>
            <label :class="{ selected: modelProfile === 'accurate' }">
              <input v-model="modelProfile" type="radio" value="accurate" :disabled="queueRunning" @change="modelChanged" />
              <span><strong>高精度</strong><small>更大更慢，适合小字和复杂背景</small></span>
            </label>
          </div>
          <p v-if="phase === 'error' && !sidecarReady" class="error-help">识别进程没有启动，请重试并保留底部错误。</p>
          <button class="secondary-button" :disabled="setupBusy || queueRunning" @click="prepareModels">
            {{ !sidecarReady ? "启动并准备模型" : modelsReady ? "重新载入当前模型" : "准备当前模型" }}
          </button>
        </div>

        <div class="step-card queue-card">
          <div class="step-heading"><b>02</b><span>批量任务</span></div>
          <button class="file-picker" :disabled="setupBusy" @click="chooseFiles"><span class="plus">＋</span><span>添加图片或 PDF</span></button>
          <div v-if="tasks.length" class="queue-toolbar"><span>{{ queuedCount }} 个等待</span><button :disabled="queueRunning" @click="clearFinished">清理已结束</button></div>
          <div v-if="tasks.length" class="task-list">
            <div v-for="task in tasks" :key="task.id" :class="['task-item', task.status, { selected: task.id === selectedTaskId }]" role="button" tabindex="0" @click="selectedTaskId = task.id" @keydown.enter="selectedTaskId = task.id">
              <div class="task-main">
                <span class="task-name" :title="task.path">{{ task.fileName }}</span>
                <small v-if="task.totalPages">
                  <template v-if="task.status === 'running'">正在处理第 {{ Math.min((task.currentPage ?? 0) + 1, task.totalPages) }}/{{ task.totalPages }} 页</template>
                  <template v-else>已完成 {{ task.currentPage ?? 0 }}/{{ task.totalPages }} 页</template>
                  <span v-if="task.status === 'running' || task.status === 'paused'"> · {{ Math.round(((task.currentPage ?? 0) / task.totalPages) * 100) }}%</span>
                </small>
              </div>
              <span class="task-status">{{ statusLabels[task.status] }}</span>
              <div class="task-actions">
                <button v-if="task.status === 'failed' || task.status === 'cancelled'" @click.stop="retryTask(task)">重试</button>
                <button v-if="task.status !== 'running' && task.status !== 'paused'" @click.stop="removeTask(task)">移除</button>
              </div>
              <progress v-if="task.totalPages && (task.status === 'running' || task.status === 'paused')" class="task-progress" :value="task.currentPage ?? 0" :max="task.totalPages"></progress>
            </div>
          </div>
          <p v-else class="queue-empty">可以一次选择多个文件，程序会顺序识别。</p>
        </div>

        <div class="step-card settings-card">
          <div class="step-heading"><b>03</b><span>识别与导出</span></div>
          <label for="threshold"><span>最低置信度</span><strong>{{ scoreThreshold.toFixed(2) }}</strong></label>
          <input id="threshold" v-model.number="scoreThreshold" type="range" min="0" max="1" step="0.05" :disabled="queueRunning" />
          <button v-if="!queueRunning && !queuePaused" class="primary-button" :disabled="setupBusy || !queuedCount" @click="runQueue">开始批量识别</button>
          <div v-else class="control-grid">
            <button v-if="!queuePaused" class="secondary-button" @click="pauseQueue">暂停</button>
            <button v-else class="primary-button compact" @click="resumeQueue">继续</button>
            <button class="danger-button" @click="cancelQueue">取消队列</button>
          </div>
          <button v-if="queueRunning" class="force-button" @click="forceStopQueue">长时间无响应？强制停止</button>
          <button class="secondary-button export-button" :disabled="!exportableTasks.length || queueRunning" @click="exportAllText">导出全部 TXT</button>
          <p class="pause-note">暂停和普通取消会在当前页识别结束后生效。</p>
        </div>
      </aside>

      <section class="content-grid">
        <article class="panel preview-panel">
          <div class="panel-title"><span>文档预览</span><small>{{ fileName || "尚未选择任务" }}</small></div>
          <div v-if="previewUrl" class="image-stage"><img :src="previewUrl" :alt="fileName" /></div>
          <div v-else-if="isPdf" class="empty-state pdf-state"><div class="document-icon">PDF</div><p>PDF 已加入队列，将逐页识别</p></div>
          <div v-else class="empty-state"><div class="scan-mark"><i></i><i></i><i></i><i></i></div><p>从左侧添加并选择图片或 PDF</p></div>
        </article>

        <article class="panel result-panel">
          <div class="panel-title"><span>识别结果</span><button class="text-button" :disabled="!selectedResult?.text" @click="copyText">复制全文</button></div>
          <div v-if="selectedResult" class="result-body">
            <div class="metrics">
              <div><b>{{ selectedResult.pageCount }} / {{ selectedResult.totalPageCount }}</b><span>已完成 / 总页数</span></div>
              <div><b>{{ selectedResult.blockCount }}</b><span>文本块</span></div>
              <div><b>{{ averageScore === null ? "—" : `${(averageScore * 100).toFixed(1)}%` }}</b><span>平均置信度</span></div>
              <div><b>{{ (selectedResult.elapsedMs / 1000).toFixed(2) }}s</b><span>用时</span></div>
            </div>
            <textarea :value="selectedResult.text" spellcheck="false" aria-label="识别文本" @input="updateSelectedText"></textarea>
          </div>
          <div v-else-if="selectedTask?.error" class="empty-state result-empty error-state"><p>{{ selectedTask.error }}</p></div>
          <div v-else class="empty-state result-empty"><p>选择任务后，识别结果将在这里显示并可直接校对</p></div>
        </article>
      </section>
    </section>

    <footer :class="['statusbar', { error: phase === 'error' }]" :title="status"><span class="status-dot"></span><span>{{ status }}</span></footer>
  </main>
</template>
