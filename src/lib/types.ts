export interface OcrBlock {
  text: string;
  score: number;
  polygon: number[][];
  box: number[];
}

export interface OcrTableCell {
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  box: number[];
}

export interface OcrTable {
  pageIndex: number | null;
  endPageIndex: number | null;
  tableIndex: number;
  sourceTableCount: number;
  score: number | null;
  box: number[];
  html: string;
  rows: OcrTableCell[][];
}

export interface OcrPage {
  pageIndex: number | null;
  text: string;
  blocks: OcrBlock[];
  tables: OcrTable[];
}

export interface OcrResult {
  path: string;
  profile: ModelProfile;
  resultType: "text" | "table" | "document";
  cancelled: boolean;
  text: string;
  pageCount: number;
  totalPageCount: number;
  blockCount: number;
  tableCount: number;
  rawTableCount: number;
  elapsedMs: number;
  pages: OcrPage[];
  tables: OcrTable[];
}

export interface SidecarEvent {
  event: string;
  message?: string;
  page?: number;
  pageCount?: number;
}

export type ModelProfile = "fast" | "accurate";
export type RecognitionMode = "text" | "table";

export type OcrTaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface OcrTask {
  id: string;
  path: string;
  fileName: string;
  status: OcrTaskStatus;
  currentPage?: number;
  totalPages?: number;
  result?: OcrResult;
  error?: string;
  resultType: RecognitionMode;
}
