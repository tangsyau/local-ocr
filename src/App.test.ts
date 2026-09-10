// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import {SidecarRequestError} from "./lib/sidecar";
import type { OcrResult } from "./lib/types";
import { defaultSettings } from "./lib/session";

const mock = vi.hoisted(() => ({
  running: true,
  saved: null as unknown,
  load: vi.fn(), save: vi.fn(), listHistory: vi.fn(), readHistory: vi.fn(), deleteHistory: vi.fn(), request: vi.fn(), open: vi.fn(), forceStop: vi.fn(),
  jobs: [] as Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void; onEvent?: (value: unknown) => void }>,
  exit: null as (() => void) | null,
  dropped: null as ((paths: string[]) => void) | null,
  counter: 0
}));

vi.mock("./lib/session", async (original) => ({ ...(await original<object>()), loadSession: mock.load, saveSession: mock.save, listHistory: mock.listHistory, readHistory: mock.readHistory, deleteHistory: mock.deleteHistory }));
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
  mock.listHistory.mockResolvedValue([]);
  mock.save.mockResolvedValue(undefined);
  mock.open.mockResolvedValue(["/one.png", "/two.png"]);
  window.confirm = vi.fn(() => true);
  mock.request.mockImplementation(async (method, params, onEvent) => {
    if (method === "recognize") return new Promise((resolve, reject) => mock.jobs.push({ resolve, reject, onEvent }));
    if (method === "validate_paths") return { items: params.items.map((item: { id: string }) => ({ id: item.id, exists: true, sourceSize: 100, sourceMtimeNs: "200" })) };
    if (method === "ui_smoke_status") return { enabled: false };
    if (method === "model_status") return null;
    if (method === "document_info") return { totalPageCount: 10, selectedPageCount: params.pageRange ? 3 : 10, sourceSize: 100, sourceMtimeNs: "200" };
    if (method === "cancel") { mock.jobs[mock.jobs.length - 1]?.resolve(result("部分结果", true)); return {}; }
    return {};
  });
});

afterEach(() => { wrapper?.unmount(); wrapper = null; vi.restoreAllMocks(); });

describe("text projection controls", () => {
  function savedText() {
    const r=result("中文第一行\n继续正文");
    r.pages[0]={...r.pages[0],schemaVersion:1,rawText:r.text,width:600,height:800,source:"pdf-text",
      blocks:[{text:"中文第一行",score:null,box:[20,100,420,120],polygon:[],fontSize:20,direction:"horizontal"},
              {text:"继续正文",score:null,box:[20,126,420,146],polygon:[],fontSize:20,direction:"horizontal"}]};
    mock.load.mockResolvedValue({schema:2,selectedTaskId:"saved",settings:defaultSettings,
      tasks:[{id:"saved",path:"/book.pdf",fileName:"book.pdf",batchId:"saved",batchIndex:0,status:"completed",resultType:"text",result:r}]});
    return r;
  }
  it("shows an aligned document settings panel by default", async () => {
    wrapper = mount(App); await flushPromises();
    const settings = wrapper.find("details.text-settings");
    expect(settings.attributes("open")).toBeDefined();
    expect(settings.findAll(".text-setting-field")).toHaveLength(5);
    expect(settings.findAll(".text-setting-name").map((item) => item.text())).toEqual([
      "PDF 文字来源", "文本整理", "跨页正文", "日语注音", "注音输出"
    ]);
    expect(settings.findAll("select")).toHaveLength(3);
  });
  it("switches original and formatted output without new recognition",async()=>{
    savedText(); wrapper=mount(App); await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.value).toBe("中文第一行继续正文");
    await button("整理前").trigger("click");
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.value).toBe("中文第一行\n继续正文");
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.readOnly).toBe(true);
    expect(mock.request.mock.calls.some(c=>c[0]==="recognize")).toBe(false);
  });
  it("does not overwrite user corrections when formatting changes",async()=>{
    savedText(); wrapper=mount(App); await flushPromises();
    await wrapper.find('[aria-label="识别文本"]').setValue("我手工校对的正文");
    await wrapper.find('[aria-label="文本整理"]').setValue("original");
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.value).toBe("我手工校对的正文");
    await button("恢复自动整理版").trigger("click"); await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.value).toBe("中文第一行\n继续正文");
  });
  it("renders ruby as safe markup and copies parenthetical text",async()=>{
    const r=savedText();
    r.pages[0].blocks[0].ruby=[{start:0,end:2,text:"<よみ>"}];
    wrapper=mount(App); await flushPromises();
    await wrapper.find('[aria-label="识别日语注音"]').setValue(true);
    await wrapper.find('[aria-label="注音输出"]').setValue("ruby");
    expect(wrapper.find("ruby rt").text()).toBe("<よみ>");
    expect(wrapper.find("よみ").exists()).toBe(false);
    const writeText=vi.fn(async()=>{});
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    await button("复制全文").trigger("click"); await flushPromises();
    expect(writeText).toHaveBeenCalledWith("中文（<よみ>）第一行继续正文");
  });
});

describe("batch and recovery interactions", () => {
  it("applies PDF page ranges per task and passes them to recognition", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/document.pdf"]); await flushPromises();
    await wrapper.find('input[value="custom"][name="page-range-mode"]').setValue(true);
    await wrapper.find('[aria-label="指定 PDF 页码"]').setValue("2,4-5");
    await wrapper.find('[aria-label="指定 PDF 页码"]').trigger("change"); await flushPromises();
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
    await wrapper.findAll(".task-item").find((item) => item.text().includes("one.png"))!.trigger("click");
    await button("右转 90°").trigger("click");
    await button("全选 / 取消").trigger("click");
    await button("应用角度到勾选图片").trigger("click");
    expect(wrapper.findAll(".task-main").filter(item => item.text().includes("90°"))).toHaveLength(2);
    await button("开始批量").trigger("click"); await flushPromises();
    expect(mock.request.mock.calls.filter(call => call[0] === "recognize")[0][1].rotation).toBe(0);
    mock.jobs[0].resolve(result("一")); await flushPromises();
    mock.jobs[1].resolve(result("二")); await flushPromises();
    mock.jobs[2].resolve(result("三")); await flushPromises();
    const recognitionCalls = mock.request.mock.calls.filter(call => call[0] === "recognize");
    expect(recognitionCalls.find(call => call[1].path === "/one.png")?.[1].rotation).toBe(90);
    expect(recognitionCalls.find(call => call[1].path === "/doc.pdf")?.[1].rotation).toBe(0);
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
    await button("移除勾选").trigger("click"); await flushPromises();
    expect(wrapper.findAll(".task-item")).toHaveLength(0);
  });

  it("sorts newly added files naturally and offers a queue re-sort", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/scan/page10.png", "/scan/page2.png", "/scan/page1.png"]); await flushPromises();
    expect(wrapper.findAll(".task-name").map((item) => item.text())).toEqual(["page1.png", "page2.png", "page10.png"]);
    await wrapper.findAll(".task-item")[2].find('[aria-label="上移任务"]').trigger("click");
    expect(wrapper.findAll(".task-name").map((item) => item.text())).toEqual(["page1.png", "page10.png", "page2.png"]);
    await button("自然排序").trigger("click");
    expect(wrapper.findAll(".task-name").map((item) => item.text())).toEqual(["page1.png", "page2.png", "page10.png"]);
  });

  it("continues an interrupted PDF from the next saved page", async () => {
    wrapper = mount(App); await flushPromises();
    mock.dropped!(["/document.pdf"]); await flushPromises();
    await button("开始批量").trigger("click"); await flushPromises();
    const first = { pageIndex: 0, text: "第一页", blocks: [], tables: [] };
    mock.jobs[0].onEvent!({ event: "page_result", page: 1, pageCount: 10, elapsedMs: 5, pageResult: first });
    mock.jobs[0].resolve({ ...result("第一页", true), path: "/document.pdf", pageCount: 1, totalPageCount: 10,
      selectedPageCount: 10, completedPageCount: 1, scoreThreshold: .5, sourceSize: 100, sourceMtimeNs: "200", pages: [first] });
    await flushPromises();
    await wrapper.findAll(".task-actions button").find((item) => item.text() === "重试")!.trigger("click");
    await button("开始批量").trigger("click"); await flushPromises();
    const calls = mock.request.mock.calls.filter((call) => call[0] === "recognize");
    expect(calls).toHaveLength(2);
    expect(calls[1][1].completedPages).toEqual([0]);
    expect(wrapper.find(".statusbar").text()).toContain("继续");
    mock.jobs[1].resolve({ ...result("", false), path: "/document.pdf", pageCount: 0, totalPageCount: 10,
      selectedPageCount: 10, completedPageCount: 1, elapsedMs: 1, pages: [] });
    await flushPromises();
  });
});

describe("0.13 state and output regressions", () => {
  function savedTasks() {
    const r = result("第一行\n继续正文");
    r.pages[0] = {...r.pages[0],schemaVersion:1,rawText:r.text,source:"ocr",width:600,height:800,
      blocks:[{text:"第一行",box:[20,100,420,120],polygon:[],fontSize:20,score:.9},
        {text:"继续正文",box:[20,126,420,146],polygon:[],fontSize:20,score:.9}]};
    mock.load.mockResolvedValue({schema:2,selectedTaskId:"a",settings:defaultSettings,tasks:[
      {id:"a",path:"/a.pdf",fileName:"a.pdf",batchId:"a",batchIndex:0,status:"completed",resultType:"text",result:r,revision:1,exportedRevision:1},
      {id:"b",path:"/b.pdf",fileName:"b.pdf",batchId:"b",batchIndex:0,status:"completed",resultType:"text",result:result("第二文件"),revision:1,exportedRevision:1}]});
    const original=mock.request.getMockImplementation()!;
    mock.request.mockImplementation((method, params, event) => method === "export_preview"
      ? Promise.resolve({count:1,skipped:0,overwrites:0,noTableCount:1,files:[{name:"a.txt",action:"write"}]})
      : method === "export_results" ? Promise.resolve({count:1,skipped:0,exportedIds:params.textItems.map((t:any)=>t.id)}) : original(method,params,event));
    return r;
  }
  it("blocks recognition rather than silently using the old range after invalid input", async()=>{
    const original=mock.request.getMockImplementation()!;
    mock.request.mockImplementation((method, params, event)=>method === "document_info" && params.pageRange === "bad"
      ? Promise.reject(Error("页码无效")) : original(method,params,event));
    wrapper=mount(App);await flushPromises();mock.dropped!(["/book.pdf"]);await flushPromises();
    await wrapper.find('[aria-label="指定 PDF 页码"]').setValue("bad");await flushPromises();
    await button("开始批量").trigger("click");await flushPromises();
    expect(mock.jobs).toHaveLength(0);expect(wrapper.find('[role="alert"]').text()).toContain("页码无效");
  });
  it("waits for blur validation when Start is clicked immediately", async()=>{
    const original=mock.request.getMockImplementation()!;
    let done:(value:any)=>void=()=>{};let held=false;
    mock.request.mockImplementation((method,params,event)=>{
      if(method === "document_info" && params.pageRange === "2" && !held){held=true;return new Promise(resolve=>done=resolve);}
      return original(method,params,event);
    });
    wrapper=mount(App);await flushPromises();mock.dropped!(["/book.pdf"]);await flushPromises();
    await wrapper.find('[aria-label="指定 PDF 页码"]').setValue("2");
    await button("开始批量").trigger("click");expect(mock.jobs).toHaveLength(0);
    done({totalPageCount:10,selectedPageCount:1,sourceSize:100,sourceMtimeNs:"200"});await flushPromises();
    expect(mock.request.mock.calls.find(c=>c[0]==="recognize")?.[1].pageRange).toBe("2");
  });
  it("does not expose Continue until the backend confirms pause",async()=>{
    wrapper=mount(App);await flushPromises();await button("添加图片").trigger("click");await button("开始批量").trigger("click");await flushPromises();
    await button("暂停").trigger("click");await flushPromises();
    expect(button("正在暂停").attributes("disabled")).toBeDefined();
    expect(wrapper.findAll("button").some(b=>b.text()==="继续")).toBe(false);
    mock.jobs[0].onEvent!({event:"paused"});await flushPromises();await button("继续").trigger("click");await flushPromises();
    expect(mock.request.mock.calls.some(c=>c[0]==="resume")).toBe(true);
    mock.jobs[0].onEvent!({event:"resumed"});await flushPromises();expect(button("暂停").attributes("disabled")).toBeUndefined();
  });
  it("exports the explicit formatted version even while original text is being viewed",async()=>{
    savedTasks();wrapper=mount(App);await flushPromises();await button("整理前").trigger("click");
    mock.open.mockResolvedValue("/output");await button("导出所选格式").trigger("click");await flushPromises();
    const payload=mock.request.mock.calls.find(c=>c[0]==="export_preview")?.[1];
    expect(payload.textItems[0].text).toBe("第一行继续正文");
    expect(payload.textItems).toHaveLength(2);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("整理后"));
  });
  it("exports only checked tasks and allows an independent original export",async()=>{
    savedTasks();wrapper=mount(App);await flushPromises();
    await wrapper.find('[aria-label="导出范围"]').setValue("checked");
    await wrapper.find('[aria-label="导出文本版本"]').setValue("original");
    await wrapper.findAll('.task-check')[0].setValue(true);
    mock.open.mockResolvedValue("/output");await button("导出所选格式").trigger("click");await flushPromises();
    const payload=mock.request.mock.calls.find(c=>c[0]==="export_preview")?.[1];
    expect(payload.textItems.map((t:any)=>t.id)).toEqual(["a"]);
    expect(payload.textItems[0].text).toBe("第一行\n继续正文");
  });
  it("does not mark results changed just by switching view",async()=>{
    savedTasks();wrapper=mount(App);await flushPromises();await button("整理前").trigger("click");
    await new Promise(r=>setTimeout(r,450));await flushPromises();
    // If startup generated a save, it must retain the original revision.
    for(const call of mock.save.mock.calls) expect(call[0].tasks[0].revision).toBe(1);
  });
  it("focus mode has two copy buttons and a working ruby preview",async()=>{
    const r=savedTasks();r.pages[0].blocks[0].ruby=[{start:0,end:2,text:"よみ"}];
    wrapper=mount(App);await flushPromises();await wrapper.find('[aria-label="识别日语注音"]').setValue(true);await wrapper.find('[aria-label="注音输出"]').setValue("ruby");
    await wrapper.find('[aria-label="进入专注模式"]').trigger("click");
    expect(wrapper.findAll('button').filter(b=>b.text()==="复制全文")).toHaveLength(2);
    expect(wrapper.find('[aria-label="整理后注音预览"] ruby').exists()).toBe(true);
    await wrapper.find('.text-result-tools input[type="checkbox"]').setValue(false);
    expect(wrapper.find('[aria-label="整理后文本"]').exists()).toBe(true);
    expect(wrapper.find('.focus-save').exists()).toBe(true);
  });
  it("reports clipboard failures near the result instead of rejecting silently",async()=>{
    savedTasks();wrapper=mount(App);await flushPromises();
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:vi.fn(async()=>{throw Error('denied')})}});
    await button("复制全文").trigger("click");await flushPromises();expect(wrapper.find('.action-feedback').text()).toContain("复制失败");
  });
  it("starts auto PDF extraction without preparing models",async()=>{
    wrapper=mount(App);await flushPromises();mock.dropped!(["/book.pdf"]);await flushPromises();
    await button("开始批量").trigger("click");await flushPromises();
    expect(mock.jobs).toHaveLength(1);expect(mock.request.mock.calls.some(c=>c[0]==="prepare")).toBe(false);
  });
  it("keeps corrected text and formats later incoming pages",async()=>{
    const r=savedTasks();mock.load.mockResolvedValue(null);wrapper=mount(App);await flushPromises();mock.dropped!(["/book.pdf"]);await flushPromises();
    await button("开始批量").trigger("click");await flushPromises();
    mock.jobs[0].onEvent!({event:"page_result",pageResult:r.pages[0],pageCount:10});await flushPromises();
    await wrapper.find('[aria-label="识别文本"]').setValue("已校对的第一页");
    mock.jobs[0].onEvent!({event:"page_result",pageResult:{...r.pages[0],pageIndex:1},pageCount:10});await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.value).toBe("已校对的第一页\n\n第一行继续正文");
    mock.jobs[0].resolve({...r,pageCount:2,pages:[r.pages[0],{...r.pages[0],pageIndex:1}]});await flushPromises();
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.value).toContain("已校对的第一页\n\n第一行继续正文");
  });
});

describe("0.13 lazy model handoff",()=>{
  it("prepares on model-required and resumes after previously extracted pages",async()=>{
    wrapper=mount(App);await flushPromises();mock.dropped!(["/mixed.pdf"]);await flushPromises();
    await button("开始批量").trigger("click");await flushPromises();
    mock.jobs[0].onEvent!({event:"page_result",pageResult:{pageIndex:0,text:"文本页",blocks:[],tables:[],source:"pdf-text"},pageCount:10});await flushPromises();
    mock.jobs[0].reject(Object.assign(new SidecarRequestError("需要模型"),{category:"model_required"}));await flushPromises();
    expect(mock.request.mock.calls.filter(c=>c[0]==="prepare")).toHaveLength(1);
    expect(mock.jobs).toHaveLength(2);
    expect(mock.request.mock.calls.filter(c=>c[0]==="recognize")[1][1].completedPages).toEqual([0]);
    expect(wrapper.find<HTMLTextAreaElement>('[aria-label="识别文本"]').element.value).toBe("文本页");
  });
  it("stops ordinary preparation without closing the application",async()=>{
    let rejectPrepare:(error:Error)=>void=()=>{};
    const original=mock.request.getMockImplementation()!;
    mock.request.mockImplementation((method,params,event)=>method==="prepare"?new Promise((_,reject)=>rejectPrepare=reject):original(method,params,event));
    mock.forceStop.mockImplementation(async()=>{mock.running=false;rejectPrepare(Error("terminated"))});
    wrapper=mount(App);await flushPromises();await button("准备当前模型").trigger("click");await flushPromises();
    await button("停止准备模型").trigger("click");await flushPromises();
    expect(mock.forceStop).toHaveBeenCalledOnce();expect(wrapper.find('.action-feedback').text()).toContain("已停止");
    expect(button("启动并准备模型").attributes("disabled")).toBeUndefined();
  });
});

describe("result retention and automatic exports", () => {
  function settings(auto = true) {
    mock.load.mockResolvedValue({schema:2,savedAt:"now",selectedTaskId:"",tasks:[],settings:{...defaultSettings,autoExport:auto,autoExportDirectory:"/exports",formats:["txt","html"]}});
  }
  it("exports each completed file before starting the next without opening a dialog", async () => {
    settings();
    const original=mock.request.getMockImplementation()!;
    mock.request.mockImplementation(async(method,params,event)=>method === "export_results" ? {count:2,exportedIds:params.textItems.map((item:{id:string})=>item.id)} : original(method,params,event));
    wrapper=mount(App);await flushPromises();mock.dropped!(["/one.png","/two.png"]);await flushPromises();
    void button("开始批量识别").trigger("click");await flushPromises();
    mock.jobs[0].resolve(result("第一本"));await flushPromises();
    const call=mock.request.mock.calls.find(call=>call[0]==="export_results")!;
    expect(call[1].directory).toBe("/exports");expect(call[1].options.collision).toBe("rename");
    expect(call[1].textItems).toHaveLength(1);expect(mock.jobs).toHaveLength(2);
    expect(wrapper.text()).toContain("已导出");expect(mock.open).not.toHaveBeenCalled();
    expect(mock.save.mock.calls.some(call=>call[0].tasks[0]?.result && call[0].tasks[0].exportedRevision===undefined)).toBe(true);
    mock.jobs[1].resolve(result("第二本"));await flushPromises();
    expect(mock.request.mock.calls.filter(call=>call[0]==="export_results")).toHaveLength(2);
  });
  it("keeps OCR successful on export failure, continues the batch and retries only export", async () => {
    settings();const original=mock.request.getMockImplementation()!;let fail=true;
    mock.request.mockImplementation(async(method,params,event)=>{
      if(method==="export_results") {if(fail) throw new Error("磁盘已满");return {count:1,exportedIds:params.textItems.map((item:{id:string})=>item.id)};}
      return original(method,params,event);
    });
    wrapper=mount(App);await flushPromises();mock.dropped!(["/one.png","/two.png"]);await flushPromises();
    void button("开始批量识别").trigger("click");await flushPromises();mock.jobs[0].resolve(result("保留内容"));await flushPromises();
    expect(wrapper.find('.task-item').classes()).toContain("completed");expect(wrapper.text()).toContain("磁盘已满");expect(mock.jobs).toHaveLength(2);
    mock.jobs[1].resolve(result("第二本"));await flushPromises();fail=false;
    await button("重试导出").trigger("click");await flushPromises();expect(mock.jobs).toHaveLength(2);
    expect(wrapper.find('.task-item').text()).toContain("已导出");
  });
  it("blocks automatic export with no directory or with only XLSX for text", async () => {
    settings();wrapper=mount(App);await flushPromises();mock.dropped!(["/one.png"]);await flushPromises();
    const formats=wrapper.findAll('.export-options input');await formats[0].setValue(false);await formats[1].setValue(true);await formats[2].setValue(false);
    await button("开始批量识别").trigger("click");await flushPromises();expect(mock.jobs).toHaveLength(0);expect(wrapper.text()).toContain("普通文字无法生成 XLSX");
  });
  it("does not clear queue if saving the results fails", async () => {
    mock.load.mockResolvedValue({schema:2,savedAt:"now",selectedTaskId:"book",settings:defaultSettings,tasks:[{id:"book",batchId:"book",batchIndex:0,path:"/book.pdf",fileName:"book.pdf",status:"completed",resultType:"text",result:result("尚未导出")} ]});
    wrapper=mount(App);await flushPromises();mock.save.mockRejectedValue(new Error("保存失败"));
    await button("清理已结束").trigger("click");await flushPromises();expect(wrapper.findAll('.task-item')).toHaveLength(1);expect(wrapper.text()).toContain("保存失败");
  });
});


it("opens archived results without recognizing, then can safely clear the queue again", async () => {
  const entry={task:{id:"archived",batchId:"batch",batchIndex:0,path:"/missing.pdf",fileName:"missing.pdf",status:"completed",resultType:"text",result:result("历史书籍内容")},settings:defaultSettings,savedAt:"2026-09-10"};
  mock.listHistory.mockResolvedValue([entry]);mock.readHistory.mockResolvedValue(entry);
  wrapper=mount(App);await flushPromises();await button("识别历史").trigger("click");await flushPromises();
  expect(wrapper.find('[role="dialog"]').exists()).toBe(true);expect(wrapper.text()).toContain("missing.pdf");
  await button("打开结果").trigger("click");await flushPromises();
  expect(wrapper.find<HTMLTextAreaElement>('textarea').element.value).toBe("历史书籍内容");expect(mock.jobs).toHaveLength(0);
  await button("清理已结束").trigger("click");await flushPromises();
  expect(wrapper.findAll('.task-item')).toHaveLength(0);expect(mock.deleteHistory).not.toHaveBeenCalled();
});
