import { describe, expect, it } from "vitest";
import { imageBatchTables, mergeTablePages } from "./table-results";
import type { OcrResult, OcrTable } from "./types";

function table(pageIndex: number, value: string): OcrTable {
  return { pageIndex, endPageIndex: pageIndex, tableIndex: 0, sourceTableCount: 1, score: 1, box: [], html: "", rows: [
    [{ row: 0, column: 0, rowSpan: 1, colSpan: 1, text: "项目", box: [] }],
    [{ row: 1, column: 0, rowSpan: 1, colSpan: 1, text: value, box: [] }]
  ] };
}
describe("physical page identity", () => {
  it("does not merge nonconsecutive selected PDF pages", () => {
    const result = mergeTablePages([[table(1, "甲")], [table(4, "乙")]], [1, 4]);
    expect(result.map(value => value.pageIndex)).toEqual([1, 4]);
    expect(result).toHaveLength(2);
  });
  it("merges adjacent original pages while retaining their numbers", () => {
    const result = mergeTablePages([[table(3, "甲")], [table(4, "乙")]], [3, 4]);
    expect(result).toHaveLength(1);
    expect(result[0].pageIndex).toBe(3);
    expect(result[0].endPageIndex).toBe(4);
    expect(result[0].rows).toHaveLength(3);
  });
  it("image batches still use sequence positions, with empty tasks as gaps", () => {
    const a = { pages: [{ tables: [table(0, "甲")] }] } as OcrResult;
    const b = { pages: [{ tables: [table(0, "乙")] }] } as OcrResult;
    expect(imageBatchTables([a, b], true)).toHaveLength(1);
    expect(imageBatchTables([a, null, b], true)).toHaveLength(2);
  });
});
