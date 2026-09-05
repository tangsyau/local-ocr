import { mergeTablePages } from "./table-results";
import type { ModelProfile, OcrPage, OcrResult, RecognitionMode } from "./types";

function sortedUniquePages(pages: OcrPage[]): OcrPage[] {
  const byIndex = new Map<number, OcrPage>();
  for (const [position, page] of pages.entries()) {
    if (!page || typeof page.text !== "string" || !Array.isArray(page.blocks) || !Array.isArray(page.tables)) continue;
    const index = Number.isInteger(page.pageIndex) ? Number(page.pageIndex) : position;
    byIndex.set(index, { ...page, pageIndex: index });
  }
  return [...byIndex.values()].sort((left, right) => Number(left.pageIndex) - Number(right.pageIndex));
}

export function inferResultMode(value: Partial<OcrResult>, taskMode?: unknown): RecognitionMode {
  if (value.resultType === "table" || taskMode === "table") return "table";
  if ((value.tables?.length ?? 0) || value.pages?.some((page) => page.tables?.length)) return "table";
  return "text";
}

export function finalizeResult(value: Partial<OcrResult>, pagesValue: OcrPage[], textEdited = false): OcrResult {
  let pages = sortedUniquePages(pagesValue);
  if (!pages.length && (value.text || value.tables?.length)) {
    pages = [{ pageIndex: 0, text: String(value.text || ""), blocks: [], tables: value.tables ?? [] }];
  }
  const mode = inferResultMode({ ...value, pages });
  const tables = mode === "table"
    ? mergeTablePages(pages.map((page) => page.tables), pages.map((page) => Number(page.pageIndex)))
    : [];
  const generatedText = pages.map((page) => page.text).filter(Boolean).join("\n\n");
  return {
    path: String(value.path || ""),
    profile: value.profile === "accurate" ? "accurate" : "fast",
    resultType: mode,
    cancelled: value.cancelled === true,
    partial: value.partial === true,
    text: textEdited && typeof value.text === "string" ? value.text : generatedText || String(value.text || ""),
    pageCount: pages.length,
    completedPageCount: pages.length,
    totalPageCount: Math.max(pages.length, Number(value.totalPageCount) || 0),
    selectedPageCount: Math.max(pages.length, Number(value.selectedPageCount) || 0),
    pageRange: typeof value.pageRange === "string" ? value.pageRange : "",
    rotation: [0, 90, 180, 270].includes(value.rotation ?? 0) ? value.rotation ?? 0 : 0,
    scoreThreshold: Number.isFinite(value.scoreThreshold) ? Number(value.scoreThreshold) : undefined,
    sourceSize: Number.isFinite(value.sourceSize) ? Number(value.sourceSize) : undefined,
    sourceMtimeNs: typeof value.sourceMtimeNs === "string" ? value.sourceMtimeNs : undefined,
    pdfSource: value.pdfSource ?? "ocr",
    rubyEnabled: value.rubyEnabled === true,
    blockCount: pages.reduce((sum, page) => sum + page.blocks.length, 0),
    rawTableCount: pages.reduce((sum, page) => sum + page.tables.length, 0),
    tableCount: tables.length,
    elapsedMs: Math.max(0, Number(value.elapsedMs) || 0),
    pages,
    tables
  };
}

export function beginStreamingResult(options: {
  path: string; profile: ModelProfile; mode: RecognitionMode; threshold: number;
  totalPageCount: number; selectedPageCount: number; pageRange: string; rotation: number;
  sourceSize?: number; sourceMtimeNs?: string; previous?: OcrResult; keepEditedText?: boolean;
  pdfSource?: "auto" | "ocr"; rubyEnabled?: boolean;
}): OcrResult {
  const base = options.previous
    ? finalizeResult(options.previous, options.previous.pages, options.keepEditedText === true)
    : finalizeResult({ path: options.path, profile: options.profile, resultType: options.mode,
        totalPageCount: options.totalPageCount, selectedPageCount: options.selectedPageCount }, []);
  return {
    ...base,
    path: options.path, profile: options.profile, resultType: options.mode,
    cancelled: false, partial: true,
    totalPageCount: options.totalPageCount,
    selectedPageCount: options.selectedPageCount,
    pageRange: options.pageRange,
    rotation: options.rotation,
    scoreThreshold: options.threshold,
    sourceSize: options.sourceSize,
    sourceMtimeNs: options.sourceMtimeNs,
    pdfSource: options.pdfSource ?? "ocr", rubyEnabled: options.rubyEnabled === true,
    // During streaming, show raw tables. Cross-page merging is finalized once.
    tables: base.pages.flatMap((page) => page.tables),
    tableCount: base.rawTableCount
  };
}

export function appendResultPage(result: OcrResult, page: OcrPage, keepEditedText = false): boolean {
  if (result.pages.some((item) => item.pageIndex === page.pageIndex)) return false;
  const appended = !result.pages.length || Number(result.pages[result.pages.length - 1].pageIndex) < Number(page.pageIndex);
  if (appended) result.pages.push(page);
  else result.pages.splice(result.pages.findIndex((item) => Number(item.pageIndex) > Number(page.pageIndex)), 0, page);
  if (appended || keepEditedText) result.text = [result.text, page.text].filter(Boolean).join("\n\n");
  else result.text = result.pages.map((item) => item.text).filter(Boolean).join("\n\n");
  result.pageCount = result.pages.length;
  result.completedPageCount = result.pages.length;
  result.blockCount += page.blocks.length;
  result.rawTableCount += page.tables.length;
  result.tables.push(...page.tables);
  result.tableCount = result.tables.length;
  return true;
}

export function completeStreamingResult(result: OcrResult, cancelled: boolean, elapsedMs: number): OcrResult {
  return finalizeResult({ ...result, cancelled, partial: false, elapsedMs }, result.pages, true);
}

export function canResumeResult(result: OcrResult | undefined, options: {
  profile: ModelProfile; mode: RecognitionMode; threshold: number; pageRange: string; rotation: number;
  sourceSize?: number; sourceMtimeNs?: string;
  pdfSource?: "auto" | "ocr"; rubyEnabled?: boolean;
}): boolean {
  if (!result?.pages.length || result.pageCount >= (result.selectedPageCount ?? result.totalPageCount)) return false;
  return result.profile === options.profile && result.resultType === options.mode
    && result.scoreThreshold === options.threshold && (result.pageRange ?? "") === options.pageRange
    && (result.rotation ?? 0) === options.rotation
    && result.sourceSize === options.sourceSize && result.sourceMtimeNs === options.sourceMtimeNs
    && (result.pdfSource ?? "ocr") === (options.pdfSource ?? "ocr")
    && (result.rubyEnabled === true) === (options.rubyEnabled === true)
    && options.sourceSize !== undefined && Boolean(options.sourceMtimeNs);
}
