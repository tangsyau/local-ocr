from __future__ import annotations

import contextlib
import hashlib
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from document_input import document_inputs, initialize_document_runtime, load_image, parse_page_range, validate_rotation
from engine import OcrEngine


class DocumentInputTests(unittest.TestCase):
    def test_document_runtime_registers_image_readers_on_main_thread(self):
        from PIL import Image
        with patch.object(Image, "init", wraps=Image.init) as initialize:
            initialize_document_runtime()
        initialize.assert_called_once()
        self.assertTrue({"PNG", "JPEG", "TIFF", "BMP", "WEBP"}.issubset(Image.OPEN))

    def test_document_runtime_rejects_worker_initialization(self):
        errors = []
        def attempt():
            try:
                initialize_document_runtime()
            except RuntimeError as error:
                errors.append(str(error))
        worker = threading.Thread(target=attempt)
        worker.start()
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIn("主线程", errors[0])

    def test_image_decode_waits_until_iteration(self):
        with patch("document_input.load_image", return_value="pixels") as decode:
            with document_inputs(Path("sample.png"), [0], 90) as inputs:
                decode.assert_not_called()
                self.assertEqual(next(inputs), (0, "pixels"))
                decode.assert_called_once_with(Path("sample.png"), 90)

    def test_cancel_before_first_image_does_not_decode(self):
        engine = OcrEngine()
        engine._ocr, engine._mode = object(), "text"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cancelled.png"
            path.write_bytes(b"not decoded")
            engine.cancel()
            with patch("document_input.load_image") as decode:
                result = engine.recognize(str(path))
        decode.assert_not_called()
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["pageCount"], 0)

    def test_ranges_are_physical_sorted_unique_and_strict(self):
        self.assertEqual(parse_page_range("8， 3-5,1,3", 10), [0, 2, 3, 4, 7])
        self.assertEqual(parse_page_range("", 3), [0, 1, 2])
        for value in ("0", "-1", "3-1", "11", "1,,2", "1,", "1.5", "1-999999999", "a", "1-2-3"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_page_range(value, 10)

    def test_rotation_exif_bgr_and_original_file_are_preserved(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "photo.png"
            with Image.new("RGB", (30, 20), "red") as image:
                image.putpixel((0, 0), (0, 255, 0))
                image.save(path)
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            rotated = load_image(path, 90)
            self.assertEqual(rotated.shape, (30, 20, 3))
            self.assertEqual(rotated[0, -1].tolist(), [0, 255, 0])
            self.assertEqual(rotated[-1, -1].tolist(), [0, 0, 255])
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
            with Image.open(path) as image:
                exif = image.getexif()
                exif[274] = 6
                image.save(Path(directory) / "exif.jpg", exif=exif)
            self.assertEqual(load_image(Path(directory) / "exif.jpg", 90).shape, (20, 30, 3))

    def test_transparency_is_composited_on_white(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "alpha.png"
            with Image.new("RGBA", (2, 2), (0, 0, 0, 0)) as image:
                image.save(path)
            self.assertEqual(load_image(path)[0, 0].tolist(), [255, 255, 255])

    def test_invalid_rotation_is_not_silently_accepted(self):
        for value in (45, -90, 360, "90", True, 90.0):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_rotation(value)

    def test_real_pdf_renders_only_selected_pages_and_closes_early(self):
        from pypdfium2 import PdfDocument
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "three.pdf"
            with PdfDocument.new() as pdf:
                for width in (100, 150, 200):
                    pdf.new_page(width, 80).close()
                pdf.save(path)
            with document_inputs(path, [0, 2]) as inputs:
                rendered = list(inputs)
            self.assertEqual([index for index, _ in rendered], [0, 2])
            self.assertEqual([pixels.shape[1] for _, pixels in rendered], [200, 400])
            with document_inputs(path, [0, 2]) as inputs:
                next(inputs)
            # Rename catches leaked file handles on Windows.
            path.rename(path.with_name("renamed.pdf"))

    def test_engine_keeps_source_indices_and_selected_progress(self):
        from PIL import Image
        calls, events = [], []
        fake = SimpleNamespace(json={"res": {"page_index": 0, "rec_texts": ["hello"]}})
        class Pipeline:
            def predict_iter(self, **kwargs):
                calls.append(kwargs["input"])
                return iter([fake])
        engine = OcrEngine()
        engine._ocr, engine._profile, engine._mode = Pipeline(), "fast", "text"
        @contextlib.contextmanager
        def inputs(path, selected, rotation):
            self.assertEqual(selected, [1, 4])
            yield iter((index, f"pixels-{index}") for index in selected)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pdf"
            path.write_bytes(b"stub")
            with patch("engine.document_page_count", return_value=8), patch("engine.document_inputs", inputs):
                result = engine.recognize(str(path), page_range="2,5", progress=lambda *event: events.append(event))
        self.assertEqual(calls, ["pixels-1", "pixels-4"])
        self.assertEqual([page["pageIndex"] for page in result["pages"]], [1, 4])
        self.assertEqual((result["pageCount"], result["selectedPageCount"], result["totalPageCount"]), (2, 2, 8))
        self.assertEqual([event[1] for event in events if event[2] == "progress"], [1, 2])
        self.assertEqual([event[1] for event in events if event[2] == "source_page"], [2, 5])

    def test_cancel_does_not_render_or_predict_the_next_page(self):
        calls = []
        engine = OcrEngine()
        fake = SimpleNamespace(json={"res": {"rec_texts": ["first"]}})
        class Pipeline:
            def predict_iter(self, **kwargs):
                calls.append(kwargs["input"])
                return iter([fake])
        engine._ocr, engine._profile, engine._mode = Pipeline(), "fast", "text"
        @contextlib.contextmanager
        def inputs(*args):
            def pages():
                yield 0, "first"
                self.fail("cancelled job rendered the next PDF page")
            yield pages()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pdf"
            path.write_bytes(b"stub")
            with patch("engine.document_page_count", return_value=3), patch("engine.document_inputs", inputs):
                result = engine.recognize(str(path), on_page=lambda *args: engine.cancel())
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["pageCount"], 1)
        self.assertEqual(calls, ["first"])
