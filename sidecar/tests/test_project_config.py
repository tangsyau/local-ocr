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


if __name__ == "__main__":
    unittest.main()
