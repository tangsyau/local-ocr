import { finalizeResult, inferResultMode } from "./result-state";
import type { ModelProfile, OcrPage, OcrTask, RecognitionMode } from "./types";
import { normalizeTextSettings, type TextSettings } from "./text-processing";

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
  textSettings?: TextSettings;
  rawTextView?: boolean;
}

export interface SavedSession {
  schema: 2;
  savedAt: string;
  selectedTaskId: string;
  tasks: OcrTask[];
  settings: AppSettings;
  /** Runtime-only marker: the next save moves schema-1 inline pages once. */
  needsPageMigration?: boolean;
}

export interface PageCheckpoint { taskId: string; pageIndex: number; page: OcrPage }
export interface SaveSessionOptions { pages?: PageCheckpoint[]; resetTaskIds?: string[] }

export const defaultSettings: AppSettings = {
  profile: "fast", mode: "text", threshold: 0.5, merge: true,
  formats: ["txt", "xlsx"], exportGrouping: "separate", exportCollision: "rename",
  exportPrefix: "", exportSuffix: "", exportName: "批量识别结果", localModelsOnly: false
};

export function restoreSession(value: unknown, storedPages: Map<string, OcrPage[]> = new Map()): SavedSession | null {
  if (value == null) return null;
  const data = value as { schema?: number; tasks?: OcrTask[]; settings?: AppSettings; selectedTaskId?: string; savedAt?: string };
  if (![1, 2].includes(data.schema ?? -1) || !Array.isArray(data.tasks) || !data.settings) {
    throw new Error("自动保存的数据格式无法读取；原记录未被覆盖");
  }
  const ids = new Set<string>();
  const tasks = data.tasks.map((task) => {
    if (!task || typeof task.id !== "string" || typeof task.path !== "string" || !task.path || ids.has(task.id)) {
      throw new Error("自动保存的任务数据不完整；原记录未被覆盖");
    }
    ids.add(task.id);
    let result = task.result;
    if (result) {
      const pages = data.schema === 2 ? storedPages.get(task.id) ?? [] : Array.isArray(result.pages) ? result.pages : [];
      if (typeof result.text !== "string" || !Array.isArray(result.tables)) {
        throw new Error("自动保存的识别结果不完整；原记录未被覆盖");
      }
      result = finalizeResult(result, pages, task.textEdited === true);
    }
    const resultType = result ? inferResultMode(result, task.resultType) : task.resultType === "table" ? "table" : "text";
    const interrupted = task.status === "running" || task.status === "paused";
    if (interrupted && result) result.partial = true;
    return {
      ...task,
      result,
      resultType,
      batchId: task.batchId || task.id,
      batchIndex: task.batchIndex ?? 0,
      pageRange: typeof task.pageRange === "string" ? task.pageRange.slice(0, 2000) : "",
      rotation: [0, 90, 180, 270].includes(task.rotation ?? 0) ? task.rotation ?? 0 : 0,
      resumeEligible: task.resumeEligible === true || (interrupted && Boolean(result?.pages.length)),
      status: interrupted ? "queued" as const : task.status,
      currentPage: result?.pages.length ?? task.currentPage,
      error: interrupted ? "上次处理未结束；文件和识别设置未变化时，将从已保存的下一页继续" : task.error
    };
  });
  const input = data.settings;
  const settings: AppSettings = {
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
    localModelsOnly: input.localModelsOnly === true,
    textSettings: normalizeTextSettings(input.textSettings), rawTextView: input.rawTextView === true
  };
  return {
    schema: 2, savedAt: String(data.savedAt || ""),
    selectedTaskId: ids.has(data.selectedTaskId || "") ? data.selectedTaskId! : tasks[0]?.id || "",
    tasks, settings, needsPageMigration: data.schema === 1
  };
}

export function sessionHeader(session: SavedSession): SavedSession {
  return {
    schema: 2, savedAt: session.savedAt, selectedTaskId: session.selectedTaskId,
    settings: { ...session.settings },
    tasks: session.tasks.map((task) => ({
      ...task,
      result: task.result ? { ...task.result, text: task.textEdited ? task.result.text : "", pages: [], tables: [] } : undefined
    }))
  };
}

let database: Promise<IDBDatabase> | null = null;
let storedRevision: string | null = null;
let persistedTaskIds = new Set<string>();
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("local-ocr-session", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state");
      if (!request.result.objectStoreNames.contains("pages")) request.result.createObjectStore("pages", { keyPath: ["taskId", "pageIndex"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本机自动保存数据库"));
    request.onblocked = () => reject(new Error("自动保存数据库被另一个程序窗口占用"));
  });
  return database;
}

export async function loadSession(): Promise<SavedSession | null> {
  const db = await openDatabase();
  const [value, records] = await Promise.all([
    new Promise<unknown>((resolve, reject) => {
      const request = db.transaction("state", "readonly").objectStore("state").get("session");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("读取自动保存记录失败"));
    }),
    new Promise<PageCheckpoint[]>((resolve, reject) => {
      const request = db.transaction("pages", "readonly").objectStore("pages").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("读取逐页识别检查点失败"));
    })
  ]);
  const record = value as { commitId?: string; savedAt?: string } | null;
  storedRevision = record?.commitId ?? record?.savedAt ?? null;
  const byTask = new Map<string, OcrPage[]>();
  for (const item of records) byTask.set(item.taskId, [...(byTask.get(item.taskId) ?? []), item.page]);
  const restored = restoreSession(value, byTask);
  persistedTaskIds = new Set(restored?.tasks.map((task) => task.id) ?? []);
  return restored;
}

function taskPageRange(taskId: string): IDBKeyRange {
  return IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]);
}

export async function saveSession(session: SavedSession, options: SaveSessionOptions = {}): Promise<void> {
  const db = await openDatabase();
  const header = sessionHeader(session);
  const taskIds = new Set(header.tasks.map((task) => task.id));
  const removed = [...persistedTaskIds].filter((id) => !taskIds.has(id));
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(["state", "pages"], "readwrite");
    const state = transaction.objectStore("state");
    const pages = transaction.objectStore("pages");
    const current = state.get("session");
    const commitId = `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-")}`;
    let conflict = false;
    current.onsuccess = () => {
      const value = current.result;
      if ((value?.commitId ?? value?.savedAt ?? null) !== storedRevision) {
        conflict = true;
        transaction.abort();
        return;
      }
      for (const taskId of new Set([...(options.resetTaskIds ?? []), ...removed])) pages.delete(taskPageRange(taskId));
      for (const checkpoint of options.pages ?? []) pages.put(checkpoint);
      state.put({ ...header, commitId }, "session");
    };
    transaction.oncomplete = () => { storedRevision = commitId; persistedTaskIds = taskIds; resolve(); };
    transaction.onerror = transaction.onabort = () => reject(new Error(conflict
      ? "另一个窗口已保存新记录；为避免覆盖，当前窗口停止自动保存。请先导出当前结果，再关闭多余窗口。"
      : "自动保存失败：请检查剩余磁盘空间和数据目录权限"));
  });
}
