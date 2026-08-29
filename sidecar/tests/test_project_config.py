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

    def test_frontend_and_protocol_support_batch_and_table_results(self) -> None:
        app = (ROOT / "src" / "App.vue").read_text(encoding="utf-8")
        types = (ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")
        styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")
        sidecar = (ROOT / "sidecar" / "main.py").read_text(encoding="utf-8")
        smoke = (ROOT / "scripts" / "smoke-sidecar.py").read_text(encoding="utf-8")
        self.assertIn("multiple: true", app)
        self.assertIn('"text" | "table" | "document"', types)
        self.assertIn('ocrSidecar.request("pause"', app)
        self.assertIn('ocrSidecar.request("cancel"', app)
        self.assertIn("task.totalPages", app)
        self.assertIn("正在处理第", app)
        self.assertIn("复制表格（TSV）", app)
        self.assertIn("tableToTsv", app)
        self.assertIn("PROTOCOL_STDOUT.write", sidecar)
        self.assertIn("Sidecar did not emit OCR progress events", smoke)
        self.assertIn("表格与文字", app)
        self.assertIn('"export_tables",', app)
        self.assertIn("OcrTableCell", types)
        self.assertIn('method == "export_tables"', sidecar)
        self.assertIn("--table", smoke)
        self.assertIn("scrollbar-gutter: stable", styles)
        self.assertIn("overflow-y: scroll", styles)
        self.assertIn("overflow-x: scroll", styles)
        self.assertIn("width: max-content", styles)
        self.assertIn('aria-label="表格识别结果，可上下滚动"', app)

    def test_table_parser_dependencies_and_frozen_metadata_are_configured(self) -> None:
        requirements = (ROOT / "sidecar" / "requirements.txt").read_text(encoding="utf-8")
        build_script = (ROOT / "scripts" / "build-sidecar.py").read_text(encoding="utf-8")
        workflow = (ROOT / ".github" / "workflows" / "build-desktop.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("paddleocr[doc-parser]==3.7.0", requirements)
        self.assertIn("openpyxl", requirements)
        self.assertIn('"doc-parser"', build_script)
        self.assertIn('"ocr"', build_script)
        self.assertIn("paddle_extra_metadata()", build_script)
        self.assertIn("--prepare --all-profiles --table", workflow)

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
        legacy_scope = legacy["tauri"]["allowlist"]["shell"]["scope"]
        self.assertEqual(
            legacy_scope,
            [
                {
                    "name": legacy["tauri"]["bundle"]["externalBin"][0],
                    "sidecar": True,
                    "args": False,
                }
            ],
        )
        self.assertTrue(legacy["tauri"]["allowlist"]["dialog"]["open"])
        self.assertTrue(legacy["tauri"]["allowlist"]["shell"]["sidecar"])
        self.assertIn("window.__TAURI__", bridge)
        self.assertIn("VITE_WEBKITGTK_4_0", bridge)

    def test_webkitgtk_4_0_action_uses_old_glibc_appimage_build(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "build-desktop.yml").read_text(
            encoding="utf-8"
        )
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        stage_script = (ROOT / "scripts" / "stage-webkit4-sidecar.py").read_text(
            encoding="utf-8"
        )

        self.assertIn("image: debian:buster-slim", workflow)
        self.assertIn("archive.debian.org/debian buster", workflow)
        self.assertIn('Acquire::Check-Valid-Until "false";', workflow)
        self.assertIn("libappindicator3-dev", workflow)
        self.assertIn("libwebkit2gtk-4.0-dev", workflow)
        self.assertIn("--bundles appimage", workflow)
        self.assertIn("local-ocr-linux-x64-webkitgtk-4.0-glibc-2.28", workflow)
        self.assertNotIn("--bundles deb", workflow)
        legacy_job = workflow.split("build-linux-webkitgtk-4:", 1)[1]
        self.assertIn("sidecar:smoke -- --prepare", legacy_job)
        self.assertIn("--table", legacy_job)
        self.assertNotIn("--all-profiles", legacy_job)
        self.assertNotIn("actions/setup-python", legacy_job)
        self.assertIn(
            "astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d",
            legacy_job,
        )
        self.assertNotIn("astral-sh/setup-uv@v", legacy_job)
        self.assertIn('version: "latest-known"', legacy_job)
        self.assertIn("uv python install 3.11.15", legacy_job)
        self.assertIn(".venv/bin", legacy_job)
        self.assertIn("ocr-sidecar-webkit4-debian10-glibc228-py311", legacy_job)
        self.assertIn("check-glibc-baseline.py", legacy_job)
        self.assertIn("--max 2.28", legacy_job)
        self.assertIn("--require-executable ocr-sidecar", legacy_job)
        self.assertIn("python -m pip --version", legacy_job)
        self.assertNotIn("cache: pip", legacy_job)
        self.assertIn("VITE_WEBKITGTK_4_0=1", package["scripts"]["build:webkit4"])
        self.assertIn('"compat" / "webkitgtk-4.0"', stage_script)


if __name__ == "__main__":
    unittest.main()
