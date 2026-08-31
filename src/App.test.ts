// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import type { OcrResult } from "./lib/types";
import { defaultSettings } from "./lib/session";

const mock = vi.hoisted(() => ({
  running: true,
  saved: null as unknown,
  load: vi.fn(), save: vi.fn(), request: vi.fn(), open: vi.fn(), forceStop: vi.fn(),
  jobs: [] as Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void; onEvent?: (value: unknown) => void }>,
  exit: null as (() => void) | null,
  dropped: null as ((paths: string[]) => void) | null,
  counter: 0
}));

vi.mock("./lib/session", async (original) => ({ ...(await original<object>()), loadSession: mock.load, saveSession: mock.save }));
vi.mock("./lib/tauri-bridge", () => ({
  createId: () => `id-${++mock.counter}`, localImagePreview: vi.fn(async () => ""), isWebkitGtk40Build: false,
  openLocalDialog: mock.open,
  listenFileDrop: async (callback: (paths: string[]) => void) => { mock.dropped = callback; return () => {}; },
  listenBeforeClose: async () => () => {}
}));
vi.mock("./lib/sidecar", () => ({
  SidecarRequestError: class extends Error {},
  ocrSidecar: {
    get running() { return mock.running; }, stderr: "",
    start: async () => { mock.running = true; }, stop: async () => {}, forceStop: mock.forceStop,
    onExit: (callback: () => void) => { mock.exit = callback; return () => {}; },
    request: mock.request
  }
}));

function result(text: string, cancelled = false): OcrResult {
  return { path: "/one.png", text, profile: "fast", resultType: "text", cancelled,
    pageCount: 1, totalPageCount: 1, blockCount: 1, rawTableCount: 0, tableCount: 0, elapsedMs: 1,
    pages: [{ pageIndex: 0, text, blocks: [], tables: [] }], tables: [] };
}

let wrapper: VueWrapper | null = null;
function button(text: string) {
  const found = wrapper!.findAll("button").find((item) => item.text().includes(text));
  if (!found) throw new Error(`missing button: ${text}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.jobs = []; mock.running = true; mock.counter = 0;
  mock.forceStop.mockImplementation(async () => { mock.running = false; });
  mock.load.mockResolvedValue(null);
  mock.save.mockResolvedValue(undefined);
  mock.open.mockResolvedValue(["/one.png", "/two.png"]);
  window.confirm = vi.fn(() => true);
  mock.request.mockImplementation(async (method, params, onEvent) => {
    if (method === "recognize") return new Promise((resolve, reject) => mock.jobs.push({ resolve, reject, onEvent }));
    if (method === "validate_paths") return { items: params.items.map((item: { id: string }) => ({ id: item.id, exists: true })) };
    if (method === "ui_smoke_status") return { enabled: false };
    if (method === "model_status") return null;
    if (method === "document_info") return { totalPageCount: 10, selectedPageCount: params.pageRange ? 3 : 10 };
    if (method === "cancel") { mock.jobs[mock.jobs.length - 1]?.resolve(result("部分结果", true)); return {}; }
    return {};
  });
});

afterEach(() => { wrapper?.unmount(); wrapper = null; vi.restoreAllMocks(); });

describe("batch and recovery interactions", () => {
  it("applies PDF page ranges per task and passes them to recognition", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/document.pdf"]); await flushPromises();
    await wrapper.find(".document-controls select").setValue("custom");
    await wrapper.find('[aria-label="指定 PDF 页码"]').setValue("2,4-5");
    await button("应用页码").trigger("click"); await flushPromises();
    expect(wrapper.find(".task-main").text()).toContain("2,4-5");
    await button("开始批量").trigger("click"); await flushPromises();
    expect(mock.request.mock.calls.find(call => call[0] === "recognize")?.[1].pageRange).toBe("2,4-5");
    mock.jobs[0].onEvent!({ event: "source_page", page: 4, pageCount: 3, message: "正在识别原文第 4 页" });
    await flushPromises();
    expect(wrapper.find(".task-main").text()).toContain("原文第 4 页");
    expect(wrapper.find(".task-main").text()).toContain("0/3");
    mock.jobs[0].resolve(result("完成")); await flushPromises();
  });

  it("rotates checked images without applying rotation to PDFs", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/one.png", "/two.png", "/doc.pdf"]); await flushPromises();
    await button("右转 90°").trigger("click");
    await button("全选 / 取消").trigger("click");
    await button("应用角度到勾选图片").trigger("click");
    expect(wrapper.findAll(".task-main").filter(item => item.text().includes("90°"))).toHaveLength(2);
    await button("开始批量").trigger("click"); await flushPromises();
    expect(mock.request.mock.calls.find(call => call[0] === "recognize")?.[1].rotation).toBe(90);
    mock.jobs[0].resolve(result("一")); await flushPromises();
    mock.jobs[1].resolve(result("二")); await flushPromises();
    mock.jobs[2].resolve(result("三")); await flushPromises();
  });

  it("enables local-only preparation after model import", async () => {
    wrapper = mount(App); await flushPromises();
    mock.open.mockResolvedValue("/usb/LocalOCR-models");
    const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation((method, params, onEvent) => method === "import_model_pack"
      ? Promise.resolve({ path: "/cache", modelCount: 2, capabilities: [{ profile: "accurate", mode: "text" }] })
      : original(method, params, onEvent));
    await button("从本地导入模型").trigger("click"); await flushPromises();
    expect(wrapper.find<HTMLInputElement>(".local-only-setting input").element.checked).toBe(true);
    expect(wrapper.find<HTMLInputElement>('input[value="accurate"]').element.checked).toBe(true);
    await button("准备当前模型").trigger("click"); await flushPromises();
    expect(mock.request.mock.calls.find(call => call[0] === "prepare")?.[1].localOnly).toBe(true);
  });

  it("does not overwrite previous corrections when rerun fails before its first page", async () => {
    mock.load.mockResolvedValue({ schema: 1, selectedTaskId: "old", settings: defaultSettings,
      tasks: [{ id: "old", batchId: "old", batchIndex: 0, path: "/old.png", fileName: "old.png", status: "completed", resultType: "text", result: result("历史校对"), textEdited: true }] });
    wrapper = mount(App); await flushPromises();
    await button("重新识别当前文件").trigger("click");
    window.confirm = vi.fn(() => false);
    await button("开始批量").trigger("click"); await flushPromises();
    expect(mock.jobs).toHaveLength(0);
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.value).toBe("历史校对");
    window.confirm = vi.fn(() => true);
    await button("开始批量").trigger("click"); await flushPromises();
    mock.jobs[0].reject(new Error("model failed")); await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.value).toBe("历史校对");
  });

  it("shows autosave in the header without duplicating it in the footer", async () => {
    wrapper = mount(App); await flushPromises();
    expect(wrapper.find(".save-badge").text()).toBe("自动保存已启用");
    expect(wrapper.find(".status-content small").exists()).toBe(false);
  });

  it("restarts the sidecar before switching an already-loaded native model", async () => {
    wrapper = mount(App); await flushPromises();
    await button("准备当前模型").trigger("click"); await flushPromises();
    expect(mock.forceStop).not.toHaveBeenCalled();
    await wrapper.find<HTMLInputElement>('input[value="table"]').setValue(true); await flushPromises();
    await button("准备当前模型").trigger("click"); await flushPromises();
    expect(mock.forceStop).toHaveBeenCalledOnce();
    expect(mock.running).toBe(true);
  });

  it("locks model controls and prevents duplicate starts during file preflight", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/document.pdf"]); await flushPromises();
    const original = mock.request.getMockImplementation()!;
    let release!: () => void;
    mock.request.mockImplementation((method, params, onEvent) => method === "validate_paths"
      ? new Promise((resolve) => { release = () => resolve({ items: params.items.map((item: {id: string}) => ({...item, exists:true})) }); })
      : original(method, params, onEvent));
    await button("开始批量").trigger("click"); await flushPromises();
    expect(wrapper.find<HTMLInputElement>('input[value="accurate"]').element.disabled).toBe(true);
    expect(button("准备当前模型").attributes("disabled")).toBeDefined();
    await button("开始批量").trigger("click"); await flushPromises();
    expect(mock.jobs).toHaveLength(0);
    release(); await flushPromises();
    expect(mock.jobs).toHaveLength(1);
    mock.jobs[0].resolve(result("完成")); await flushPromises();
    expect(wrapper.find<HTMLInputElement>('input[value="accurate"]').element.disabled).toBe(false);
  });

  it("appends later PDF pages without losing the edited first page", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/document.pdf"]); await flushPromises();
    await button("开始批量").trigger("click"); await flushPromises();
    mock.jobs[0].onEvent!({ event: "page_result", pageCount: 2, elapsedMs: 10,
      pageResult: {pageIndex: 0, text: "原第一段", blocks: [], tables: []} });
    await flushPromises();
    await wrapper.find("textarea").setValue("校对第一段");
    mock.jobs[0].onEvent!({ event: "page_result", pageCount: 2, elapsedMs: 20,
      pageResult: {pageIndex: 1, text: "新增第二段", blocks: [], tables: []} });
    await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.value).toBe("校对第一段\n\n新增第二段");
    mock.jobs[0].resolve(result("原第一段\n\n新增第二段")); await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.value).toBe("校对第一段\n\n新增第二段");
  });

  it("does not select the next completed task or overwrite a correction on another task", async () => {
    wrapper = mount(App); await flushPromises();
    await button("添加图片").trigger("click"); await flushPromises();
    await button("开始批量").trigger("click"); await flushPromises();
    expect(mock.jobs).toHaveLength(1);
    mock.jobs[0].resolve(result("第一页")); await flushPromises();
    expect(mock.jobs).toHaveLength(2);
    await wrapper.find("textarea").setValue("已校对的第一页");
    mock.jobs[1].resolve(result("第二页")); await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.value).toBe("已校对的第一页");
    expect(wrapper.find(".task-item.selected .task-name").text()).toBe("one.png");
    expect(mock.save).toHaveBeenCalled();
    const saved = mock.save.mock.calls.at(-1)![0];
    expect(saved.tasks[0].result.text).toBe("已校对的第一页");
  });

  it("skips the current file but continues the queue", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/one.png", "/two.png", "/unsupported.docx"]); await flushPromises();
    expect(wrapper.findAll(".task-item")).toHaveLength(2);
    await button("开始批量").trigger("click"); await flushPromises();
    await button("跳过当前文件").trigger("click"); await flushPromises();
    expect(mock.jobs).toHaveLength(2);
    expect(wrapper.findAll(".task-item")[0].classes()).toContain("cancelled");
    mock.jobs[1].resolve(result("后一项")); await flushPromises();
    expect(wrapper.findAll(".task-item")[1].classes()).toContain("completed");
  });

  it("restores settings and saved text without automatically recognizing", async () => {
    mock.load.mockResolvedValue({ schema: 1, selectedTaskId: "old", settings: { ...defaultSettings, profile: "accurate" },
      tasks: [{ id: "old", batchId: "old", batchIndex: 0, path: "/old.png", fileName: "old.png", status: "completed", resultType: "text", result: result("历史校对") }] });
    wrapper = mount(App); await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.value).toBe("历史校对");
    expect(wrapper.find<HTMLInputElement>('input[value="accurate"]').element.checked).toBe(true);
    expect(mock.jobs).toHaveLength(0);
    mock.running = false; mock.exit!(); await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.value).toBe("历史校对");
    expect(wrapper.text()).toContain("重启识别进程");
  });

  it("updates queue order before recognition and supports multi-removal", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/one.png", "/two.png"]); await flushPromises();
    await wrapper.findAll(".task-item")[1].find('[aria-label="上移任务"]').trigger("click");
    expect(wrapper.findAll(".task-name")[0].text()).toBe("two.png");
    await button("全选 / 取消").trigger("click");
    await button("移除勾选").trigger("click");
    expect(wrapper.findAll(".task-item")).toHaveLength(0);
  });
});
