// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import type { OcrResult } from "./lib/types";
import { defaultSettings } from "./lib/session";

const mock = vi.hoisted(() => ({
  running: true,
  saved: null as unknown,
  load: vi.fn(), save: vi.fn(), request: vi.fn(), open: vi.fn(),
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
    start: async () => { mock.running = true; }, stop: async () => {}, forceStop: async () => { mock.running = false; },
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
  mock.load.mockResolvedValue(null);
  mock.save.mockResolvedValue(undefined);
  mock.open.mockResolvedValue(["/one.png", "/two.png"]);
  window.confirm = vi.fn(() => true);
  mock.request.mockImplementation(async (method, params, onEvent) => {
    if (method === "recognize") return new Promise((resolve, reject) => mock.jobs.push({ resolve, reject, onEvent }));
    if (method === "validate_paths") return { items: params.items.map((item: { id: string }) => ({ id: item.id, exists: true })) };
    if (method === "ui_smoke_status") return { enabled: false };
    if (method === "model_status") return null;
    if (method === "cancel") { mock.jobs[mock.jobs.length - 1]?.resolve(result("部分结果", true)); return {}; }
    return {};
  });
});

afterEach(() => { wrapper?.unmount(); wrapper = null; vi.restoreAllMocks(); });

describe("batch and recovery interactions", () => {
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
