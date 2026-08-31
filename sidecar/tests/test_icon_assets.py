from __future__ import annotations

import json
import struct
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / "src-tauri" / "icons"
SVG_NS = {"svg": "http://www.w3.org/2000/svg"}


class IconAssetTests(unittest.TestCase):
    def test_selected_svg_has_no_background_or_embedded_bitmap(self) -> None:
        svg = ET.parse(ROOT / "assets" / "icon-source.svg").getroot()
        self.assertEqual(svg.attrib["viewBox"], "0 0 1024 1024")
        self.assertEqual(svg.findall("svg:rect", SVG_NS), [])
        self.assertEqual(svg.findall(".//svg:image", SVG_NS), [])
        self.assertEqual(svg.findall(".//svg:text", SVG_NS), [])
        paths = svg.findall("svg:path", SVG_NS)
        self.assertEqual([path.attrib["fill"] for path in paths], ["#527563", "#B6D4B5"])
        self.assertEqual(paths[1].attrib["d"], "M600 120L808 328H600Z")
        lines = svg.findall("svg:g", SVG_NS)[0]
        self.assertEqual(lines.attrib["fill"], "#F0F4E6")
        self.assertEqual(len(lines.findall("svg:rect", SVG_NS)), 3)
        brackets = svg.findall("svg:g", SVG_NS)[1]
        self.assertEqual(brackets.attrib["stroke"], "#7CA58C")
        self.assertEqual(len(brackets.findall("svg:path", SVG_NS)), 2)

    def test_desktop_pngs_have_rgba_channels_and_expected_sizes(self) -> None:
        for name, size in {
            "32x32.png": 32,
            "64x64.png": 64,
            "128x128.png": 128,
            "128x128@2x.png": 256,
            "icon.png": 512,
            "icon-source.png": 1024,
        }.items():
            with self.subTest(name=name):
                data = (ICONS / name).read_bytes()
                self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
                self.assertEqual(data[12:16], b"IHDR")
                self.assertEqual(struct.unpack(">II", data[16:24]), (size, size))
                self.assertEqual(data[24:26], bytes([8, 6]))  # 8-bit RGBA.

    def test_tauri_shells_share_existing_icon_resources(self) -> None:
        standard_root = ROOT / "src-tauri"
        legacy_root = ROOT / "compat" / "webkitgtk-4.0" / "src-tauri"
        standard = json.loads((standard_root / "tauri.conf.json").read_text(encoding="utf-8"))
        legacy = json.loads((legacy_root / "tauri.conf.json").read_text(encoding="utf-8"))
        standard_paths = [(standard_root / name).resolve() for name in standard["bundle"]["icon"]]
        legacy_paths = [(legacy_root / name).resolve() for name in legacy["tauri"]["bundle"]["icon"]]
        self.assertEqual(standard_paths, legacy_paths)
        for path in standard_paths:
            with self.subTest(path=path.name):
                self.assertTrue(path.is_file())
                self.assertGreater(path.stat().st_size, 0)
        self.assertEqual((ICONS / "icon.icns").read_bytes()[:4], b"icns")

    def test_windows_ico_contains_small_and_large_frames(self) -> None:
        data = (ICONS / "icon.ico").read_bytes()
        reserved, image_type, count = struct.unpack("<HHH", data[:6])
        self.assertEqual((reserved, image_type), (0, 1))
        sizes = set()
        for index in range(count):
            entry = data[6 + index * 16:22 + index * 16]
            self.assertEqual(len(entry), 16)
            width, height = entry[0] or 256, entry[1] or 256
            self.assertEqual(width, height)
            sizes.add(width)
            length, offset = struct.unpack("<II", entry[8:16])
            self.assertGreater(length, 0)
            self.assertGreaterEqual(offset, 6 + count * 16)
            self.assertLessEqual(offset + length, len(data))
        self.assertTrue({16, 32, 48, 256}.issubset(sizes), sizes)


if __name__ == "__main__":
    unittest.main()
