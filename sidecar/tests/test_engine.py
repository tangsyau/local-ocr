from __future__ import annotations

import sys
import unittest
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SIDECAR_DIR))

from engine import extract_page  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()

