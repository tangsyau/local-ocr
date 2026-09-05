import type { OcrBlock, OcrPage, OcrResult } from "./types";
import { normalizeWithOffsets } from "./text-normalization";
export { normalizeSmartText } from "./text-normalization";

export interface TextSettings {
  pdfSource: "auto" | "ocr";
  rubyEnabled: boolean;
  rubyFormat: "ignore" | "parentheses" | "ruby";
  textMode: "original" | "smart" | "continuous";
  crossPageText: boolean;
}
export const defaultTextSettings: TextSettings = {
  pdfSource: "auto", rubyEnabled: false, rubyFormat: "parentheses", textMode: "smart", crossPageText: true
};
export function normalizeTextSettings(value: Partial<TextSettings> = {}): TextSettings {
  return { pdfSource: value.pdfSource === "ocr" ? "ocr" : "auto", rubyEnabled: value.rubyEnabled === true,
    rubyFormat: ["ignore", "ruby"].includes(value.rubyFormat ?? "") ? value.rubyFormat! : "parentheses",
    textMode: ["original", "continuous"].includes(value.textMode ?? "") ? value.textMode! : "smart",
    crossPageText: value.crossPageText !== false };
}
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Line { text: string; html: string; base: string; block: OcrBlock; margin: string }
interface PageText { lines: Line[]; text: string; html: string; first?: Line; last?: Line; legacy: boolean }
export interface TextProjection { text: string; html: string; raw: string; warnings: string[] }
const cache = new WeakMap<OcrPage, Map<string, PageText>>();
const endSentence = /[。！？.!?][」』”’"')）\]]*$/u;
const listStart = /^(?:[•●■◆・※]|[-*]\s|[0-9０-９]+(?:[.．](?![0-9０-９])|[)）、])\s*|[（(]\d+[）)]|[一二三四五六七八九十]+[、．])/u;
const dialogue = /^[「『“]/u;
const cjk = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
function normalizedBlock(block: OcrBlock): OcrBlock {
  const normalized = normalizeWithOffsets(block.text);
  if (normalized.text === block.text) return block;
  const originalOffsets = [0];
  for (const c of Array.from(block.text)) originalOffsets.push(originalOffsets[originalOffsets.length - 1] + c.length);
  const newCodepoints = new Map<number, number>();
  let offset = 0, count = 0;
  newCodepoints.set(0, 0);
  for (const c of Array.from(normalized.text)) { offset += c.length; newCodepoints.set(offset, ++count); }
  const ruby = (block.ruby ?? []).flatMap(r => {
    const start = newCodepoints.get(normalized.offsets[originalOffsets[r.start]]);
    const end = newCodepoints.get(normalized.offsets[originalOffsets[r.end]]);
    return start !== undefined && end !== undefined && start < end ? [{ ...r, start, end }] : [];
  });
  return { ...block, text: normalized.text, ruby };
}

function renderBlock(block: OcrBlock, format: TextSettings["rubyFormat"]): { text: string; html: string } {
  const chars = Array.from(block.text); // Python offsets count Unicode codepoints.
  let position = 0, text = "", html = "";
  for (const ruby of [...(block.ruby ?? [])].sort((a,b) => a.start-b.start)) {
    if (ruby.start < position || ruby.end > chars.length || ruby.start >= ruby.end) continue;
    const prefix = chars.slice(position, ruby.start).join("");
    const base = chars.slice(ruby.start, ruby.end).join("");
    text += prefix + base + (format === "ignore" ? "" : `（${ruby.text}）`);
    html += escapeHtml(prefix) + (format === "ruby" ? `<ruby>${escapeHtml(base)}<rt>${escapeHtml(ruby.text)}</rt></ruby>`
      : escapeHtml(base + (format === "ignore" ? "" : `（${ruby.text}）`)));
    position = ruby.end;
  }
  const suffix = chars.slice(position).join("");
  return { text: text + suffix, html: html + escapeHtml(suffix) };
}

function ordered(blocks: OcrBlock[]): OcrBlock[] {
  if (blocks.some(b => b.box.length !== 4)) return blocks;
  const vertical = blocks.filter(b => b.direction === "vertical").length > blocks.length * .65;
  if (vertical) return [...blocks].sort((a,b) => Math.abs(a.box[0]-b.box[0]) < Math.min(a.fontSize ?? 0,b.fontSize ?? 0)*.5
    ? a.box[1]-b.box[1] : b.box[0]-a.box[0]);
  // Conservative XY-cut for common two-column books, preserving spanning titles.
  const byX = [...blocks].sort((a,b) => a.box[0]-b.box[0]);
  let end = byX[0]?.box[2] ?? 0;
  for (let i=1; i<byX.length; i++) {
    const next = byX[i];
    if (next.box[0]-end > (next.fontSize ?? 12)*2 && i >= 2 && byX.length-i >= 2) {
      return [...byX.slice(0,i).sort((a,b)=>a.box[1]-b.box[1]), ...byX.slice(i).sort((a,b)=>a.box[1]-b.box[1])];
    }
    end = Math.max(end,next.box[2]);
  }
  return [...blocks].sort((a,b)=> Math.abs(a.box[1]-b.box[1]) < Math.min(a.fontSize ?? 0,b.fontSize ?? 0)*.4
    ? a.box[0]-b.box[0] : a.box[1]-b.box[1]);
}

function marginKey(block: OcrBlock, page: OcrPage): string {
  if (!page.height || block.box.length !== 4 || block.text.length > 100) return "";
  const [x,y,right,bottom] = block.box;
  const zone = bottom < page.height * .09 ? "top" : y > page.height * .91 ? "bottom" : "";
  if (!zone) return "";
  if (/^[\s\d０-９ivxlcdmIVXLCDM—–\-·第页頁]+$/u.test(block.text.trim())) return "page-number";
  return `${zone}:${block.text.trim().replace(/[\d０-９]+/gu,"#")}`;
}

interface BodyMetrics { size: number; step: number }
function bodyMetrics(lines: Line[]): BodyMetrics {
  const median = (values: number[], fallback: number) => {
    const sorted = values.filter(n => n > 0 && Number.isFinite(n)).sort((a,b) => a-b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : fallback;
  };
  const body = lines.filter(l => Array.from(l.base.trim()).length >= 12);
  const size = median((body.length ? body : lines).map(l => l.block.fontSize ?? 0), 20);
  const steps: number[] = [];
  for (let i=1; i<lines.length; i++) {
    const a=lines[i-1].block, b=lines[i].block;
    if (a.box.length !== 4 || b.box.length !== 4 || a.direction !== b.direction) continue;
    const step = a.direction === 'vertical' ? a.box[0]-b.box[0] : b.box[1]-a.box[1];
    if (step > size*.5 && step < size*2.5) steps.push(step);
  }
  return { size, step: median(steps, size*1.3) };
}

function separator(a: Line, b: Line, mode: TextSettings["textMode"], pageBoundary = false, metrics?: BodyMetrics): string {
  if (mode === "original") return pageBoundary ? "\n\n" : "\n";
  if (listStart.test(b.base.trimStart()) || dialogue.test(b.base.trimStart())) return "\n\n";
  const x = a.block, y = b.block;
  const heading = /^(?:第[一二三四五六七八九十百千〇零0-9]+[章节部篇]|Chapter\s+\d+|序言$|目录$)/iu;
  if (heading.test(b.base.trim()) || /^(?: {2,}|\t|\u3000)/u.test(b.base)) return "\n\n";
  // Never bridge columns or orientation changes merely because a sentence is unfinished.
  if (x.direction !== y.direction) return "\n\n";
  if (!pageBoundary && x.box.length === 4 && y.box.length === 4) {
    const axis = x.direction === 'vertical' ? 1 : 0;
    if (Math.min(x.box[axis+2],y.box[axis+2]) <= Math.max(x.box[axis],y.box[axis])) return "\n\n";
  }
  if (mode === "smart") {
    if (pageBoundary && endSentence.test(a.base.trim())) return "\n\n";
    let continuation = false;
    if (!pageBoundary && metrics && x.box.length === 4 && y.box.length === 4) {
      const vertical = x.direction === 'vertical', axis = vertical ? 1 : 0;
      const step = vertical ? x.box[0]-y.box[0] : y.box[1]-x.box[1];
      const ratio = Math.max(x.fontSize ?? metrics.size,y.fontSize ?? metrics.size) / Math.max(1,Math.min(x.fontSize ?? metrics.size,y.fontSize ?? metrics.size));
      continuation = Array.from(a.base.trim()).length >= 16 && !endSentence.test(a.base.trim())
        && ratio <= 1.4 && step > metrics.size*.5 && step <= metrics.step*1.8
        && Math.abs(y.box[axis]-x.box[axis]) <= metrics.size*1.2
        && Math.max(x.fontSize ?? 0,y.fontSize ?? 0) <= metrics.size*1.3;
    }
    if (!continuation && x.fontSize && y.fontSize && Math.max(x.fontSize,y.fontSize)/Math.min(x.fontSize,y.fontSize) > 1.22) return "\n\n";
    if (!pageBoundary && x.box.length === 4 && y.box.length === 4) {
      const vertical = x.direction === "vertical";
      const axis = vertical ? 1 : 0, size = Math.max(x.fontSize ?? 0,y.fontSize ?? 0,1);
      const gap = vertical ? x.box[0]-y.box[2] : y.box[1]-x.box[3];
      if (!continuation && (gap > size*1.15 || y.box[axis]-x.box[axis] > size*.85)) return "\n\n";
      const aLength = x.box[axis+2]-x.box[axis], bLength = y.box[axis+2]-y.box[axis];
      if (aLength < size*12 && bLength < size*12) return "\n"; // short poetry/headings
      if (aLength < bLength*.78 && endSentence.test(a.base.trim())) return "\n\n";
    }
  }
  if (/\s$/u.test(a.text) || /^\s/u.test(b.text)) return "";
  const aChars = Array.from(a.base);
  const last = aChars[aChars.length-1] ?? "", first = Array.from(b.base)[0] ?? "";
  if (cjk.test(last) || cjk.test(first) || /[\u00ad-]$/u.test(a.base)) return "";
  return " ";
}

function joinLines(lines: Line[], mode: TextSettings["textMode"], skip: Set<string> = new Set(), dictionary: Set<string> = new Set()): PageText {
  const kept = lines.filter(l => !skip.has(l.margin));
  const metrics = bodyMetrics(kept);
  let text = "", html = "";
  for (let i=0; i<kept.length; i++) {
    const line = kept[i], prev = kept[i-1];
    if (prev) {
      const sep = separator(prev,line,mode,false,metrics);
      // Soft hyphen explicitly encodes a discretionary break. A visible '-' may
      // belong to a real compound; preserve it without an authoritative lexicon.
      if (!sep.includes("\n") && text.endsWith("\u00ad")) { text=text.slice(0,-1); html=html.replace(/\u00ad$/u,""); }
      const left=prev.base.match(/([A-Za-z]{2,})-$/),right=line.base.match(/^([a-z]{2,})/);
      if (!sep.includes("\n") && left && right && dictionary.has((left[1]+right[1]).toLowerCase()) && text.endsWith("-") && html.endsWith("-")) {
        text=text.slice(0,-1); html=html.slice(0,-1);
      }
      text += sep; html += sep;
    }
    text += line.text; html += line.html;
  }
  return { lines: kept, text, html, first: kept[0], last: kept[kept.length-1], legacy:false };
}

function pageText(page: OcrPage, settings: TextSettings): PageText {
  const key = `${settings.textMode}:${settings.rubyFormat}`;
  let entries=cache.get(page);
  if (!entries) { entries=new Map(); cache.set(page,entries); }
  const existing=entries.get(key); if (existing) return existing;
  if (!page.schemaVersion || !page.blocks.length || page.tables.length) {
    return { lines:[], text:page.text, html:escapeHtml(page.text), legacy:true };
  }
  const rawBlocks = page.blocks.filter(b=> !["ruby","ruby-unmatched"].includes(b.role ?? ""));
  const blocks = settings.textMode === "original" ? rawBlocks : ordered(rawBlocks);
  const lines = blocks.map(block => {
    const display = settings.textMode === "original" ? block : normalizedBlock(block);
    return { ...renderBlock(display, settings.rubyFormat), base:display.text, block, margin:marginKey(block,page) };
  });
  const value=joinLines(lines,settings.textMode);
  entries.set(key,value); return value;
}

export function projectText(result: OcrResult, settings: TextSettings, edited = false, rawView = false): TextProjection {
  const raw = result.pages.map(p=>p.rawText ?? p.text).join("\n\n") || result.text;
  const warnings: string[] = [];
  if (rawView) return {text:raw,html:escapeHtml(raw),raw,warnings};
  if (edited) return {text:result.text,html:escapeHtml(result.text),raw,warnings:["显示手工校对版；整理设置不会覆盖校对内容。"]};
  if (result.resultType === "table") return {text:result.text,html:escapeHtml(result.text),raw,warnings};
  if (!result.pages.length) return {text:result.text,html:escapeHtml(result.text),raw,warnings};
  const pages = result.pages.map(p=>pageText(p,settings));
  const skip = new Set<string>();
  const complete = !result.partial && !result.cancelled && result.pageCount >= (result.selectedPageCount ?? result.totalPageCount);
  const dictionary=complete && settings.textMode !== "original"
    ? new Set((raw.match(/\b[A-Za-z]{4,}\b/g) ?? []).map(w=>w.toLowerCase())) : new Set<string>();
  if (complete && settings.textMode !== "original") {
    const frequency=new Map<string,number>();
    for (const page of pages) for (const key of new Set(page.lines.map(l=>l.margin).filter(Boolean))) frequency.set(key,(frequency.get(key)??0)+1);
    for (const [key,count] of frequency) if (key === "page-number" || (pages.length>=3 && count>=Math.max(3,Math.ceil(pages.length*.6)))) skip.add(key);
  }
  let text="", html="", previous:PageText|undefined;
  for (let i=0; i<pages.length; i++) {
    const page=(skip.size || dictionary.size) && !pages[i].legacy ? joinLines(pages[i].lines,settings.textMode,skip,dictionary) : pages[i];
    if (previous) {
      const consecutive=Number(result.pages[i].pageIndex)===Number(result.pages[i-1].pageIndex)+1;
      const sep=settings.crossPageText && complete && consecutive && previous.last && page.first
        ? separator(previous.last,page.first,settings.textMode,true) : "\n\n";
      if (!sep.includes("\n") && text.endsWith("\u00ad")) {text=text.slice(0,-1);html=html.replace(/\u00ad$/u,"");}
      text+=sep; html+=sep;
    }
    text+=page.text; html+=page.html; previous=page;
  }
  if (pages.some(p=>p.legacy) && result.resultType === "text") warnings.push("部分旧结果缺少版面坐标，已保留原文；重新识别后可使用完整整理功能。");
  if (settings.rubyEnabled && result.pages.some(p=>!p.rubyEnabled)) warnings.push("部分页面尚未提取注音；需重新识别，切换输出格式不会补识别。");
  const unmatched=result.pages.flatMap(p=>p.blocks).filter(b=>b.role === "ruby-unmatched").length;
  if (unmatched) warnings.push(`${unmatched} 处小字无法可靠绑定，未插入正文，可在原始结果查看。`);
  if (settings.rubyFormat !== "ignore" && result.pages.some(p=>p.blocks.some(b=>b.ruby?.some(r=>r.alignment === "estimated")))) warnings.push("部分注音按位置估算对应范围，请校对汉字与注音的绑定。");
  return {text,html,raw,warnings};
}
