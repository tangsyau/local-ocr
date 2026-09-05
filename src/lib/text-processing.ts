import type { OcrBlock, OcrPage, OcrResult } from "./types";

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
const listStart = /^(?:[•●■◆・※]|[-*]\s|\d+[.)、]\s*|[（(]\d+[）)]|[一二三四五六七八九十]+[、．])/u;
const dialogue = /^[「『“]/u;
const cjk = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
const han = /[\u3400-\u9fff\uf900-\ufaff]/u;

/** Conservative cleanup for OCR/PDF text in smart and continuous modes. */
export function normalizeSmartText(value: string): string {
  let text = value.replace(/\r\n?/gu, "\n");
  // Whitespace-only lines are noise in extracted PDF text; retain one paragraph gap.
  text = text.replace(/[ \t\u3000]+(?=\n)/gu, "").replace(/\n[ \t\u3000]+/gu, "\n").replace(/\n{3,}/gu, "\n\n");
  // Remove OCR spaces around Han characters, but preserve spaces inside Latin words.
  text = text.replace(/(?<=[\u3400-\u9fff\uf900-\ufaff])[ \t\u3000]+(?=[\u3400-\u9fff\uf900-\ufaff])/gu, "")
    .replace(/(?<=[\u3400-\u9fff\uf900-\ufaff])[ \t\u3000]+(?=[，。！？、；：,.!?;:()（）])/gu, "")
    .replace(/(?<=[，。！？、；：,.!?;:()（）])[ \t\u3000]+(?=[\u3400-\u9fff\uf900-\ufaff])/gu, "");
  text = text.replace(/([（(])[ \t\u3000]+/gu, "$1").replace(/[ \t\u3000]+([）)])/gu, "$1");
  text = text.replace(/([A-Za-z0-9])[ \t]+([A-Za-z0-9])/gu, "$1 $2");
  const punctuation: Record<string,string> = { ",":"，", ".":"。", ";":"；", ":":"：", "!":"！", "?":"？", "(":"（", ")":"）" };
  const chars = Array.from(text);
  for (let i=0; i<chars.length; i++) {
    const replacement = punctuation[chars[i]];
    if (!replacement) continue;
    const previous = chars.slice(0,i).reverse().find(c => !/[ \t\u3000]/u.test(c)) ?? "";
    const next = chars.slice(i+1).find(c => !/[ \t\u3000]/u.test(c)) ?? "";
    if (!cjk.test(previous) && !cjk.test(next)) continue;
    if (chars[i] === "." && /\d/u.test(previous) && /\d/u.test(next)) continue;
    chars[i] = replacement;
  }
  return chars.join("");
}
function normalizeMarkup(value: string): string {
  return value.split(/(<[^>]*>|&(?:amp|lt|gt|quot|#39);)/gu).map((part, index) =>
    index % 2 ? part : normalizeSmartText(part)).join("");
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

function separator(a: Line, b: Line, mode: TextSettings["textMode"], pageBoundary = false): string {
  if (mode === "original") return pageBoundary ? "\n\n" : "\n";
  if (listStart.test(b.base) || dialogue.test(b.base)) return "\n\n";
  const x = a.block, y = b.block;
  if (mode === "smart") {
    if (pageBoundary && endSentence.test(a.base.trim())) return "\n\n";
    if (x.direction !== y.direction) return "\n\n";
    if (x.fontSize && y.fontSize && Math.max(x.fontSize,y.fontSize)/Math.min(x.fontSize,y.fontSize) > 1.22) return "\n\n";
    if (!pageBoundary && x.box.length === 4 && y.box.length === 4) {
      const vertical = x.direction === "vertical";
      const axis = vertical ? 1 : 0, size = Math.max(x.fontSize ?? 0,y.fontSize ?? 0,1);
      const gap = vertical ? x.box[0]-y.box[2] : y.box[1]-x.box[3];
      if (gap > size*1.15 || y.box[axis]-x.box[axis] > size*.85) return "\n\n";
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
  let text = "", html = "";
  for (let i=0; i<kept.length; i++) {
    const line = kept[i], prev = kept[i-1];
    if (prev) {
      const sep = separator(prev,line,mode);
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
  const lines = blocks.map(block=> ({ ...renderBlock(block,settings.rubyFormat), base:block.text, block, margin:marginKey(block,page) }));
  const value=joinLines(lines,settings.textMode);
  entries.set(key,value); return value;
}

export function projectText(result: OcrResult, settings: TextSettings, edited = false, rawView = false): TextProjection {
  const raw = result.pages.map(p=>p.rawText ?? p.text).join("\n\n") || result.text;
  const warnings: string[] = [];
  if (rawView) return {text:raw,html:escapeHtml(raw),raw,warnings};
  if (edited) return {text:result.text,html:escapeHtml(result.text),raw,warnings:["显示手工校对版；整理设置不会覆盖校对内容。"]};
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
  if (settings.textMode !== "original") {
    text = normalizeSmartText(text);
    html = normalizeMarkup(html);
  }
  return {text,html,raw,warnings};
}
