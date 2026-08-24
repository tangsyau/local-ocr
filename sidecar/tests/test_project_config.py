from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ProjectConfigTests(unittest.TestCase):
    def test_sidecar_names_match_across_tauri_scope_and_frontend(self) -> None:
        tauri_config = json.loads(
            (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        capability = json.loads(
            (ROOT / "src-tauri" / "capabilities" / "default.json").read_text(encoding="utf-8")
        )
        frontend = (ROOT / "src" / "lib" / "sidecar.ts").read_text(encoding="utf-8")

        external_bins = tauri_config["bundle"]["externalBin"]
        self.assertEqual(external_bins, ["binaries/ocr-sidecar"])

        spawn_permissions = [
            item
            for item in capability["permissions"]
            if isinstance(item, dict) and item.get("identifier") == "shell:allow-spawn"
        ]
        self.assertEqual(len(spawn_permissions), 1)
        self.assertEqual(
            spawn_permissions[0]["allow"],
            [{"name": external_bins[0], "sidecar": True}],
        )

        match = re.search(r'createSidecarCommand\("([^"]+)"\)', frontend)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), external_bins[0])

    def test_windows_sidecar_hides_console_without_disabling_stdio(self) -> None:
        build_script = (ROOT / "scripts" / "build-sidecar.py").read_text(encoding="utf-8")
        rust_entry = (ROOT / "src-tauri" / "src" / "main.rs").read_text(encoding="utf-8")
        self.assertIn('command.extend(["--hide-console", "hide-early"])', build_script)
        self.assertNotIn('"--noconsole"', build_script)
        self.assertIn('windows_subsystem = "windows"', rust_entry)

    def test_desktop_window_starts_maximized_with_safe_fallback_size(self) -> None:
        config = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
        window = config["app"]["windows"][0]
        styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")
        self.assertTrue(window["maximized"])
        self.assertGreaterEqual(window["width"], 1400)
        self.assertGreaterEqual(window["height"], 880)
        self.assertIn("height: 100vh", styles)
        self.assertIn("overflow: hidden", styles)

    def test_frontend_and_protocol_reserve_batch_result_types(self) -> None:
        app = (ROOT / "src" / "App.vue").read_text(encoding="utf-8")
        types = (ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")
        sidecar = (ROOT / "sidecar" / "main.py").read_text(encoding="utf-8")
        smoke = (ROOT / "scripts" / "smoke-sidecar.py").read_text(encoding="utf-8")
        self.assertIn("multiple: true", app)
        self.assertIn('"text" | "table" | "document"', types)
        self.assertIn('ocrSidecar.request("pause"', app)
        self.assertIn('ocrSidecar.request("cancel"', app)
        self.assertIn("task.totalPages", app)
        self.assertIn("正在处理第", app)
        self.assertIn("PROTOCOL_STDOUT.write", sidecar)
        self.assertIn("Sidecar did not emit OCR progress events", smoke)

    def test_webkitgtk_4_0_compatibility_shell_is_isolated_from_tauri_2(self) -> None:
        standard = json.loads(
            (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        legacy = json.loads(
            (ROOT / "compat" / "webkitgtk-4.0" / "src-tauri" / "tauri.conf.json").read_text(
                encoding="utf-8"
            )
        )
        legacy_cargo = (
            ROOT / "compat" / "webkitgtk-4.0" / "src-tauri" / "Cargo.toml"
        ).read_text(encoding="utf-8")
        bridge = (ROOT / "src" / "lib" / "tauri-bridge.ts").read_text(encoding="utf-8")

        self.assertEqual(standard["$schema"], "https://schema.tauri.app/config/2")
        self.assertIn('tauri = { version = "1.8"', legacy_cargo)
        self.assertIn('"shell-sidecar"', legacy_cargo)
        self.assertTrue(legacy["build"]["withGlobalTauri"])
        self.assertEqual(legacy["tauri"]["bundle"]["targets"], ["appimage"])
        self.assertEqual(
            legacy["tauri"]["bundle"]["externalBin"], ["binaries/ocr-sidecar"]
        )
        self.assertTrue(legacy["tauri"]["allowlist"]["dialog"]["open"])
        self.assertTrue(legacy["tauri"]["allowlist"]["shell"]["sidecar"])
        self.assertIn("window.__TAURI__", bridge)
        self.assertIn("VITE_WEBKITGTK_4_0", bridge)

    def test_webkitgtk_4_0_action_uses_minimum_ubuntu_appimage_build(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "build-desktop.yml").read_text(
            encoding="utf-8"
        )
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        stage_script = (ROOT / "scripts" / "stage-webkit4-sidecar.py").read_text(
            encoding="utf-8"
        )

        self.assertIn("image: ubuntu:20.04", workflow)
        self.assertIn("libwebkit2gtk-4.0-dev", workflow)
        self.assertIn("--bundles appimage", workflow)
        self.assertIn("local-ocr-linux-x64-webkitgtk-4.0", workflow)
        self.assertNotIn("--bundles deb", workflow)
        legacy_job = workflow.split("build-linux-webkitgtk-4:", 1)[1]
        self.assertIn("sidecar:smoke -- --prepare", legacy_job)
        self.assertNotIn("--all-profiles", legacy_job)
        self.assertIn("VITE_WEBKITGTK_4_0=1", package["scripts"]["build:webkit4"])
        self.assertIn('"compat" / "webkitgtk-4.0"', stage_script)


if __name__ == "__main__":
    unittest.main()
