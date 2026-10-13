import { describe, expect, it } from "vitest";
import { imageBatchTables, mergeTablePages, projectTables, tableToTsv, displayTables, tableMergeIssues } from "./table-results";
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

describe("table text projection", () => {
  it("cleans per cell, preserves rows, spans and source, and is reversible", () => {
    const source = table(0, " 中 文 ( 说明 )\n\nHello,world\t3.14 ");
    source.rows[1][0].colSpan = 2;
    const before = JSON.stringify(source);
    const cleaned = projectTables([source], true)[0];
    expect(cleaned.rows[1][0].text).toBe("中文（说明）\n\nHello, world\t3.14");
    expect(cleaned.rows[1][0].colSpan).toBe(2);
    expect(cleaned.rows[1][0].row).toBe(1);
    expect(tableToTsv(cleaned)).toContain("中文（说明） Hello, world 3.14");
    expect(JSON.stringify(source)).toBe(before);
    expect(projectTables([source], false)[0]).toBe(source);
    expect(projectTables([cleaned], true)[0]).toEqual(cleaned);
  });
  it("protects code and numbers and escapes regenerated HTML", () => {
    const cleaned = projectTables([table(0, 'call(a,b) 3.14 https://a.example/a,b <script>')], true)[0];
    expect(cleaned.rows[1][0].text).toBe('call(a,b) 3.14 https://a.example/a,b <script>');
    expect(cleaned.html).toContain('&lt;script&gt;');
    expect(cleaned.html).not.toContain('<script>');
  });
});

describe("cross-page merge controls", () => {
  it("merges 120 consecutive pages and switches back to individual pages even for partial results", () => {
    const pages = Array.from({length:120}, (_, i) => ({pageIndex:i,tables:[table(i, `data ${i}`)]}));
    const result = {pages, tables:[], partial:true} as unknown as OcrResult;
    expect(displayTables(result,true)).toHaveLength(1);
    expect(displayTables(result,true)[0].sourceTableCount).toBe(120);
    expect(displayTables(result,true)[0].rows).toHaveLength(121);
    expect(displayTables(result,false)).toHaveLength(120);
    expect(tableMergeIssues(pages.map(p=>p.tables))).toEqual([]);
    expect(pages[0].tables[0].rows).toHaveLength(2);
  });
  it("explains missing headers, column mismatches and fragmented pages", () => {
    const first=table(0,"甲"), second=table(1,"乙");
    second.rows[0][0].text="无表头的续表";
    expect(tableMergeIssues([[first],[second]])[0]).toContain("重复表头");
    second.rows[0][0].colSpan=2;
    expect(tableMergeIssues([[first],[second]])[0]).toContain("列数");
    expect(tableMergeIssues([[first],[first,second]])[0]).toContain("2 张表");
    expect(tableMergeIssues([[first],[first]],[0,2])[0]).toContain("不连续");
  });
});
