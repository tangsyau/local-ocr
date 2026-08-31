from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import OcrEngine, model_names
from model_pack import TransferCancelled, export_pack, import_pack, pack_manifest, run_model_worker


class ModelPackTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / "source"
        self.destination = self.base / "destination"
        self.export = self.base / "export"
        self.export.mkdir()
        self.cancel = threading.Event()
        self.events = []
        self.workers = []
        self.items = [{"profile": "fast", "mode": "text"}, {"profile": "fast", "mode": "table"}]
        for name in model_names("fast", "table"):
            model = self.source / name
            model.mkdir(parents=True)
            for filename in ("inference.yml", "inference.pdiparams", "inference.json"):
                (model / filename).write_text("model-bytes", encoding="utf-8")
            (model / "private-document.txt").write_text("DO NOT EXPORT", encoding="utf-8")

    def progress(self, *args):
        self.events.append(args)

    def worker(self, item, root, online, progress, cancel):
        self.workers.append((item, root, online))

    def create_pack(self):
        return Path(export_pack(str(self.export), self.items, self.progress, self.cancel, self.worker, self.source)["path"])

    def test_export_reuses_models_excludes_private_files_and_never_overwrites(self):
        first, second = self.create_pack(), self.create_pack()
        self.assertNotEqual(first, second)
        manifest = pack_manifest(first)
        self.assertEqual(len(manifest["models"]), 4)
        self.assertEqual(len(manifest["files"]), 12)
        self.assertNotIn(str(self.base), json.dumps(manifest))
        self.assertFalse(list(first.rglob("private-document.txt")))
        self.assertTrue((first / "使用说明.txt").is_file())
        self.assertTrue(all(online for _, _, online in self.workers))

    def test_import_verifies_in_stage_before_commit_and_preserves_unrelated_files(self):
        pack = self.create_pack()
        self.destination.mkdir()
        (self.destination / "unrelated.txt").write_text("keep")
        old_model = self.destination / model_names("fast", "text")[0]
        old_model.mkdir()
        (old_model / "old.txt").write_text("old")
        called = []
        def validate(item, root, online, *args):
            self.assertFalse(online)
            self.assertTrue((old_model / "old.txt").exists())
            self.assertNotEqual(root, self.destination)
            called.append(item)
        result = import_pack(str(pack), self.progress, self.cancel, validate, self.destination)
        self.assertEqual(result["modelCount"], 4)
        self.assertEqual(len(called), 2)
        self.assertEqual((self.destination / "unrelated.txt").read_text(), "keep")
        self.assertFalse((old_model / "old.txt").exists())
        self.assertTrue((old_model / "inference.yml").exists())
        self.assertFalse(list(self.destination.glob(".local-ocr-import-*")))

    def test_checksum_mismatch_never_commits(self):
        pack = self.create_pack()
        path = pack / model_names("fast", "text")[0] / "inference.yml"
        path.write_text("x" * path.stat().st_size)
        with self.assertRaisesRegex(ValueError, "校验失败"):
            import_pack(str(pack), self.progress, self.cancel, self.worker, self.destination)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_partial_copy_and_foreign_version_are_rejected(self):
        pack = self.create_pack()
        manifest_file = pack / "model-pack.json"
        original = json.loads(manifest_file.read_text())
        changed = dict(original, runtime={"paddlepaddle": "0.0"})
        manifest_file.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, "不兼容"):
            pack_manifest(pack)
        manifest_file.write_text(json.dumps(original))
        (pack / original["files"][0]["path"]).unlink()
        with self.assertRaisesRegex(ValueError, "缺失"):
            pack_manifest(pack)

    def test_malicious_paths_and_missing_manifest_entries_are_rejected(self):
        pack = self.create_pack()
        manifest_file = pack / "model-pack.json"
        original = manifest_file.read_text()
        for bad in ("../private.txt", "/etc/passwd", "C:\\Users\\private", "PP-OCRv5_mobile_det/other.yml"):
            manifest = json.loads(original)
            manifest["files"][0]["path"] = bad
            manifest_file.write_text(json.dumps(manifest))
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                pack_manifest(pack)
        manifest = json.loads(original)
        manifest["files"] = [file for file in manifest["files"] if not file["path"].endswith("inference.yml")]
        manifest_file.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "缺少必要文件"):
            pack_manifest(pack)

    def test_cancel_or_validation_failure_does_not_touch_old_cache(self):
        pack = self.create_pack()
        self.destination.mkdir()
        old = self.destination / "keep.txt"
        old.write_text("keep")
        def fail(*args):
            raise RuntimeError("validation failed")
        with self.assertRaisesRegex(RuntimeError, "validation failed"):
            import_pack(str(pack), self.progress, self.cancel, fail, self.destination)
        self.cancel.set()
        with self.assertRaises(TransferCancelled):
            import_pack(str(pack), self.progress, self.cancel, self.worker, self.destination)
        self.assertEqual([file.name for file in self.destination.iterdir()], ["keep.txt"])

    def test_commit_failure_rolls_back_all_changed_models(self):
        pack = self.create_pack()
        names = pack_manifest(pack)["models"]
        for name in names:
            model = self.destination / name
            model.mkdir(parents=True)
            (model / "old.txt").write_text(name)
        original = Path.rename
        failed = False
        def rename(source, target):
            nonlocal failed
            if not failed and source.name == names[1] and source.parent.name == "models":
                failed = True
                raise OSError("simulated commit failure")
            return original(source, target)
        with patch.object(Path, "rename", rename), self.assertRaises(OSError):
            import_pack(str(pack), self.progress, self.cancel, self.worker, self.destination)
        for name in names:
            self.assertEqual((self.destination / name / "old.txt").read_text(), name)
            self.assertFalse((self.destination / name / "inference.yml").exists())

    def test_disk_space_is_checked_before_copying(self):
        pack = self.create_pack()
        with patch("model_pack.shutil.disk_usage", return_value=SimpleNamespace(free=0)), self.assertRaisesRegex(RuntimeError, "空间不足"):
            import_pack(str(pack), self.progress, self.cancel, self.worker, self.destination)

    def test_local_prepare_passes_explicit_paths_with_network_blocked(self):
        captured = {}
        def pipeline(**kwargs):
            import socket
            from network_guard import NetworkBlockedError
            with self.assertRaises(NetworkBlockedError):
                socket.create_connection(("example.com", 443))
            captured.update(kwargs)
            return object()
        with patch.dict(sys.modules, {"paddleocr": SimpleNamespace(PaddleOCR=pipeline)}):
            engine = OcrEngine()
            engine.prepare("fast", "text", local_only=True, model_root=self.source)
        self.assertEqual(captured["text_detection_model_dir"], str(self.source / "PP-OCRv5_mobile_det"))
        self.assertEqual(captured["text_recognition_model_dir"], str(self.source / "PP-OCRv5_mobile_rec"))
        with self.assertRaisesRegex(RuntimeError, "不会联网补下载"):
            OcrEngine().prepare("accurate", "text", local_only=True, model_root=self.source)

    def test_real_worker_process_protocol_with_stub_predictor(self):
        # Exercise Popen, UTF-8 pipes, main-thread imports and local paths without
        # installing Paddle in unit tests. Frozen native inference is a CI check.
        stubs = self.base / "stubs"
        stubs.mkdir()
        (stubs / "paddle.py").write_text("# stub native module\n", encoding="utf-8")
        (stubs / "paddleocr.py").write_text(
            "from types import SimpleNamespace\n"
            "class PaddleOCR:\n"
            "    def __init__(self, **kwargs):\n"
            "        assert kwargs['text_detection_model_dir']\n"
            "        assert kwargs['text_recognition_model_dir']\n"
            "    def predict_iter(self, **kwargs):\n"
            "        assert kwargs['input'].ndim == 3\n"
            "        yield SimpleNamespace(json={'res': {'rec_texts': ['LOCAL OCR']}})\n"
            "TableRecognitionPipelineV2 = PaddleOCR\n", encoding="utf-8")
        with patch.dict(os.environ, {"PYTHONPATH": str(stubs)}):
            run_model_worker({"profile": "fast", "mode": "text"}, self.source, False, self.progress, self.cancel)
        self.assertTrue(any("试识别" in event[0] for event in self.events))

    def test_cancel_terminates_real_worker_process(self):
        stubs = self.base / "slow-stubs"
        stubs.mkdir()
        (stubs / "paddle.py").write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
        timer = threading.Timer(0.3, self.cancel.set)
        timer.start()
        try:
            with patch.dict(os.environ, {"PYTHONPATH": str(stubs)}), self.assertRaises(TransferCancelled):
                run_model_worker({"profile": "fast", "mode": "text"}, self.source, False, self.progress, self.cancel)
        finally:
            timer.cancel()
