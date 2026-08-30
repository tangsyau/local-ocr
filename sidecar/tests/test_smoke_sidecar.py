from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("smoke_sidecar", SCRIPTS / "smoke-sidecar.py")
assert SPEC is not None and SPEC.loader is not None
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class SmokeSidecarEncodingTests(unittest.TestCase):
    def test_source_server_prepares_and_recognizes_over_real_pipes_with_stub_models(self) -> None:
        # Exercises the real command loop/threads/NDJSON pipes, not Paddle's native
        # runtime. The latter remains the frozen Windows/Linux CI smoke check.
        driver = '''
import sys
from types import ModuleType, SimpleNamespace
class StubOCR:
    def __init__(self, **kwargs):
        pass
    def predict_iter(self, **kwargs):
        yield SimpleNamespace(json={"res": {"rec_texts": ["TEST"], "rec_scores": [0.99]}})
paddle = ModuleType("paddle")
paddleocr = ModuleType("paddleocr")
paddleocr.PaddleOCR = StubOCR
paddleocr.TableRecognitionPipelineV2 = StubOCR
sys.modules.update(paddle=paddle, paddleocr=paddleocr)
from main import main
raise SystemExit(main())
'''
        real_popen = SMOKE.subprocess.Popen
        def launch(_binary: object, **kwargs: object) -> object:
            return real_popen([sys.executable, "-u", "-c", driver], cwd=ROOT / "sidecar", **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "smoke.png"
            SMOKE.write_smoke_png(path)
            lines = [SMOKE.request("ping", "ping"), SMOKE.request("prepare", "prepare"),
                     SMOKE.request("recognize", "recognize", {"path": str(path)}),
                     SMOKE.request("shutdown", "shutdown")]
            with (patch.object(SMOKE.subprocess, "Popen", side_effect=launch),
                  patch.object(SMOKE, "write_utf8_stderr"),
                  patch.dict(SMOKE.os.environ, {"LOCALAPPDATA": directory, "XDG_STATE_HOME": directory})):
                results, events = SMOKE.run_sidecar(Path(sys.executable), lines, 20, "source-stub")
        self.assertEqual(results["recognize"]["result"]["text"], "TEST")
        self.assertEqual([entry["event"] for entry in events["prepare"]][:3],
                         ["import_paddle", "import_paddleocr", "imports_ready"])
        self.assertTrue(any(entry["event"] == "page_result" for entry in events["recognize"]))

    def test_empty_output_queue_reports_request_timeout_and_cleans_process(self) -> None:
        process = MagicMock()
        process.poll.return_value = None
        output = MagicMock()
        output.get.side_effect = SMOKE.queue.Empty
        with (patch.object(SMOKE.subprocess, "Popen", return_value=process) as popen,
              patch.object(SMOKE.threading, "Thread"),
              patch.object(SMOKE.queue, "Queue", return_value=output),
              patch.object(SMOKE.time, "monotonic", side_effect=[0, 0, 2]),
              patch.object(SMOKE, "write_utf8_stderr"),
              patch.object(SMOKE, "stop_sidecar_tree") as stop):
            with self.assertRaisesRegex(TimeoutError, "smoke-prepare-fast"):
                SMOKE.run_sidecar(Path("fake.exe"), [SMOKE.request("smoke-prepare-fast", "prepare")], 1, "text-fast")
        stop.assert_called_once_with(process)
        self.assertEqual(popen.call_args.kwargs["env"]["LOCAL_OCR_CI_PREPARE_TRACE"], "1")

    def test_successful_response_is_not_mistaken_for_timeout(self) -> None:
        process = MagicMock()
        process.poll.return_value = 0
        process.wait.return_value = 0
        output = MagicMock()
        output.get.return_value = '{"id":"smoke-ping","type":"result","result":{"ok":true}}\n'
        with (patch.object(SMOKE.subprocess, "Popen", return_value=process),
              patch.object(SMOKE.threading, "Thread"),
              patch.object(SMOKE.queue, "Queue", return_value=output),
              patch.object(SMOKE, "write_utf8_stderr"),
              patch.object(SMOKE, "stop_sidecar_tree") as stop):
            results, _ = SMOKE.run_sidecar(Path("fake.exe"), [SMOKE.request("smoke-ping", "ping")], 1, "protocol")
        self.assertTrue(results["smoke-ping"]["result"]["ok"])
        stop.assert_not_called()

    def test_utf8_diagnostics_bypass_cp1252_text_encoding(self) -> None:
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252")
        original = SMOKE.sys.stderr
        SMOKE.sys.stderr = stream
        try:
            SMOKE.write_utf8_stderr("中文错误：libmklml_intel.so")
        finally:
            SMOKE.sys.stderr = original

        self.assertEqual(raw.getvalue().decode("utf-8").strip(), "中文错误：libmklml_intel.so")

    def test_generated_smoke_image_is_a_png(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "smoke.png"
            SMOKE.write_smoke_png(image_path)
            payload = image_path.read_bytes()

        self.assertTrue(payload.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertGreater(len(payload), 100)

    def test_recognize_request_contains_local_path(self) -> None:
        payload = SMOKE.json.loads(
            SMOKE.request("smoke-recognize", "recognize", {"path": "C:/tmp/smoke.png", "scoreThreshold": 0.5})
        )
        self.assertEqual(payload["method"], "recognize")
        self.assertEqual(payload["params"]["path"], "C:/tmp/smoke.png")


if __name__ == "__main__":
    unittest.main()
