import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const input = resolve(root, "assets/icon-source.svg");
const output = resolve(root, "src-tauri/icons");
const cli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");

function generate(destination, sizes = []) {
  const args = [cli, "icon", input, "--output", destination];
  for (const size of sizes) args.push("--png", String(size));
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed (${result.status ?? result.signal})`);
}

// Tauri emits the ICO, ICNS and standard PNG resources from this one SVG.
generate(output);
const temporary = await mkdtemp(join(tmpdir(), "local-ocr-icons-"));
try {
  // Keep the existing 64px resource and the 1024px source preview in sync too.
  generate(temporary, [64, 1024]);
  await copyFile(join(temporary, "64x64.png"), join(output, "64x64.png"));
  await copyFile(join(temporary, "1024x1024.png"), join(output, "icon-source.png"));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
