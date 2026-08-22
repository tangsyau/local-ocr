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

        match = re.search(r'Command\.sidecar\("([^"]+)"\)', frontend)
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
        self.assertIn("multiple: true", app)
        self.assertIn('"text" | "table" | "document"', types)
        self.assertIn('ocrSidecar.request("pause"', app)
        self.assertIn('ocrSidecar.request("cancel"', app)
        self.assertIn("task.totalPages", app)


if __name__ == "__main__":
    unittest.main()
