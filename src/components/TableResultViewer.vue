<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";
import type { ComponentPublicInstance } from "vue";
import type { OcrTable } from "../lib/types";

const props = defineProps<{ tables: OcrTable[] }>();

const topScrollers = new Map<number, HTMLElement>();
const bodyScrollers = new Map<number, HTMLElement>();
const spacerWidths = ref<number[]>([]);
let resizeObserver: ResizeObserver | null = null;

function asElement(value: Element | ComponentPublicInstance | null): HTMLElement | null {
  return value instanceof HTMLElement ? value : null;
}

function registerTop(value: Element | ComponentPublicInstance | null, index: number): void {
  const element = asElement(value);
  if (element) topScrollers.set(index, element);
  else topScrollers.delete(index);
}

function registerBody(value: Element | ComponentPublicInstance | null, index: number): void {
  const previous = bodyScrollers.get(index);
  if (previous && resizeObserver) resizeObserver.unobserve(previous);
  const element = asElement(value);
  if (element) {
    bodyScrollers.set(index, element);
    resizeObserver?.observe(element);
  } else {
    bodyScrollers.delete(index);
  }
}

function measureAll(): void {
  const widths = props.tables.map((_, index) => bodyScrollers.get(index)?.scrollWidth ?? 0);
  if (widths.some((width, index) => width !== spacerWidths.value[index])) spacerWidths.value = widths;
}

function scrollFromTop(index: number): void {
  const top = topScrollers.get(index);
  const body = bodyScrollers.get(index);
  if (top && body && body.scrollLeft !== top.scrollLeft) body.scrollLeft = top.scrollLeft;
}

function scrollFromBody(index: number): void {
  const top = topScrollers.get(index);
  const body = bodyScrollers.get(index);
  if (top && body && top.scrollLeft !== body.scrollLeft) top.scrollLeft = body.scrollLeft;
}

function resetScrollPositions(): void {
  for (const element of topScrollers.values()) element.scrollLeft = 0;
  for (const element of bodyScrollers.values()) element.scrollLeft = 0;
}

watch(() => props.tables, async () => {
  await nextTick();
  resetScrollPositions();
  measureAll();
});

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(measureAll);
    for (const element of bodyScrollers.values()) resizeObserver.observe(element);
  }
  window.addEventListener("resize", measureAll);
  void nextTick(measureAll);
});

onUpdated(() => void nextTick(measureAll));

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", measureAll);
});
</script>

<template>
  <div class="table-results" tabindex="0" aria-label="表格识别结果，可上下滚动">
    <section
      v-for="(table, tableListIndex) in tables"
      :key="`${table.pageIndex}-${table.endPageIndex}-${table.tableIndex}-${tableListIndex}`"
      class="table-card"
    >
      <div class="table-card-header">
        <div class="table-card-title">
          <strong>
            第 {{ (table.pageIndex ?? 0) + 1 }}<template v-if="table.endPageIndex != null && table.endPageIndex !== table.pageIndex">–{{ table.endPageIndex + 1 }}</template> 页
            · 表格 {{ table.tableIndex + 1 }}
          </strong>
          <small>{{ table.score === null ? "结构已恢复" : `定位置信度 ${(table.score * 100).toFixed(1)}%` }}</small>
        </div>
        <div
          :ref="(element) => registerTop(element, tableListIndex)"
          class="table-top-scroll"
          tabindex="0"
          aria-label="表格顶部横向滚动条"
          @scroll="scrollFromTop(tableListIndex)"
        >
          <div class="table-scroll-spacer" :style="{ width: `${spacerWidths[tableListIndex] ?? 0}px` }"></div>
        </div>
      </div>
      <div
        :ref="(element) => registerBody(element, tableListIndex)"
        class="table-scroll"
        tabindex="0"
        aria-label="表格内容，可左右滚动"
        @scroll="scrollFromBody(tableListIndex)"
      >
        <table>
          <tbody>
            <tr v-for="(row, rowIndex) in table.rows" :key="rowIndex">
              <td v-for="cell in row" :key="`${cell.row}-${cell.column}`" :rowspan="cell.rowSpan" :colspan="cell.colSpan">{{ cell.text }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
