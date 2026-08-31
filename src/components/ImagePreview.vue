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
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (stage.value) available.value = { width: stage.value.clientWidth - 36, height: stage.value.clientHeight - 36 };
  });
  if (stage.value) observer.observe(stage.value);
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
.rotation-stage { flex: 1; place-items: center; overflow: hidden; }
.rotation-box { position: relative; }
.rotation-box img { position: absolute; top: 50%; left: 50%; max-width: none; image-orientation: from-image; }
</style>
