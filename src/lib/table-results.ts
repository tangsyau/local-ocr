import type { OcrResult, OcrTable, OcrTableCell } from "./types";

export function rawTables(result: OcrResult | null): OcrTable[] {
  return result?.pages.flatMap((page) => page.tables) ?? [];
}

export function displayTables(result: OcrResult | null, mergeCrossPage: boolean): OcrTable[] {
  if (!result) return [];
  return mergeCrossPage ? result.tables : rawTables(result);
}

function cloneCell(cell: OcrTableCell): OcrTableCell {
  return { ...cell, box: [...cell.box] };
}

function cloneTable(table: OcrTable, pageIndex = table.pageIndex): OcrTable {
  return {
    ...table,
    pageIndex,
    endPageIndex: pageIndex,
    sourceTableCount: 1,
    box: [...table.box],
    rows: table.rows.map((row) => row.map(cloneCell))
  };
}

function columnCount(table: OcrTable): number {
  return Math.max(
    0,
    ...table.rows.flatMap((row) => row.map((cell) => cell.column + Math.max(1, cell.colSpan)))
  );
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function editSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + Number(left[leftIndex] !== right[rightIndex])
      ));
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function rowsMatch(left: OcrTableCell[], right: OcrTableCell[]): boolean {
  if (!left.length || left.length !== right.length) return false;
  const sameStructure = left.every((cell, index) =>
    cell.column === right[index].column && Math.max(1, cell.colSpan) === Math.max(1, right[index].colSpan)
  );
  if (!sameStructure) return false;
  const similarities = left.map((cell, index) => {
    const leftText = normalizedText(cell.text);
    const rightText = normalizedText(right[index].text);
    return leftText && rightText ? editSimilarity(leftText, rightText) : Number(leftText === rightText);
  });
  if (!left.some((cell, index) => normalizedText(cell.text) && normalizedText(right[index].text))) return false;
  const average = similarities.reduce((total, value) => total + value, 0) / similarities.length;
  const strongMatches = similarities.filter((value) => value >= 0.72).length;
  return average >= 0.82 && strongMatches >= Math.max(1, Math.ceil(similarities.length * 0.75));
}

function repeatedHeaderRows(left: OcrTable, right: OcrTable): number {
  if (columnCount(left) !== columnCount(right)) return 0;
  let repeated = 0;
  for (let index = 0; index < Math.min(3, left.rows.length, right.rows.length); index += 1) {
    if (!rowsMatch(left.rows[index], right.rows[index])) break;
    repeated += 1;
  }
  return repeated;
}

export function mergeTablePages(pages: OcrTable[][], pageIndices?: number[]): OcrTable[] {
  const merged: OcrTable[] = [];
  let previousPageTables: OcrTable[] = [];
  pages.forEach((pageTables, ordinal) => {
    const pageIndex = pageIndices?.[ordinal] ?? ordinal;
    const normalizedPage = pageTables.map((table) => cloneTable(table, pageIndex));
    if (normalizedPage.length === 1 && previousPageTables.length === 1 && merged.length) {
      const candidate = merged[merged.length - 1];
      if (candidate.endPageIndex === pageIndex - 1) {
        const repeatedRows = repeatedHeaderRows(candidate, normalizedPage[0]);
        if (repeatedRows) {
          const continuation = normalizedPage[0].rows.slice(repeatedRows).map((row) => row.map(cloneCell));
          const existingEnd = Math.max(
            0,
            ...candidate.rows.flatMap((row) => row.map((cell) => cell.row + Math.max(1, cell.rowSpan)))
          );
          const continuationStart = Math.min(
            existingEnd,
            ...continuation.flatMap((row) => row.map((cell) => cell.row))
          );
          const offset = existingEnd - continuationStart;
          for (const row of continuation) for (const cell of row) cell.row += offset;
          candidate.rows.push(...continuation);
          candidate.endPageIndex = pageIndex;
          candidate.sourceTableCount += 1;
          previousPageTables = normalizedPage;
          return;
        }
      }
    }
    merged.push(...normalizedPage);
    previousPageTables = normalizedPage;
  });
  return merged;
}

export function imageBatchTables(results: Array<OcrResult | null>, mergeCrossPage: boolean): OcrTable[] {
  const pages = results.map((result) => result?.pages.flatMap((page) => page.tables) ?? []);
  if (mergeCrossPage) return mergeTablePages(pages);
  return pages.flatMap((tables, pageIndex) => tables.map((table) => cloneTable(table, pageIndex)));
}

export function tableToTsv(table: OcrTable): string {
  const height = Math.max(
    0,
    ...table.rows.flatMap((row) => row.map((cell) => cell.row + Math.max(1, cell.rowSpan)))
  );
  const width = Math.max(
    0,
    ...table.rows.flatMap((row) => row.map((cell) => cell.column + Math.max(1, cell.colSpan)))
  );
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ""));
  for (const row of table.rows) {
    for (const cell of row) {
      grid[cell.row][cell.column] = cell.text.replace(/[\t\r\n]+/g, " ").trim();
    }
  }
  return grid.map((row) => row.join("\t")).join("\n");
}
