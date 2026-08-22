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

