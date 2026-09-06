<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";
import type { ComponentPublicInstance } from "vue";
import type { OcrTable } from "../lib/types";
const props = defineProps<{ tables: OcrTable[]; viewKey?: string }>();
const resultScroller = ref<HTMLElement | null>(null);
const horizontal = ref<HTMLElement | null>(null);
const active = ref(0);
const bodyScrollers = new Map<number, HTMLElement>();
const widths = ref<number[]>([]);
let observer: ResizeObserver | null = null;
function registerBody(value: Element | ComponentPublicInstance | null, index: number): void {
  const previous = bodyScrollers.get(index);
  if (previous) observer?.unobserve(previous);
  if (value instanceof HTMLElement) { bodyScrollers.set(index, value); observer?.observe(value); }
  else bodyScrollers.delete(index);
}
function measureAll(): void {
  const next = props.tables.map((_, index) => ((bodyScrollers.get(index)?.scrollWidth ?? 0) - (bodyScrollers.get(index)?.clientWidth ?? 0) + (horizontal.value?.clientWidth ?? 0)));
  if (next.length !== widths.value.length || next.some((value,index) => value !== widths.value[index])) widths.value = next;
}
// Use the live scroll ranges: scrollbar gutters and fractional layout can make
// the two viewports differ, including between a resize and the next measurement.
function syncScroll(source: HTMLElement, target: HTMLElement): void {
  const sourceRange = Math.max(0, source.scrollWidth - source.clientWidth);
  const targetRange = Math.max(0, target.scrollWidth - target.clientWidth);
  const next = sourceRange ? Math.min(1, Math.max(0, source.scrollLeft / sourceRange)) * targetRange : 0;
  if (Math.abs(target.scrollLeft - next) > 0.5) target.scrollLeft = next;
}
function scrollFromTop(): void {
  const body = bodyScrollers.get(active.value);
  if (body && horizontal.value) syncScroll(horizontal.value, body);
}
function scrollFromBody(index: number): void {
  const body = bodyScrollers.get(index);
  if (index === active.value && horizontal.value && body) syncScroll(body, horizontal.value);
}
async function activate(index: number): Promise<void> {
  active.value = index;
  await nextTick();
  scrollFromBody(index);
}
function trackVisibleTable(): void {
  const viewport = resultScroller.value;
  if (!viewport) return;
  const top = viewport.getBoundingClientRect().top;
  const cards = Array.from(viewport.querySelectorAll<HTMLElement>(".table-card"));
  const index = cards.findIndex(card => card.getBoundingClientRect().bottom > top + 32);
  if (index >= 0 && index !== active.value) void activate(index);
}
watch(() => props.viewKey, async () => {
  active.value = 0;
  for (const body of bodyScrollers.values()) body.scrollLeft = 0;
  if (resultScroller.value) resultScroller.value.scrollTop = 0;
  await nextTick();
  if (horizontal.value) horizontal.value.scrollLeft = 0;
});
watch(() => props.tables.length, () => { if (active.value >= props.tables.length) void activate(0); });
onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measureAll);
    for (const body of bodyScrollers.values()) observer.observe(body);
    if (horizontal.value) observer.observe(horizontal.value);
  }
  window.addEventListener("resize", measureAll);
  void nextTick(measureAll);
});
onUpdated(() => void nextTick(measureAll));
onBeforeUnmount(() => { observer?.disconnect(); window.removeEventListener("resize", measureAll); });
</script>
<template>
  <div class="table-viewer">
    <div class="table-horizontal-tools">
      <span>横向滚动 · 当前第 {{ (tables[active]?.pageIndex ?? 0) + 1 }} 页表格 {{ (tables[active]?.tableIndex ?? 0) + 1 }}</span>
      <div ref="horizontal" class="table-top-scroll" tabindex="0" aria-label="当前表格横向滚动条" @scroll="scrollFromTop">
        <div class="table-scroll-spacer" :style="{width: `${widths[active] ?? 0}px`}"></div>
      </div>
    </div>
    <div ref="resultScroller" class="table-results" tabindex="0" aria-label="表格识别结果，可上下滚动" @scroll="trackVisibleTable">
      <section v-for="(table, index) in tables" :key="`${table.pageIndex}-${table.tableIndex}-${index}`" class="table-card">
        <div class="table-card-header"><div class="table-card-title">
          <strong>第 {{ (table.pageIndex ?? 0) + 1 }}<template v-if="table.endPageIndex != null && table.endPageIndex !== table.pageIndex">–{{ table.endPageIndex + 1 }}</template> 页 · 表格 {{ table.tableIndex + 1 }}</strong>
          <small>{{ table.score === null ? "结构已恢复" : `定位置信度 ${(table.score * 100).toFixed(1)}%` }}（不代表文字正确率）</small>
        </div></div>
        <div :ref="element => registerBody(element, index)" class="table-scroll" tabindex="0" aria-label="表格内容，可左右滚动" @scroll="scrollFromBody(index)" @pointerdown="activate(index)" @focus="activate(index)">
          <table><caption class="visually-hidden">第 {{ (table.pageIndex ?? 0) + 1 }} 页表格 {{ table.tableIndex + 1 }}</caption><tbody>
            <tr v-for="(row, rowIndex) in table.rows" :key="rowIndex"><td v-for="cell in row" :key="`${cell.row}-${cell.column}`" :rowspan="cell.rowSpan" :colspan="cell.colSpan">{{ cell.text }}</td></tr>
          </tbody></table>
        </div>
      </section>
    </div>
  </div>
</template>
