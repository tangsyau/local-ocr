import { describe, expect, it } from "vitest";
import { defaultSettings, restoreSession, sessionHeader } from "./session";

describe("local session recovery", () => {
  it("restores completed results and converts interrupted work to a waiting task", () => {
    const restored = restoreSession({ schema: 1, settings: defaultSettings, selectedTaskId: "two", tasks: [
      { id: "one", path: "/one.png", status: "completed", result: { text: "人工校对", pages: [], tables: [] } },
      { id: "two", path: "/two.pdf", status: "running" }
    ] });
    expect(restored?.tasks[0].result?.text).toBe("人工校对");
    expect(restored?.tasks[1].status).toBe("queued");
    expect(restored?.selectedTaskId).toBe("two");
    expect(restored?.tasks[1].error).toContain("下一页继续");
    expect(restored?.schema).toBe(2);
    expect(restored?.needsPageMigration).toBe(true);
  });

  it("restores the actual mode of old results instead of the current global mode", () => {
    const restored = restoreSession({ schema: 1, settings: { ...defaultSettings, mode: "text" }, selectedTaskId: "table", tasks: [{
      id: "table", path: "/old.pdf", status: "completed", result: {
        text: "cell", tables: [{ pageIndex: 0, endPageIndex: 0, tableIndex: 0, sourceTableCount: 1, score: .9, box: [], html: "", rows: [] }]
      }
    }] });
    expect(restored?.tasks[0].resultType).toBe("table");
    expect(restored?.tasks[0].result?.resultType).toBe("table");
    expect(restored?.tasks[0].result?.pages).toHaveLength(1);
  });

  it("stores task metadata separately from page checkpoints", () => {
    const restored = restoreSession({ schema: 1, settings: defaultSettings, selectedTaskId: "one", tasks: [{
      id: "one", path: "/one.pdf", status: "completed", textEdited: false,
      result: { text: "page", pages: [{ pageIndex: 0, text: "page", blocks: [], tables: [] }], tables: [] }
    }] })!;
    const header = sessionHeader(restored);
    expect(header.tasks[0].result?.pages).toEqual([]);
    expect(header.tasks[0].result?.tables).toEqual([]);
    expect(header.tasks[0].result?.text).toBe("");
  });

  it("hydrates schema-2 page records and reconstructs unedited text", () => {
    const pages = new Map([["one", [{ pageIndex: 3, text: "第四页", blocks: [], tables: [] }]]]);
    const restored = restoreSession({ schema: 2, settings: defaultSettings, selectedTaskId: "one", tasks: [{
      id: "one", path: "/one.pdf", status: "cancelled", resultType: "text",
      result: { text: "", pages: [], tables: [], totalPageCount: 10, selectedPageCount: 5 }
    }] }, pages);
    expect(restored?.needsPageMigration).toBe(false);
    expect(restored?.tasks[0].result?.text).toBe("第四页");
    expect(restored?.tasks[0].result?.pages[0].pageIndex).toBe(3);
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
