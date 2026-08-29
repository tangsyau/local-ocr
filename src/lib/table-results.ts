import type { OcrResult, OcrTable } from "./types";

export function rawTables(result: OcrResult | null): OcrTable[] {
  return result?.pages.flatMap((page) => page.tables) ?? [];
}

export function displayTables(result: OcrResult | null, mergeCrossPage: boolean): OcrTable[] {
  if (!result) return [];
  return mergeCrossPage ? result.tables : rawTables(result);
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
