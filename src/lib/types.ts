export interface OcrBlock {
  text: string;
  score: number | null;
  polygon: number[][];
  box: number[];
  id?: string;
  direction?: "horizontal" | "vertical";
  fontSize?: number;
  source?: "pdf-text" | "ocr";
  role?: "body" | "ruby" | "ruby-unmatched";
  ruby?: Array<{ start: number; end: number; text: string; alignment?: string }>;
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
  schemaVersion?: number;
  rawText?: string;
  width?: number;
  height?: number;
  source?: "pdf-text" | "ocr";
  rubyEnabled?: boolean;
}

export interface OcrResult {
  path: string;
  profile: ModelProfile;
  resultType: "text" | "table" | "document";
  cancelled: boolean;
  text: string;
  pageCount: number;
  totalPageCount: number;
  selectedPageCount?: number;
  pageRange?: string;
  rotation?: number;
  blockCount: number;
  tableCount: number;
  rawTableCount: number;
  elapsedMs: number;
  pages: OcrPage[];
  tables: OcrTable[];
  /** True while pages are still arriving; merged tables are finalized once. */
  partial?: boolean;
  completedPageCount?: number;
  scoreThreshold?: number;
  sourceSize?: number;
  sourceMtimeNs?: string;
  pdfSource?: "auto" | "ocr";
  rubyEnabled?: boolean;
}

export interface SidecarEvent {
  event: string;
  message?: string;
  page?: number;
  pageCount?: number;
  pageResult?: OcrPage;
  elapsedMs?: number;
}

export interface ModelCacheEntry {
  name: string;
  installed: boolean;
  sizeBytes: number;
  fileCount: number;
  state?: "ready" | "incomplete" | "missing";
}

export interface ModelCacheStatus {
  cacheRoot: string;
  profile: ModelProfile;
  mode: RecognitionMode;
  installed: boolean;
  sizeBytes: number;
  modelCount: number;
  installedCount: number;
  models: ModelCacheEntry[];
}

export interface DiagnosticInfo {
  appVersion: string;
  sidecarRunning: boolean;
  sidecarStderr: string;
  platform?: string;
  python?: string;
  frozen?: boolean;
  executable?: string;
  cacheRoot?: string;
  engineReady?: boolean;
  profile?: string | null;
  mode?: string | null;
  packages?: Record<string, string | null>;
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
  batchId: string;
  batchIndex: number;
  path: string;
  fileName: string;
  status: OcrTaskStatus;
  currentPage?: number;
  totalPages?: number;
  result?: OcrResult;
  error?: string;
  resultType: RecognitionMode;
  missing?: boolean;
  revision?: number;
  exportedRevision?: number;
  textEdited?: boolean;
  pageRange?: string;
  rotation?: number;
  sourcePageCount?: number;
  sourcePage?: number;
  /** An interrupted partial PDF may resume when its source/options still match. */
  resumeEligible?: boolean;
  sourceSize?: number;
  sourceMtimeNs?: string;
}
