// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import TableResultViewer from "./TableResultViewer.vue";
import { displayTables, tableToTsv } from "../lib/table-results";
import type { OcrResult, OcrTable } from "../lib/types";

function wideTallTable(): OcrTable {
  return {
    pageIndex: 0,
    endPageIndex: 0,
    tableIndex: 0,
    sourceTableCount: 1,
    score: 0.95,
    box: [],
    html: "",
    rows: Array.from({ length: 50 }, (_, row) =>
      Array.from({ length: 15 }, (_, column) => ({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: row === 0 ? `列 ${column + 1}` : `${row}-${column}`,
        box: []
      }))
    )
  };
}

describe("TableResultViewer", () => {
  it("renders a top scrollbar before a tall table and keeps both directions synchronized", async () => {
    const wrapper = mount(TableResultViewer, { props: { tables: [wideTallTable()] } });
    const top = wrapper.find<HTMLElement>(".table-top-scroll");
    const body = wrapper.find<HTMLElement>(".table-scroll");

    expect(top.exists()).toBe(true);
    expect(top.element.compareDocumentPosition(body.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    Object.defineProperty(body.element, "scrollWidth", { configurable: true, value: 1_600 });
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.find<HTMLElement>(".table-scroll-spacer").element.style.width).toBe("1600px");

    top.element.scrollLeft = 320;
    await top.trigger("scroll");
    expect(body.element.scrollLeft).toBe(320);

    body.element.scrollLeft = 525;
    await body.trigger("scroll");
    expect(top.element.scrollLeft).toBe(525);
  });

  it("creates tab-separated clipboard text", () => {
    const table = wideTallTable();
    table.rows = [table.rows[0].slice(0, 2), table.rows[1].slice(0, 2)];
    expect(tableToTsv(table)).toBe("列 1\t列 2\n1-0\t1-1");
  });

  it("switches between merged and raw per-page tables without re-recognition", () => {
    const first = wideTallTable();
    const second = { ...wideTallTable(), pageIndex: 1, endPageIndex: 1 };
    const merged = { ...wideTallTable(), endPageIndex: 1, sourceTableCount: 2 };
    const result: OcrResult = {
      path: "example.pdf",
      profile: "fast",
      resultType: "table",
      cancelled: false,
      text: "",
      pageCount: 2,
      totalPageCount: 2,
      blockCount: 0,
      tableCount: 1,
      rawTableCount: 2,
      elapsedMs: 1,
      pages: [{ pageIndex: 0, text: "", blocks: [], tables: [first] }, { pageIndex: 1, text: "", blocks: [], tables: [second] }],
      tables: [merged]
    };

    expect(displayTables(result, true)).toEqual([merged]);
    expect(displayTables(result, false)).toEqual([first, second]);
  });
});
