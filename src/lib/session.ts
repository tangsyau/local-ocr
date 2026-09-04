import { mergeTablePages } from "./table-results";
import type { ModelProfile, OcrPage, OcrResult, OcrTable, OcrTask, RecognitionMode } from "./types";

export interface AppSettings {
  profile: ModelProfile;
  mode: RecognitionMode;
  threshold: number;
  merge: boolean;
  formats: string[];
  exportGrouping: "separate" | "combined";
  exportCollision: "rename" | "skip" | "overwrite";
  exportPrefix: string;
  exportSuffix: string;
  exportName: string;
  localModelsOnly?: boolean;
}

export interface SavedSession {
  schema: 1;
  savedAt: string;
  selectedTaskId: string;
  tasks: OcrTask[];
  settings: AppSettings;
}

interface StoredSessionMeta {
  schema: 2;
  savedAt: string;
  selectedTaskId: string;
  taskIds: string[];
  settings: AppSettings;
  commitId: string;
}

type StoredResult = Omit<OcrResult, "text" | "pages" | "tables"> & { text?: string };

interface StoredTaskRecord {
  id: string;
  task: Omit<OcrTask, "result">;
  result?: StoredResult;
}

interface StoredPageRecord {
  key: string;
  taskId: string;
  ordinal: number;
  generation: number;
  page: OcrPage;
}

interface SavePlan {
  meta: Omit<StoredSessionMeta, "commitId">;
  taskRecords: StoredTaskRecord[];
  taskFingerprints: Map<string, string>;
  removedTaskIds: string[];
  resetTaskPages: string[];
  pageRecords: StoredPageRecord[];
  pageCounts: Map<string, number>;
  generations: Map<string, number>;
}

interface CapturedTask {
  record: StoredTaskRecord;
  pages: OcrPage[];
  generation: number;
}

interface CapturedSession {
  savedAt: string;
  selectedTaskId: string;
  settings: AppSettings;
  tasks: CapturedTask[];
}

export const defaultSettings: AppSettings = {
  profile: "fast", mode: "text", threshold: 0.5, merge: true,
  formats: ["txt", "xlsx"], exportGrouping: "separate", exportCollision: "rename",
  exportPrefix: "", exportSuffix: "", exportName: "批量识别结果", localModelsOnly: false
};

function normalizeSettings(input: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    profile: input.profile === "accurate" ? "accurate" : "fast",
    mode: input.mode === "table" ? "table" : "text",
    threshold: Number.isFinite(input.threshold) ? Math.max(0, Math.min(1, input.threshold)) : 0.5,
    merge: input.merge !== false,
    formats: Array.isArray(input.formats) ? input.formats.filter((format) => ["txt", "xlsx", "html"].includes(format)) : ["txt", "xlsx"],
    exportGrouping: input.exportGrouping === "combined" ? "combined" : "separate",
    exportCollision: ["skip", "overwrite"].includes(input.exportCollision) ? input.exportCollision : "rename",
    exportPrefix: String(input.exportPrefix || "").slice(0, 100),
    exportSuffix: String(input.exportSuffix || "").slice(0, 100),
    exportName: String(input.exportName || defaultSettings.exportName).slice(0, 100),
    localModelsOnly: input.localModelsOnly === true
  };
}

function normalizeTask(task: OcrTask): OcrTask {
  const interrupted = task.status === "running" || task.status === "paused";
  const hasPartialPdf = interrupted && Boolean(task.result?.pages.length) && task.path.toLowerCase().endsWith(".pdf");
  return {
    ...task,
    batchId: task.batchId || task.id,
    batchIndex: task.batchIndex ?? 0,
    pageRange: typeof task.pageRange === "string" ? task.pageRange.slice(0, 2000) : "",
    rotation: [0, 90, 180, 270].includes(task.rotation ?? 0) ? task.rotation ?? 0 : 0,
    resultGeneration: task.resultGeneration ?? 0,
    resumePending: task.resumePending === true || hasPartialPdf,
    status: interrupted ? "queued" as const : task.status,
    error: interrupted ? "上次处理未结束；已完成页面会保留，设置和原文件未变化时可继续其余页面" : task.error
  };
}

export function restoreSession(value: unknown): SavedSession | null {
  if (value == null) return null;
  const data = value as Partial<SavedSession>;
  if (data.schema !== 1 || !Array.isArray(data.tasks) || !data.settings) {
    throw new Error("自动保存的数据格式无法读取；原记录未被覆盖");
  }
  const ids = new Set<string>();
  const tasks = data.tasks.map((task) => {
    if (!task || typeof task.id !== "string" || typeof task.path !== "string" || !task.path || ids.has(task.id)) {
      throw new Error("自动保存的任务数据不完整；原记录未被覆盖");
    }
    ids.add(task.id);
    if (task.result && (!Array.isArray(task.result.pages) || !Array.isArray(task.result.tables) || typeof task.result.text !== "string")) {
      throw new Error("自动保存的识别结果不完整；原记录未被覆盖");
    }
    return normalizeTask(task);
  });
  return {
    schema: 1,
    savedAt: String(data.savedAt || ""),
    selectedTaskId: ids.has(data.selectedTaskId || "") ? data.selectedTaskId! : tasks[0]?.id || "",
    tasks,
    settings: normalizeSettings(data.settings)
  };
}

function cloneTable(table: OcrTable): OcrTable {
  return {
    ...table,
    box: [...table.box],
    rows: table.rows.map((row) => row.map((cell) => ({
      ...cell,
      box: [...cell.box]
    })))
  };
}

function clonePage(page: OcrPage): OcrPage {
  return {
    ...page,
    blocks: page.blocks.map((block) => ({
      ...block,
      box: [...block.box],
      polygon: block.polygon.map((point) => [...point])
    })),
    tables: page.tables.map(cloneTable)
  };
}

function storeTask(task: OcrTask): StoredTaskRecord {
  const { result, ...taskMeta } = task;
  if (!result) return { id: task.id, task: { ...taskMeta } };
  const { text, pages: _pages, tables: _tables, ...summary } = result;
  return {
    id: task.id,
    task: { ...taskMeta },
    result: { ...summary, ...(task.textEdited ? { text } : {}) }
  };
}

function restoreStoredTask(record: StoredTaskRecord, pages: OcrPage[]): OcrTask {
  const task: OcrTask = { ...record.task };
  if (record.result) {
    const text = record.result.text ?? pages.map((page) => page.text).filter(Boolean).join("\n\n");
    const tables = mergeTablePages(
      pages.map((page) => page.tables),
      pages.map((page, index) => page.pageIndex ?? index)
    );
    task.result = { ...record.result, text, pages, tables };
  }
  return normalizeTask(task);
}

let database: Promise<IDBDatabase> | null = null;
let storedRevision: string | null = null;
let storedTaskFingerprints = new Map<string, string>();
let storedPageCounts = new Map<string, number>();
let storedGenerations = new Map<string, number>();
let writeChain: Promise<void> = Promise.resolve();

function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("local-ocr-session", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pages")) {
        const pages = db.createObjectStore("pages", { keyPath: "key" });
        pages.createIndex("taskId", "taskId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本机自动保存数据库"));
    request.onblocked = () => reject(new Error("自动保存数据库被另一个程序窗口占用"));
  });
  return database;
}

function requestValue<T>(request: IDBRequest<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(message));
  });
}

export async function loadSession(): Promise<SavedSession | null> {
  const db = await openDatabase();
  const transaction = db.transaction(["state", "tasks", "pages"], "readonly");
  const metaPromise = requestValue(transaction.objectStore("state").get("session-v2"), "读取自动保存记录失败");
  const taskPromise = requestValue(transaction.objectStore("tasks").getAll(), "读取任务记录失败");
  const pagePromise = requestValue(transaction.objectStore("pages").getAll(), "读取逐页结果失败");
  const [metaValue, taskValue, pageValue] = await Promise.all([metaPromise, taskPromise, pagePromise]);
  const meta = metaValue as StoredSessionMeta | undefined;
  if (meta?.schema === 2) {
    const records = taskValue as StoredTaskRecord[];
    const pages = pageValue as StoredPageRecord[];
    const recordById = new Map(records.map((record) => [record.id, record]));
    if (meta.taskIds.some((id) => !recordById.has(id))) {
      throw new Error("自动保存的任务索引不完整；原记录未被覆盖");
    }
    const pagesByTask = new Map<string, StoredPageRecord[]>();
    for (const page of pages) {
      const items = pagesByTask.get(page.taskId) ?? [];
      items.push(page);
      pagesByTask.set(page.taskId, items);
    }
    const tasks = meta.taskIds.flatMap((id) => {
      const record = recordById.get(id);
      if (!record) return [];
      const taskPages = (pagesByTask.get(id) ?? []).sort((left, right) => left.ordinal - right.ordinal).map((item) => item.page);
      return [restoreStoredTask(record, taskPages)];
    });
    storedRevision = meta.commitId;
    storedTaskFingerprints = new Map(records.map((record) => [record.id, JSON.stringify(record)]));
    storedPageCounts = new Map(tasks.map((task) => [task.id, task.result?.pages.length ?? 0]));
    storedGenerations = new Map(tasks.map((task) => [task.id, task.resultGeneration ?? 0]));
    return restoreSession({
      schema: 1,
      savedAt: meta.savedAt,
      selectedTaskId: meta.selectedTaskId,
      tasks,
      settings: meta.settings
    });
  }

  const legacy = await requestValue(db.transaction("state", "readonly").objectStore("state").get("session"), "读取旧版自动保存记录失败");
  storedRevision = null;
  storedTaskFingerprints.clear();
  storedPageCounts.clear();
  storedGenerations.clear();
  return restoreSession(legacy);
}

function captureSession(session: SavedSession): CapturedSession {
  return {
    savedAt: session.savedAt,
    selectedTaskId: session.selectedTaskId,
    settings: normalizeSettings(session.settings),
    tasks: session.tasks.map((task) => ({
      record: storeTask(task),
      pages: [...(task.result?.pages ?? [])],
      generation: task.resultGeneration ?? 0
    }))
  };
}

function buildSavePlan(session: CapturedSession): SavePlan {
  const taskRecords = session.tasks.map((task) => task.record);
  const taskFingerprints = new Map(taskRecords.map((record) => [record.id, JSON.stringify(record)]));
  const taskIds = new Set(taskRecords.map((record) => record.id));
  const removedTaskIds = [...storedTaskFingerprints.keys()].filter((id) => !taskIds.has(id));
  const changedTaskRecords = taskRecords.filter((record) => storedTaskFingerprints.get(record.id) !== taskFingerprints.get(record.id));
  const resetTaskPages: string[] = [...removedTaskIds];
  const pageRecords: StoredPageRecord[] = [];
  const pageCounts = new Map<string, number>();
  const generations = new Map<string, number>();

  for (const captured of session.tasks) {
    const pages = captured.pages;
    const generation = captured.generation;
    const previousCount = storedPageCounts.get(captured.record.id) ?? 0;
    const previousGeneration = storedGenerations.get(captured.record.id) ?? generation;
    const reset = generation !== previousGeneration || pages.length < previousCount || !captured.record.result;
    const start = reset ? 0 : Math.min(previousCount, pages.length);
    if (reset && !resetTaskPages.includes(captured.record.id)) resetTaskPages.push(captured.record.id);
    for (let ordinal = start; ordinal < pages.length; ordinal += 1) {
      pageRecords.push({
        key: `${captured.record.id}:${generation}:${ordinal}`,
        taskId: captured.record.id,
        ordinal,
        generation,
        page: clonePage(pages[ordinal])
      });
    }
    pageCounts.set(captured.record.id, pages.length);
    generations.set(captured.record.id, generation);
  }

  return {
    meta: {
      schema: 2,
      savedAt: session.savedAt,
      selectedTaskId: session.selectedTaskId,
      taskIds: session.tasks.map((task) => task.record.id),
      settings: session.settings
    },
    taskRecords: changedTaskRecords,
    taskFingerprints,
    removedTaskIds,
    resetTaskPages,
    pageRecords,
    pageCounts,
    generations
  };
}

function deletePagesForTasks(store: IDBObjectStore, taskIds: string[], complete: () => void): void {
  if (!taskIds.length) {
    complete();
    return;
  }
  let remaining = taskIds.length;
  for (const taskId of taskIds) {
    const request = store.index("taskId").openKeyCursor(IDBKeyRange.only(taskId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }
      remaining -= 1;
      if (!remaining) complete();
    };
  }
}

async function commitSavePlan(plan: SavePlan): Promise<void> {
  const db = await openDatabase();
  const commitId = `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-")}`;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(["state", "tasks", "pages"], "readwrite");
    const state = transaction.objectStore("state");
    const tasks = transaction.objectStore("tasks");
    const pages = transaction.objectStore("pages");
    const current = state.get("session-v2");
    let conflict = false;
    current.onsuccess = () => {
      if ((current.result?.commitId ?? null) !== storedRevision) {
        conflict = true;
        transaction.abort();
        return;
      }
      for (const id of plan.removedTaskIds) tasks.delete(id);
      for (const record of plan.taskRecords) tasks.put(record);
      deletePagesForTasks(pages, plan.resetTaskPages, () => {
        for (const page of plan.pageRecords) pages.put(page);
        state.put({ ...plan.meta, commitId }, "session-v2");
      });
    };
    transaction.oncomplete = () => {
      storedRevision = commitId;
      storedTaskFingerprints = plan.taskFingerprints;
      storedPageCounts = plan.pageCounts;
      storedGenerations = plan.generations;
      resolve();
    };
    transaction.onerror = transaction.onabort = () => reject(new Error(conflict
      ? "另一个窗口已保存新记录；为避免覆盖，当前窗口停止自动保存。请先导出当前结果，再关闭多余窗口。"
      : "自动保存失败：请检查剩余磁盘空间和数据目录权限"));
  });
}

export function saveSession(session: SavedSession): Promise<void> {
  // Build a compact plan synchronously while the reactive state is stable. Only
  // newly appended pages are cloned; unchanged OCR pages are never serialized
  // again during long PDF recognition.
  const captured = captureSession(session);
  const operation = writeChain.catch(() => {}).then(() => commitSavePlan(buildSavePlan(captured)));
  writeChain = operation;
  return operation;
}
