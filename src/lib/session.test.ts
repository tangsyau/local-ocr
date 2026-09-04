// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { defaultSettings, loadSession, restoreSession, saveSession, type SavedSession } from "./session";

describe("local session recovery", () => {
  it("restores completed results and converts interrupted work to a waiting task", () => {
    const restored = restoreSession({ schema: 1, settings: defaultSettings, selectedTaskId: "two", tasks: [
      { id: "one", path: "/one.png", status: "completed", result: { text: "人工校对", pages: [], tables: [] } },
      { id: "two", path: "/two.pdf", status: "running" }
    ] });
    expect(restored?.tasks[0].result?.text).toBe("人工校对");
    expect(restored?.tasks[1].status).toBe("queued");
    expect(restored?.selectedTaskId).toBe("two");
    expect(restored?.tasks[1].error).toContain("已完成页面会保留");
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

  it("stores appended OCR pages separately and rebuilds derived text", async () => {
    const session: SavedSession = {
      schema: 1,
      savedAt: "2026-09-04T00:00:00Z",
      selectedTaskId: "pdf",
      settings: defaultSettings,
      tasks: [{
        id: "pdf", batchId: "pdf", batchIndex: 0, path: "/document.pdf", fileName: "document.pdf",
        status: "running", resultType: "text", resultGeneration: 1,
        result: {
          path: "/document.pdf", profile: "fast", resultType: "text", cancelled: false,
          text: "第一页", pageCount: 1, totalPageCount: 2, selectedPageCount: 2,
          blockCount: 0, rawTableCount: 0, tableCount: 0, elapsedMs: 1,
          pages: [{ pageIndex: 0, text: "第一页", blocks: [], tables: [] }], tables: []
        }
      }]
    };
    await saveSession(session);
    session.tasks[0].result!.pages.push({ pageIndex: 1, text: "第二页", blocks: [], tables: [] });
    session.tasks[0].result!.text = "第一页\n\n第二页";
    session.tasks[0].result!.pageCount = 2;
    session.tasks[0].status = "completed";
    await saveSession(session);

    const restored = await loadSession();
    expect(restored?.tasks[0].result?.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
    expect(restored?.tasks[0].result?.text).toBe("第一页\n\n第二页");

    session.tasks[0].resultGeneration = 2;
    session.tasks[0].result!.pages = [{ pageIndex: 0, text: "重新识别第一页", blocks: [], tables: [] }];
    session.tasks[0].result!.text = "重新识别第一页";
    session.tasks[0].result!.pageCount = 1;
    await saveSession(session);
    const replaced = await loadSession();
    expect(replaced?.tasks[0].result?.pages.map((page) => page.text)).toEqual(["重新识别第一页"]);
  });
});
