import { describe, expect, it } from "vitest";
import { appendResultPage, beginStreamingResult, canResumeResult, completeStreamingResult } from "./result-state";
import type { OcrPage } from "./types";

const page = (index: number): OcrPage => ({ pageIndex: index, text: `page-${index}`, blocks: [], tables: [] });

describe("incremental page results", () => {
  it("appends pages in place and finalizes aggregate fields once", () => {
    const result = beginStreamingResult({ path: "/long.pdf", profile: "fast", mode: "text", threshold: .5,
      totalPageCount: 100, selectedPageCount: 100, pageRange: "", rotation: 0, sourceSize: 10, sourceMtimeNs: "20" });
    const pages = result.pages;
    const tables = result.tables;
    for (let index = 0; index < 100; index += 1) expect(appendResultPage(result, page(index))).toBe(true);
    expect(result.pages).toBe(pages);
    expect(result.tables).toBe(tables);
    expect(result.pageCount).toBe(100);
    expect(result.text.startsWith("page-0\n\npage-1")).toBe(true);
    const completed = completeStreamingResult(result, false, 123);
    expect(completed.partial).toBeUndefined();
    expect(completed.pages).toHaveLength(100);
    expect(completed.elapsedMs).toBe(123);
  });

  it("resumes only an unchanged PDF with exactly matching options", () => {
    const result = beginStreamingResult({ path: "/long.pdf", profile: "fast", mode: "text", threshold: .5,
      totalPageCount: 3, selectedPageCount: 3, pageRange: "", rotation: 0, sourceSize: 10, sourceMtimeNs: "20" });
    appendResultPage(result, page(0));
    const options = { profile: "fast" as const, mode: "text" as const, threshold: .5,
      pageRange: "", rotation: 0, sourceSize: 10, sourceMtimeNs: "20" };
    expect(canResumeResult(result, options)).toBe(true);
    expect(canResumeResult(result, { ...options, sourceMtimeNs: "21" })).toBe(false);
    expect(canResumeResult(result, { ...options, threshold: .8 })).toBe(false);
  });
});
