// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ImagePreview from "./ImagePreview.vue";

describe("rotated image layout", () => {
  it("swaps the layout dimensions as well as rotating the pixels on screen", async () => {
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const wrapper = mount(ImagePreview, { props: { src: "test.png", alt: "test", rotation: 0 } });
    try {
      const stage = wrapper.find(".rotation-stage").element;
      Object.defineProperty(stage, "clientWidth", { value: 536 });
      Object.defineProperty(stage, "clientHeight", { value: 436 });
      const image = wrapper.find("img");
      Object.defineProperty(image.element, "naturalWidth", { value: 800 });
      Object.defineProperty(image.element, "naturalHeight", { value: 400 });
      resize();
      await image.trigger("load");
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("width: 500px");
      await wrapper.setProps({ rotation: 90 });
      await flushPromises();
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("width: 200px");
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("height: 400px");
      expect(image.attributes("style")).toContain("rotate(90deg)");
    } finally {
      wrapper.unmount();
      vi.unstubAllGlobals();
    }
  });
});
