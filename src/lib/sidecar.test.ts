import { describe, expect, it, vi } from "vitest";
import { OcrSidecarClient } from "./sidecar";

const mock = vi.hoisted(() => ({ commands: [] as any[], sequence: 0, failWrite: false }));
vi.mock("./tauri-bridge", () => ({
  createId: () => String(++mock.sequence),
  createSidecarCommand: () => {
    const listeners: Record<string, (value: any) => void> = {};
    const child = { kill: vi.fn(async () => {}), write: vi.fn(async (line: string) => {
      if (mock.failWrite) throw new Error("pipe closed");
      const request = JSON.parse(line);
      if (request.method === "ping" || request.method === "shutdown") listeners.stdout(JSON.stringify({id: request.id, type: "result", result: {ok:true}}));
    }) };
    const command = { listeners, child, stdout: {on: (_: string, cb: any) => { listeners.stdout = cb; }},
      stderr: {on: (_: string, cb: any) => { listeners.stderr = cb; }}, on: (name: string, cb: any) => { listeners[name] = cb; },
      spawn: async () => child };
    mock.commands.push(command);
    return command;
  }
}));

describe("sidecar lifecycle", () => {
  it("ignores delayed close events from a previous process after restart", async () => {
    mock.failWrite = false;
    const client = new OcrSidecarClient();
    await client.start();
    const old = mock.commands.at(-1);
    await client.forceStop();
    await client.start();
    old.listeners.close({code: 0});
    expect(client.running).toBe(true);
    await client.stop();
  });

  it("rejects a failed pipe write and remains stoppable", async () => {
    mock.failWrite = false;
    const client = new OcrSidecarClient();
    await client.start();
    mock.failWrite = true;
    await expect(client.request("recognize", {}, undefined, null)).rejects.toThrow("pipe closed");
    mock.failWrite = false;
    await client.stop();
  });

  it("emits unexpected-exit callbacks and rejects pending work", async () => {
    mock.failWrite = false;
    const client = new OcrSidecarClient();
    const callback = vi.fn();
    client.onExit(callback);
    await client.start();
    const pending = client.request("recognize", {}, undefined, null);
    mock.commands.at(-1).listeners.close({code: 1});
    await expect(pending).rejects.toThrow("已退出");
    expect(client.running).toBe(false);
    expect(callback).toHaveBeenCalledOnce();
  });
});
