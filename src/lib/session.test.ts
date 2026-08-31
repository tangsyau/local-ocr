import { describe, expect, it } from "vitest";
import { defaultSettings, restoreSession } from "./session";

describe("local session recovery", () => {
  it("restores completed results and converts interrupted work to a waiting task", () => {
    const restored = restoreSession({ schema: 1, settings: defaultSettings, selectedTaskId: "two", tasks: [
      { id: "one", path: "/one.png", status: "completed", result: { text: "人工校对", pages: [], tables: [] } },
      { id: "two", path: "/two.pdf", status: "running" }
    ] });
    expect(restored?.tasks[0].result?.text).toBe("人工校对");
    expect(restored?.tasks[1].status).toBe("queued");
    expect(restored?.selectedTaskId).toBe("two");
    expect(restored?.tasks[1].error).toContain("所选的第一页");
  });

  it("rejects broken snapshots instead of silently replacing them", () => {
    expect(() => restoreSession({ schema: 10, tasks: [] })).toThrow();
    expect(() => restoreSession({ schema: 1, settings: defaultSettings, tasks: [{ id: "a" }] })).toThrow();
  });

  it("normalizes settings and never turns recovery into auto-recognition", () => {
    const restored = restoreSession({ schema: 1, tasks: [], settings: { ...defaultSettings, threshold: 10, formats: ["html", "bad"] } });
    expect(restored?.settings.threshold).toBe(1);
    expect(restored?.settings.formats).toEqual(["html"]);
    expect(restored).not.toHaveProperty("autoRun");
  });
});
