<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
const props = defineProps<{ src: string; alt: string; rotation: number }>();
const emit = defineEmits<{ error: [] }>();
const stage = ref<HTMLElement | null>(null);
const natural = ref({ width: 0, height: 0 });
const available = ref({ width: 0, height: 0 });
let observer: ResizeObserver | null = null;
watch(() => props.src, () => { natural.value = { width: 0, height: 0 }; });
function loaded(event: Event): void {
  const image = event.target as HTMLImageElement;
  natural.value = { width: image.naturalWidth, height: image.naturalHeight };
}
function measureStage(): void {
  if (!stage.value) return;
  const style = getComputedStyle(stage.value);
  const padding = (value: string) => Number.parseFloat(value) || 0;
  available.value = {
    width: Math.max(0, stage.value.clientWidth - padding(style.paddingLeft) - padding(style.paddingRight)),
    height: Math.max(0, stage.value.clientHeight - padding(style.paddingTop) - padding(style.paddingBottom)),
  };
}
onMounted(() => {
  observer = new ResizeObserver(measureStage);
  if (stage.value) observer.observe(stage.value);
  measureStage();
});
onBeforeUnmount(() => observer?.disconnect());
const dimensions = computed(() => {
  const swapped = props.rotation % 180 !== 0;
  const width = swapped ? natural.value.height : natural.value.width;
  const height = swapped ? natural.value.width : natural.value.height;
  const scale = Math.max(0, Math.min(1, available.value.width / (width || 1), available.value.height / (height || 1)));
  return { width: width * scale, height: height * scale, imageWidth: natural.value.width * scale, imageHeight: natural.value.height * scale };
});
</script>

<template>
  <div ref="stage" class="image-stage rotation-stage">
    <div class="rotation-box" :style="{ width: `${dimensions.width}px`, height: `${dimensions.height}px` }">
      <img :key="src" :src="src" :alt="alt" @load="loaded" @error="emit('error')"
        :style="{ width: `${dimensions.imageWidth}px`, height: `${dimensions.imageHeight}px`, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }" />
    </div>
  </div>
</template>

<style scoped>
.rotation-stage { flex: 1 0 156px; min-height: 156px; place-items: center; overflow: hidden; }
.rotation-box { position: relative; }
.rotation-box img { position: absolute; top: 50%; left: 50%; max-width: none; image-orientation: from-image; }
</style>
