export interface OcrBlock {
  text: string;
  score: number;
  polygon: number[][];
  box: number[];
}

export interface OcrPage {
  pageIndex: number | null;
  text: string;
  blocks: OcrBlock[];
}

export interface OcrResult {
  path: string;
  profile: ModelProfile;
  resultType: "text" | "table" | "document";
  cancelled: boolean;
  text: string;
  pageCount: number;
  blockCount: number;
  elapsedMs: number;
  pages: OcrPage[];
}

export interface SidecarEvent {
  event: string;
  message?: string;
  page?: number;
}

export type ModelProfile = "fast" | "accurate";

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
  result?: OcrResult;
  error?: string;
  resultType: "text";
}
