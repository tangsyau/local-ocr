from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from diagnostics import error_category, export_diagnostics, safe_report
from engine import OcrEngine, model_cache_status
from export_service import export_results, preview_exports, safe_name


def sample_payload(directory: str) -> dict:
    table = {"pageIndex": 0, "tableIndex": 0, "rows": [[
        {"row": 0, "column": 0, "rowSpan": 1, "colSpan": 1, "text": "=1+1"}
    ]]}
    return {"directory": directory, "formats": ["txt", "xlsx", "html"],
            "textItems": [{"id": "one", "fileName": "第一页.png", "text": "第一项", "profile": "fast", "mode": "table"},
                          {"id": "two", "fileName": "第二页.png", "text": "第二项", "profile": "fast", "mode": "text"}],
            "tableItems": [{"ids": ["one"], "fileName": "第一页.png", "tables": [table], "profile": "fast", "mode": "table"}],
            "options": {"grouping": "separate", "collision": "rename"}}


class ExportRulesTests(unittest.TestCase):
    def test_preview_matches_actual_formats_and_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload = sample_payload(directory)
            preview = preview_exports(payload)
            self.assertEqual(preview["count"], 5)
            self.assertEqual(preview["noTableCount"], 1)
            result = export_results(payload)
            self.assertEqual(result["count"], 5)
            self.assertEqual(set(result["exportedIds"]), {"one", "two"})
            self.assertEqual({item["name"] for item in preview["files"]}, {item.name for item in Path(directory).iterdir()})

    def test_combined_exports_have_source_labels_and_literal_excel_text(self) -> None:
        from openpyxl import load_workbook
        with tempfile.TemporaryDirectory() as directory:
            payload = sample_payload(directory)
            payload["options"].update(grouping="combined", name="汇总", prefix="{date}_", suffix="_{profile}")
            result = export_results(payload)
            self.assertEqual(result["count"], 3)
            txt = next(Path(directory).glob("*.txt")).read_text(encoding="utf-8")
            self.assertIn("第一页.png", txt)
            self.assertIn("第二项", txt)
            book = load_workbook(next(Path(directory).glob("*.xlsx")))
            self.assertEqual(book.active["A1"].data_type, "s")
            self.assertEqual(book.active["A1"].value, "=1+1")
            html = next(Path(directory).glob("*.html")).read_text(encoding="utf-8")
            self.assertIn("第一页.png", html)

    def test_skip_and_overwrite_are_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload = sample_payload(directory)
            payload["formats"] = ["txt"]
            first = Path(directory) / "第一页.txt"
            first.write_text("keep", encoding="utf-8")
            payload["options"]["collision"] = "skip"
            result = export_results(payload)
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(first.read_text(encoding="utf-8"), "keep")
            payload["options"]["collision"] = "overwrite"
            self.assertEqual(preview_exports(payload)["overwrites"], 2)
            export_results(payload)
            self.assertEqual(first.read_text(encoding="utf-8"), "第一项")

    def test_export_never_escapes_destination_and_deduplicates_current_batch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload = sample_payload(directory)
            payload["formats"] = ["txt"]
            payload["textItems"][1]["fileName"] = payload["textItems"][0]["fileName"]
            payload["options"].update(prefix="../../", collision="overwrite")
            preview = preview_exports(payload)
            self.assertNotEqual(preview["files"][0]["name"], preview["files"][1]["name"])
            result = export_results(payload)
            self.assertEqual(len(list(Path(directory).iterdir())), 2)
            self.assertTrue(all("/" not in item["name"] for item in result["files"]))
            self.assertEqual(safe_name("CON"), "_CON")

    def test_no_tables_only_exports_selected_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload = sample_payload(directory)
            payload["tableItems"] = []
            payload["formats"] = ["xlsx", "html"]
            self.assertEqual(preview_exports(payload)["count"], 1)
            self.assertEqual(export_results(payload)["count"], 1)


class MaintenanceTests(unittest.TestCase):
    def test_incomplete_models_are_not_reported_installed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "PP-OCRv5_mobile_det"
            model.mkdir()
            (model / "inference.json").write_text("{}")
            state = model_cache_status("fast", "text", root)
            self.assertEqual(state["models"][0]["state"], "incomplete")
            self.assertEqual(state["installedCount"], 0)

    def test_diagnostics_exclude_private_paths_and_raw_error_text(self) -> None:
        report = {"cacheRoot": "C:/Users/Private", "executable": "/private/python", "text": "SECRET TEXT", "stderr": "SECRET ERROR", "profile": "fast"}
        self.assertNotIn("Private", json.dumps(safe_report(report)))
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            logs.mkdir()
            (logs / "events.jsonl").write_text(json.dumps({"time": "2026-08-30T00:00:00+00:00", "method": "recognize", "category": "file", "path": "SECRET FILE"}) + "\n", encoding="utf-8")
            with patch("diagnostics.log_directory", return_value=logs):
                result = export_diagnostics(directory, report)
            with zipfile.ZipFile(result["path"]) as archive:
                content = "".join(archive.read(name).decode() for name in archive.namelist())
            self.assertNotIn("SECRET", content)
            self.assertNotIn("/private", content)
            self.assertNotIn("C:/Users", content)

    def test_errors_are_classified_without_persisting_messages(self) -> None:
        self.assertEqual(error_category(RuntimeError("mklml.dll missing")), "runtime")
        self.assertEqual(error_category(RuntimeError("download model failed")), "download")
        self.assertEqual(error_category(FileNotFoundError("private-file.pdf")), "file")


if __name__ == "__main__":
    unittest.main()
