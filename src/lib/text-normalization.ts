// Operate on source text, never on serialized HTML. Offsets let Ruby survive edits.
const eastAsian = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{3134f}]/u;
const han = /[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{3134f}]/u;
const kana = /[\u3040-\u30ff]/u;
const latin = /[A-Za-z0-9]/u;
interface Edit { start: number; end: number; text: string }
export interface NormalizedText { text: string; offsets: number[] }

function protectedMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  // Keep explicit code, URLs, email addresses, paths, filenames and versions intact.
  const pattern = /```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s<>"'，。！？；（）「」]+|www\.[^\s<>"'，。！？；（）「」]+|[\w.+-]+@[\w\u3400-\u9fff.-]+\.[A-Za-z]{2,}|[A-Za-z]:\\[^\r\n，。；！？]+|(?:\/[\w.-]+){2,}|\b[vV]?\d+(?:\.\d+){1,}(?:[-+][\w.-]+)?\b|[\w\u3400-\u9fff-]+\.(?:pdf|txt|html?|json|csv|xlsx?|docx?|png|jpe?g|exe)\b/gu;
  for (const m of text.matchAll(pattern)) mask.fill(1, m.index!, m.index! + m[0].length);
  return mask;
}

export function normalizeWithOffsets(value: string): NormalizedText {
  let text = value;
  let offsets = Array.from({ length: value.length + 1 }, (_, i) => i);
  function apply(edits: Edit[]): void {
    if (!edits.length) return;
    edits.sort((a, b) => a.start - b.start);
    const mapping = new Array<number>(text.length + 1);
    let cursor = 0, length = 0, output = "";
    for (const e of edits) {
      const prefix = text.slice(cursor, e.start);
      for (let i = cursor; i <= e.start; i++) mapping[i] = length + i - cursor;
      output += prefix + e.text; length += prefix.length;
      for (let i = e.start; i <= e.end; i++) {
        mapping[i] = length + Math.floor((i - e.start) * e.text.length / (e.end - e.start));
      }
      length += e.text.length; cursor = e.end;
    }
    for (let i = cursor; i <= text.length; i++) mapping[i] = length + i - cursor;
    output += text.slice(cursor);
    offsets = offsets.map(i => mapping[i]); text = output;
  }
  function replace(pattern: RegExp, replacement: (m: RegExpMatchArray) => string): void {
    const mask = protectedMask(text), edits: Edit[] = [];
    for (const m of text.matchAll(pattern)) {
      const start = m.index!, end = start + m[0].length;
      if (mask.subarray(start, end).some(Boolean)) continue;
      const next = replacement(m);
      if (next !== m[0]) edits.push({ start, end, text: next });
    }
    apply(edits);
  }
  replace(/\r\n?/g, () => "\n");
  // Numbering is a structural marker, not a sentence-ending period.
  replace(/^([ \t\u3000]*[0-9０-９]+)[.．](?=[ \t\u3000]*[\u3040-\u30ff\u3400-\u9fff])/gmu, m => m[1] + "．");
  replace(/[.．]{3,}/gu, m => {
    const before = text.slice(Math.max(0, m.index! - 2), m.index!);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 2);
    return eastAsian.test(before + after) ? "……" : m[0];
  });

  const mask = protectedMask(text), edits: Edit[] = [];
  const chars = Array.from(text), positions: number[] = [];
  let position = 0;
  for (const char of chars) { positions.push(position); position += char.length; }
  const left: string[] = [], right: string[] = [];
  let nearest = "";
  for (let i = 0; i < chars.length; i++) { left[i] = nearest; if (!/[ \t\u3000]/u.test(chars[i])) nearest = chars[i]; }
  nearest = "";
  for (let i = chars.length - 1; i >= 0; i--) { right[i] = nearest; if (!/[ \t\u3000]/u.test(chars[i])) nearest = chars[i]; }
  const set = (i: number, next: string) => {
    if (next !== chars[i] && !mask[positions[i]]) edits.push({ start: positions[i], end: positions[i] + chars[i].length, text: next });
  };
  const stack: number[] = [];
  const toWide: Record<string, string> = { ',': '，', '.': '。', ';': '；', ':': '：', '!': '！', '?': '？' };
  const toAscii: Record<string, string> = { '，': ',', '．': '.', '：': ':', '；': ';', '！': '!', '？': '?' };
  for (let i = 0; i < chars.length; i++) {
    if (mask[positions[i]]) continue;
    const char = chars[i];
    if (char === '\n') { stack.length = 0; continue; }
    if (char === '(' || char === '（') { stack.push(i); continue; }
    if (char === ')' || char === '）') {
      const start = stack.pop();
      if (start !== undefined) {
        const inside = chars.slice(start + 1, i).join('');
        const wide = eastAsian.test(inside + left[start] + right[i]);
        if (wide || /[A-Za-z]/u.test(inside)) { set(start, wide ? '（' : '('); set(i, wide ? '）' : ')'); }
      }
      continue;
    }
    const before = left[i], after = right[i];
    let beforeWord = before;
    if (/[)）"”']/u.test(before)) {
      let j = i-1;
      while (j >= 0 && /[ \t)）"”']/u.test(chars[j])) j--;
      beforeWord = chars[j] ?? '';
    }
    // Fullwidth time/decimal separators in unambiguous numeric expressions.
    if (/[0-9]/u.test(before) && /[0-9]/u.test(after)) {
      if (char === '．' || char === '：') set(i, toAscii[char]);
      continue;
    }
    if (toWide[char] && (eastAsian.test(before) || eastAsian.test(after))) {
      // Japanese comma style is preserved; normalize ASCII commas to 、 when kana is adjacent.
      set(i, char === ',' && kana.test(before + after) ? '、' : toWide[char]);
    } else if (toAscii[char] && /[A-Za-z]/u.test(beforeWord) && (latin.test(after) || !after || after === '\n')) {
      set(i, toAscii[char]);
    }
  }
  apply(edits);
  replace(/[ \t\u3000]+/gu, m => {
    const start = m.index!, end = start + m[0].length;
    const before = Array.from(text.slice(Math.max(0, start - 2), start)).pop() ?? '';
    const after = Array.from(text.slice(end, end + 2))[0] ?? '';
    if (!after || after === '\n') return ''; // whitespace-only / trailing spaces
    if (!before || before === '\n') return m[0]; // preserve paragraph indentation
    if (eastAsian.test(before) && eastAsian.test(after)) {
      // All-kana word spacing can be deliberate (e.g. children's books).
      return han.test(before + after) ? '' : m[0];
    }
    if (before === '（' || after === '）') return '';
    if (eastAsian.test(before) && /[，。！？、；：（]/u.test(after)) return '';
    if (/[，。！？、；：）]/u.test(before) && eastAsian.test(after)) return '';
    if (latin.test(before) && latin.test(after)) return ' ';
    return m[0];
  });
  replace(/\n{3,}/g, () => '\n\n');
  return { text, offsets };
}

export function normalizeSmartText(value: string): string { return normalizeWithOffsets(value).text; }
