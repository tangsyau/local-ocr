// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ImagePreview from "./ImagePreview.vue";

describe("rotated image layout", () => {
  it("swaps the layout dimensions as well as rotating the pixels on screen", async () => {
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const wrapper = mount(ImagePreview, { attachTo: document.body, props: { src: "test.png", alt: "test", rotation: 0 } });
    try {
      const stage = wrapper.find(".rotation-stage").element;
      (stage as HTMLElement).style.padding = "18px";
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

  it("recovers after leaving focus mode and respects actual preview padding", async () => {
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const wrapper = mount(ImagePreview, { attachTo: document.body, props: { src: "test.png", alt: "test", rotation: 90 } });
    try {
      const stage = wrapper.find(".rotation-stage").element as HTMLElement;
      stage.style.padding = "12px 20px";
      let visible = false;
      Object.defineProperty(stage, "clientWidth", { get: () => visible ? 240 : 0 });
      Object.defineProperty(stage, "clientHeight", { get: () => visible ? 156 : 0 });
      const image = wrapper.find("img");
      Object.defineProperty(image.element, "naturalWidth", { value: 800 });
      Object.defineProperty(image.element, "naturalHeight", { value: 400 });
      resize();
      await image.trigger("load");
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("height: 0px");
      visible = true;
      resize();
      await flushPromises();
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("width: 66px");
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("height: 132px");
      await wrapper.setProps({ rotation: 180 });
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("width: 200px");
      expect(wrapper.find(".rotation-box").attributes("style")).toContain("height: 100px");
    } finally {
      wrapper.unmount();
      vi.unstubAllGlobals();
    }
  });
});
