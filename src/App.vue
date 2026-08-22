<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ocrSidecar } from "./lib/sidecar";
import type { OcrResult, SidecarEvent } from "./lib/types";

type AppPhase = "starting" | "idle" | "preparing" | "recognizing" | "error";

const phase = ref<AppPhase>("starting");
const status = ref("正在启动本地识别进程……");
const selectedPath = ref("");
const result = ref<OcrResult | null>(null);
const scoreThreshold = ref(0.5);
const modelsReady = ref(false);
const sidecarReady = ref(false);

const fileName = computed(() => selectedPath.value.split(/[\\/]/).pop() ?? "");
const extension = computed(() => fileName.value.split(".").pop()?.toLowerCase() ?? "");
const isPdf = computed(() => extension.value === "pdf");
const previewUrl = computed(() =>
  selectedPath.value && !isPdf.value ? convertFileSrc(selectedPath.value) : ""
);
const busy = computed(() => ["starting", "preparing", "recognizing"].includes(phase.value));
const averageScore = computed(() => {
  const scores = result.value?.pages.flatMap((page) => page.blocks.map((block) => block.score)) ?? [];
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
});

onMounted(async () => {
  await startSidecar();
});

onBeforeUnmount(() => {
  void ocrSidecar.stop();
});

async function chooseFile(): Promise<void> {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "图片或 PDF", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "pdf"] }
    ]
  });
  if (typeof selected !== "string") return;
  selectedPath.value = selected;
  result.value = null;
  status.value = `已选择 ${selected.split(/[\\/]/).pop()}`;
}

function updateStatus(event: SidecarEvent): void {
  if (event.message) status.value = event.message;
}

async function startSidecar(): Promise<boolean> {
  phase.value = "starting";
  status.value = "正在启动本地识别进程，首次启动可能需要等待安全软件扫描……";
  try {
    await ocrSidecar.start();
    sidecarReady.value = true;
    phase.value = "idle";
    status.value = "识别进程已就绪，请准备模型或选择图片、PDF";
    return true;
  } catch (error) {
    sidecarReady.value = false;
    showError(error);
    return false;
  }
}

async function prepareModels(): Promise<void> {
  if (!ocrSidecar.running) {
    sidecarReady.value = false;
    if (!(await startSidecar())) return;
  }

  phase.value = "preparing";
  status.value = "正在准备 PP-OCRv5 模型，首次运行可能需要下载……";
  try {
    await ocrSidecar.request("prepare", {}, updateStatus);
    modelsReady.value = true;
    phase.value = "idle";
    status.value = "模型已下载并载入；识别文档时将禁用网络连接";
  } catch (error) {
    sidecarReady.value = ocrSidecar.running;
    showError(error);
  }
}

async function recognize(): Promise<void> {
  if (!selectedPath.value) return;
  if (!modelsReady.value) {
    await prepareModels();
    if (!modelsReady.value) return;
  }

  phase.value = "recognizing";
  result.value = null;
  status.value = "正在本机识别；当前阶段已封锁 Python 网络访问……";
  try {
    result.value = await ocrSidecar.request<OcrResult>(
      "recognize",
      { path: selectedPath.value, scoreThreshold: scoreThreshold.value },
      updateStatus
    );
    phase.value = "idle";
    status.value = `完成：${result.value.pageCount} 页，${result.value.blockCount} 个文本块`;
  } catch (error) {
    showError(error);
  }
}

async function copyText(): Promise<void> {
  if (!result.value?.text) return;
  await navigator.clipboard.writeText(result.value.text);
  status.value = "识别文本已复制到剪贴板";
}

function showError(error: unknown): void {
  phase.value = "error";
  status.value = error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">LOCAL DOCUMENT TOOL</p>
        <h1>本地 OCR</h1>
      </div>
      <div class="privacy-badge"><span></span>文档仅在本机处理</div>
    </header>

    <section class="workspace">
      <aside class="sidebar">
        <div class="step-card">
          <div class="step-heading"><b>01</b><span>准备识别模型</span></div>
          <p>模型允许联网下载；下载后保存在本机，识别阶段会禁用 Python 网络连接。</p>
          <p v-if="phase === 'error' && !sidecarReady" class="error-help">
            识别进程没有启动。请点击下方按钮重试；如果仍然失败，请保留窗口底部显示的完整错误。
          </p>
          <button class="secondary-button" :disabled="busy" @click="prepareModels">
            {{ !sidecarReady ? "启动并准备模型" : modelsReady ? "重新载入模型" : "准备模型" }}
          </button>
        </div>

        <div class="step-card">
          <div class="step-heading"><b>02</b><span>选择本地文档</span></div>
          <button class="file-picker" :disabled="busy" @click="chooseFile">
            <span class="plus">＋</span>
            <span>{{ fileName || "选择图片或 PDF" }}</span>
          </button>
          <p v-if="selectedPath" class="path" :title="selectedPath">{{ selectedPath }}</p>
        </div>

        <div class="step-card settings-card">
          <div class="step-heading"><b>03</b><span>识别设置</span></div>
          <label for="threshold">
            <span>最低置信度</span>
            <strong>{{ scoreThreshold.toFixed(2) }}</strong>
          </label>
          <input id="threshold" v-model.number="scoreThreshold" type="range" min="0" max="1" step="0.05" />
          <button class="primary-button" :disabled="busy || !selectedPath" @click="recognize">
            <span v-if="phase === 'recognizing'" class="spinner"></span>
            {{ phase === "recognizing" ? "正在识别" : "开始本地识别" }}
          </button>
        </div>
      </aside>

      <section class="content-grid">
        <article class="panel preview-panel">
          <div class="panel-title">
            <span>文档预览</span><small>{{ fileName || "尚未选择" }}</small>
          </div>
          <div v-if="previewUrl" class="image-stage"><img :src="previewUrl" :alt="fileName" /></div>
          <div v-else-if="isPdf" class="empty-state pdf-state">
            <div class="document-icon">PDF</div><p>PDF 已就绪，将逐页识别</p>
          </div>
          <div v-else class="empty-state">
            <div class="scan-mark"><i></i><i></i><i></i><i></i></div>
            <p>选择一份图片或 PDF 开始</p>
          </div>
        </article>

        <article class="panel result-panel">
          <div class="panel-title">
            <span>识别结果</span>
            <button class="text-button" :disabled="!result?.text" @click="copyText">复制全文</button>
          </div>
          <div v-if="result" class="result-body">
            <div class="metrics">
              <div><b>{{ result.pageCount }}</b><span>页数</span></div>
              <div><b>{{ result.blockCount }}</b><span>文本块</span></div>
              <div><b>{{ averageScore === null ? "—" : `${(averageScore * 100).toFixed(1)}%` }}</b><span>平均置信度</span></div>
              <div><b>{{ (result.elapsedMs / 1000).toFixed(2) }}s</b><span>用时</span></div>
            </div>
            <textarea v-model="result.text" spellcheck="false" aria-label="识别文本"></textarea>
          </div>
          <div v-else class="empty-state result-empty"><p>识别结果将在这里显示，并可直接校对</p></div>
        </article>
      </section>
    </section>

    <footer :class="['statusbar', { error: phase === 'error' }]" :title="status">
      <span class="status-dot"></span><span>{{ status }}</span>
    </footer>
  </main>
</template>
