import type { SidecarEvent } from "./types";
import { createId, createSidecarCommand, type SidecarChild } from "./tauri-bridge";

interface ProtocolMessage {
  id?: string | null;
  type: "event" | "result" | "error";
  event?: string;
  message?: string;
  result?: unknown;
  details?: string;
  page?: number;
  pageCount?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onEvent?: (event: SidecarEvent) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class SidecarRequestError extends Error {
  constructor(message: string, readonly details = "") {
    super(message);
    this.name = "SidecarRequestError";
  }
}

class OcrSidecarClient {
  private child: SidecarChild | null = null;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrTail = "";

  get running(): boolean {
    return this.child !== null;
  }

  get stderr(): string {
    return this.stderrTail.trim();
  }

  async start(): Promise<void> {
    if (this.child) return;

    this.stderrTail = "";
    const command = createSidecarCommand("binaries/ocr-sidecar");
    command.stdout.on("data", (chunk) => this.consumeStdout(String(chunk)));
    command.stderr.on("data", (line) => {
      const text = String(line);
      this.stderrTail = `${this.stderrTail}${text}\n`.slice(-4_000);
      console.info(`[ocr-sidecar] ${text}`);
    });
    command.on("error", (error) => this.failAll(new Error(String(error))));
    command.on("close", ({ code }) => {
      this.child = null;
      const detail = this.stderrTail.trim();
      this.failAll(
        new Error(
          `OCR sidecar 已退出（代码 ${code ?? "unknown"}）${detail ? `：${detail}` : ""}`
        )
      );
    });

    try {
      this.child = await command.spawn();
      // A large PyInstaller onefile executable may need time to unpack on its
      // first launch, especially while antivirus software scans it.
      await this.request("ping", {}, undefined, 90_000);
    } catch (error) {
      const child = this.child;
      this.child = null;
      if (child) {
        try {
          await child.kill();
        } catch {
          // The process may already have exited.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const detail = this.stderrTail.trim();
      throw new Error(`无法启动 OCR sidecar：${message}${detail ? `；${detail}` : ""}`);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.request("shutdown", {}, undefined, 5_000);
    } catch {
      await child.kill();
    } finally {
      this.child = null;
    }
  }

  async forceStop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failAll(new Error("OCR sidecar 已被强制停止"));
    await child.kill();
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    onEvent?: (event: SidecarEvent) => void,
    timeoutMs: number | null = 15 * 60_000
  ): Promise<T> {
    if (!this.child) throw new Error("OCR sidecar 尚未启动");

    const id = createId();
    const promise = new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onEvent,
        timer
      });
    });

    try {
      await this.child.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (error) {
      const item = this.pending.get(id);
      if (item?.timer) clearTimeout(item.timer);
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  private consumeStdout(chunk: string): void {
    const candidate = this.stdoutBuffer + chunk;

    try {
      const message = JSON.parse(candidate.trim()) as ProtocolMessage;
      this.stdoutBuffer = "";
      this.handleMessage(message);
      return;
    } catch {
      // A native process may deliver either one line or a larger chunk.
    }

    const lines = candidate.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line) as ProtocolMessage);
      } catch {
        console.warn("忽略 sidecar 的非协议输出：", line);
      }
    }
  }

  private handleMessage(message: ProtocolMessage): void {
    if (!message.id) return;
    const request = this.pending.get(message.id);
    if (!request) return;

    if (message.type === "event") {
      request.onEvent?.({
        event: message.event ?? "status",
        message: message.message,
        page: message.page,
        pageCount: message.pageCount
      });
      return;
    }

    if (request.timer) clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.type === "error") {
      request.reject(new SidecarRequestError(message.message ?? "OCR sidecar 返回错误", message.details ?? ""));
    } else {
      request.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export const ocrSidecar = new OcrSidecarClient();
