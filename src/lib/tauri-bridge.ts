import { convertFileSrc as convertFileSrcV2, invoke } from "@tauri-apps/api/core";
import { open as openV2 } from "@tauri-apps/plugin-dialog";
import { Command as CommandV2 } from "@tauri-apps/plugin-shell";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface OpenDialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: OpenDialogFilter[];
}

export interface SidecarChild {
  write(data: string | Uint8Array): Promise<void>;
  kill(): Promise<void>;
}

interface EventChannel<T> {
  on(event: "data", handler: (payload: T) => void): void;
}

export interface SidecarCommand {
  stdout: EventChannel<string>;
  stderr: EventChannel<string>;
  on(event: "error", handler: (payload: unknown) => void): void;
  on(event: "close", handler: (payload: { code?: number | null }) => void): void;
  spawn(): Promise<SidecarChild>;
}

interface LegacyTauriGlobal {
  window: {
    appWindow: {
      onFileDropEvent(handler: (event: { payload: { type: string; paths?: string[] } }) => void): Promise<() => void>;
      onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
      close(): Promise<void>;
    };
  };
  dialog: {
    open(options?: OpenDialogOptions): Promise<string | string[] | null>;
  };
  shell: {
    Command: {
      sidecar(program: string): SidecarCommand;
    };
  };
  tauri: {
    convertFileSrc(path: string, protocol?: string): string;
  };
}

declare global {
  interface Window {
    __TAURI__?: LegacyTauriGlobal;
  }
}

export const isWebkitGtk40Build = import.meta.env.VITE_WEBKITGTK_4_0 === "1";

function legacyTauri(): LegacyTauriGlobal {
  const api = window.__TAURI__;
  if (!api) throw new Error("WebKitGTK 4.0 兼容层没有找到 Tauri 1 全局 API");
  return api;
}

export function convertLocalFileSrc(path: string): string {
  return isWebkitGtk40Build
    ? legacyTauri().tauri.convertFileSrc(path)
    : convertFileSrcV2(path);
}

export async function localImagePreview(path: string): Promise<string> {
  const allowedPath = isWebkitGtk40Build ? path : await invoke<string>("allow_image_preview", { path });
  return convertLocalFileSrc(allowedPath);
}

export async function openLocalDialog(
  options: OpenDialogOptions
): Promise<string | string[] | null> {
  if (isWebkitGtk40Build) return legacyTauri().dialog.open(options);
  return openV2(options);
}

export function createSidecarCommand(program: string): SidecarCommand {
  if (isWebkitGtk40Build) return legacyTauri().shell.Command.sidecar(program);
  return CommandV2.sidecar(program) as unknown as SidecarCommand;
}

export function createId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint32Array(4));
  return `${Date.now().toString(36)}-${Array.from(random, (value) => value.toString(36)).join("-")}`;
}

export async function listenFileDrop(handler: (paths: string[]) => void): Promise<() => void> {
  if (isWebkitGtk40Build) return legacyTauri().window.appWindow.onFileDropEvent((event) => {
    if (event.payload.type === "drop") handler(event.payload.paths ?? []);
  });
  return getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") handler(event.payload.paths);
  });
}

export async function listenBeforeClose(handler: () => Promise<boolean>): Promise<() => void> {
  const appWindow = isWebkitGtk40Build ? legacyTauri().window.appWindow : getCurrentWindow();
  let closing = false;
  let unlisten: () => void = () => {};
  unlisten = await appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      if (await handler()) {
        unlisten();
        await appWindow.close();
      }
    } finally { closing = false; }
  });
  return unlisten;
}
