import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;
const webkitGtk40 = process.env.VITE_WEBKITGTK_4_0 === "1";

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  build: {
    outDir: webkitGtk40 ? "dist-webkit4" : "dist",
    ...(webkitGtk40 ? { target: "safari13" } : {})
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/sidecar/**"] }
  }
});
