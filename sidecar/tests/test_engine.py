from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SIDECAR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SIDECAR_DIR))

from engine import MODEL_PROFILES, document_page_count, export_text_results, extract_page  # noqa: E402
from network_guard import NetworkBlockedError, block_python_network  # noqa: E402


class FakeArray:
    def __init__(self, value: object) -> None:
        self.value = value

    def tolist(self) -> object:
        return self.value


class FakeResult:
    json = {
        "res": {
            "page_index": 2,
            "rec_texts": ["第一行", "", "second line"],
            "rec_scores": FakeArray([0.98, 0.2, 0.75]),
            "rec_polys": FakeArray([[[0, 0], [10, 0], [10, 5], [0, 5]], [], [[0, 8], [20, 8], [20, 14], [0, 14]]]),
            "rec_boxes": FakeArray([[0, 0, 10, 5], [], [0, 8, 20, 14]]),
        }
    }


class EngineSchemaTests(unittest.TestCase):
    def test_extract_page_returns_stable_schema(self) -> None:
        page = extract_page(FakeResult())
        self.assertEqual(page["pageIndex"], 2)
        self.assertEqual(page["text"], "第一行\nsecond line")
        self.assertEqual(len(page["blocks"]), 2)
        self.assertAlmostEqual(page["blocks"][1]["score"], 0.75)
        self.assertEqual(page["blocks"][0]["box"], [0, 0, 10, 5])

    def test_python_network_is_denied_inside_guard(self) -> None:
        import socket

        with block_python_network():
            with self.assertRaises(NetworkBlockedError):
                socket.create_connection(("example.com", 80))

    def test_model_profiles_use_mobile_and_server_pairs(self) -> None:
        self.assertEqual(MODEL_PROFILES["fast"]["detection"], "PP-OCRv5_mobile_det")
        self.assertEqual(MODEL_PROFILES["accurate"]["recognition"], "PP-OCRv5_server_rec")

    def test_export_text_results_avoids_name_collisions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            first = Path(temp_dir) / "报告.txt"
            first.write_text("existing", encoding="utf-8")
            result = export_text_results(
                temp_dir,
                [
                    {"fileName": "报告.pdf", "text": "第一份"},
                    {"fileName": "报告.png", "text": "第二份"},
                ],
            )
            exported = [Path(item["path"]) for item in result["files"]]
            self.assertEqual([path.name for path in exported], ["报告 (2).txt", "报告 (3).txt"])
            self.assertEqual(exported[0].read_text(encoding="utf-8"), "第一份")

    def test_pdf_page_count_uses_pdfium_and_closes_document(self) -> None:
        closed = False

        class FakeDocument:
            def __init__(self, path: str) -> None:
                self.path = path

            def __len__(self) -> int:
                return 12

            def close(self) -> None:
                nonlocal closed
                closed = True

        with patch.dict(sys.modules, {"pypdfium2": SimpleNamespace(PdfDocument=FakeDocument)}):
            self.assertEqual(document_page_count(Path("example.pdf")), 12)
        self.assertTrue(closed)


if __name__ == "__main__":
    unittest.main()
