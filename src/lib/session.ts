import type { ModelProfile, OcrTask, RecognitionMode } from "./types";

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
}

export interface SavedSession {
  schema: 1;
  savedAt: string;
  selectedTaskId: string;
  tasks: OcrTask[];
  settings: AppSettings;
}

export const defaultSettings: AppSettings = {
  profile: "fast", mode: "text", threshold: 0.5, merge: true,
  formats: ["txt", "xlsx"], exportGrouping: "separate", exportCollision: "rename",
  exportPrefix: "", exportSuffix: "", exportName: "批量识别结果"
};

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
    const interrupted = task.status === "running" || task.status === "paused";
    return {
      ...task,
      batchId: task.batchId || task.id,
      batchIndex: task.batchIndex ?? 0,
      status: interrupted ? "queued" as const : task.status,
      error: interrupted ? "上次处理未结束；结果已保留，重新开始时会从文件首页识别" : task.error
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
    exportName: String(input.exportName || defaultSettings.exportName).slice(0, 100)
  };
  return {
    schema: 1,
    savedAt: String(data.savedAt || ""),
    selectedTaskId: ids.has(data.selectedTaskId || "") ? data.selectedTaskId! : tasks[0]?.id || "",
    tasks,
    settings
  };
}

let database: Promise<IDBDatabase> | null = null;
let storedRevision: string | null = null;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("local-ocr-session", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本机自动保存数据库"));
    request.onblocked = () => reject(new Error("自动保存数据库被另一个程序窗口占用"));
  });
  return database;
}

export async function loadSession(): Promise<SavedSession | null> {
  const db = await openDatabase();
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction("state", "readonly").objectStore("state").get("session");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("读取自动保存记录失败"));
  });
  const record = value as { commitId?: string; savedAt?: string } | null;
  storedRevision = record?.commitId ?? record?.savedAt ?? null;
  return restoreSession(value);
}

export async function saveSession(session: SavedSession): Promise<void> {
  const db = await openDatabase();
  // One transaction atomically commits both settings and task results. No source
  // file bytes are stored; recognition text is deliberately kept local in cleartext.
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    const store = transaction.objectStore("state");
    const current = store.get("session");
    const commitId = `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-")}`;
    let conflict = false;
    current.onsuccess = () => {
      const value = current.result;
      if ((value?.commitId ?? value?.savedAt ?? null) !== storedRevision) {
        conflict = true;
        transaction.abort();
        return;
      }
      store.put({ ...session, commitId }, "session");
    };
    transaction.oncomplete = () => { storedRevision = commitId; resolve(); };
    transaction.onerror = transaction.onabort = () => reject(new Error(conflict
      ? "另一个窗口已保存新记录；为避免覆盖，当前窗口停止自动保存。请先导出当前结果，再关闭多余窗口。"
      : "自动保存失败：请检查剩余磁盘空间和数据目录权限"));
  });
}
