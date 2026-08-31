from __future__ import annotations

import contextlib
import io
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

SIDECAR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SIDECAR_DIR))

import main as sidecar_main  # noqa: E402


class FakeEngine:
    ready = True
    profile = "fast"
    mode = "text"

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.pause_called = False
        self.cancel_called = False

    def reset_job_control(self) -> None:
        self.pause_called = False
        self.cancel_called = False

    def recognize(self, path: str, score: float, mode: str, progress: Any, on_page: Any = None, **kwargs: Any) -> dict[str, Any]:
        self.started.set()
        if on_page:
            on_page({"pageIndex": 0, "text": "ok", "blocks": [], "tables": []}, 1, 3)
        progress("已完成第 1/3 页（33%）", 1, "progress", 3)
        self.release.wait(timeout=2)
        return {
            "path": path,
            "profile": "fast",
            "resultType": "text",
            "cancelled": self.cancel_called,
            "text": "ok",
            "pageCount": 1,
            "totalPageCount": 1,
            "blockCount": 1,
            "tableCount": 0,
            "elapsedMs": 1,
            "pages": [],
        }

    def pause(self) -> None:
        self.pause_called = True

    def resume(self) -> None:
        self.pause_called = False

    def cancel(self) -> None:
        self.cancel_called = True
        self.release.set()


class SidecarServerTests(unittest.TestCase):
    def test_bootstrap_precedes_prepare_worker_and_reserves_active_state(self) -> None:
        server = sidecar_main.SidecarServer()
        order = []
        completed = threading.Event()
        def bootstrap(progress: Any) -> None:
            self.assertIs(threading.current_thread(), threading.main_thread())
            self.assertTrue(server.active)
            with self.assertRaises(RuntimeError):
                server.start_recognition("conflict", {})
            order.append("imports")
        def prepare(*args: Any, **kwargs: Any) -> dict[str, Any]:
            self.assertIsNot(threading.current_thread(), threading.main_thread())
            self.assertEqual(order, ["imports"])
            order.append("models")
            return {"ready": True}
        def emit(message: dict[str, Any]) -> None:
            if message.get("id") == "prepare" and message.get("type") == "result":
                completed.set()
        with (patch.object(server.engine, "initialize_runtime", side_effect=bootstrap),
              patch.object(server.engine, "prepare", side_effect=prepare),
              patch.object(sidecar_main, "emit", side_effect=emit)):
            server.handle({"id": "prepare", "method": "prepare"})
            self.assertTrue(completed.wait(timeout=2))
        self.assertEqual(order, ["imports", "models"])
        self.assertFalse(server.active)

    def test_import_failure_clears_busy_state_and_cancels_ci_watchdog(self) -> None:
        server = sidecar_main.SidecarServer()
        with (patch.object(server.engine, "initialize_runtime", side_effect=ImportError("broken runtime")),
              patch.object(sidecar_main, "start_prepare_trace") as start_trace,
              patch.object(sidecar_main, "stop_prepare_trace") as stop_trace):
            with self.assertRaises(ImportError):
                server.handle({"id": "prepare", "method": "prepare"})
        self.assertFalse(server.active)
        start_trace.assert_called_once()
        stop_trace.assert_called_once()

    def test_trace_watchdog_is_disabled_in_normal_app(self) -> None:
        with (patch.dict(sidecar_main.os.environ, {"LOCAL_OCR_CI_PREPARE_TRACE": ""}),
              patch.object(sidecar_main.faulthandler, "dump_traceback_later") as dump):
            sidecar_main.start_prepare_trace()
        dump.assert_not_called()
        with (patch.dict(sidecar_main.os.environ, {"LOCAL_OCR_CI_PREPARE_TRACE": "1"}),
              patch.object(sidecar_main.faulthandler, "dump_traceback_later") as dump):
            sidecar_main.start_prepare_trace()
        dump.assert_called_once_with(60, repeat=True, file=sidecar_main.TRACE_STDERR)

    def test_model_status_remains_responsive_during_preparation(self) -> None:
        server = sidecar_main.SidecarServer()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        messages: list[dict[str, Any]] = []

        def prepare(profile: str, mode: str, progress: Any, **kwargs: Any) -> dict[str, Any]:
            entered.set()
            release.wait(timeout=2)
            return {"ready": True}

        def collect(message: dict[str, Any]) -> None:
            messages.append(message)
            if message.get("id") == "prepare" and message.get("type") == "result":
                finished.set()

        with (patch.object(server.engine, "prepare", side_effect=prepare),
              patch.object(server.engine, "initialize_runtime") as bootstrap,
              patch.object(sidecar_main, "emit", side_effect=collect),
              patch.object(sidecar_main, "model_cache_status", return_value={"models": []})):
            server.handle({"id": "prepare", "method": "prepare"})
            bootstrap.assert_called_once()
            try:
                self.assertTrue(entered.wait(timeout=1))
                server.handle({"id": "status", "method": "model_status"})
                self.assertTrue(server.active)
                self.assertTrue(any(message.get("id") == "status" for message in messages))
            finally:
                release.set()
                self.assertTrue(finished.wait(timeout=2))

    def test_protocol_output_bypasses_paddle_stdout_redirect(self) -> None:
        protocol_output = io.StringIO()
        paddle_output = io.StringIO()
        message = {
            "id": "pdf-progress",
            "type": "event",
            "event": "progress",
            "page": 2,
            "pageCount": 5,
        }

        with (
            patch.object(sidecar_main, "PROTOCOL_STDOUT", protocol_output),
            contextlib.redirect_stdout(paddle_output),
        ):
            sidecar_main.emit(message)

        self.assertEqual(json.loads(protocol_output.getvalue()), message)
        self.assertEqual(paddle_output.getvalue(), "")

    def test_control_commands_remain_responsive_during_recognition(self) -> None:
        server = sidecar_main.SidecarServer()
        fake = FakeEngine()
        server.engine = fake  # type: ignore[assignment]
        messages: list[dict[str, Any]] = []

        with patch.object(sidecar_main, "emit", messages.append):
            self.assertTrue(
                server.handle(
                    {"id": "recognize", "method": "recognize", "params": {"path": "input.png"}}
                )
            )
            self.assertTrue(fake.started.wait(timeout=1))
            self.assertTrue(server.handle({"id": "pause", "method": "pause", "params": {}}))
            self.assertTrue(fake.pause_called)
            self.assertTrue(server.handle({"id": "cancel", "method": "cancel", "params": {}}))

            deadline = time.monotonic() + 2
            while server.active and time.monotonic() < deadline:
                time.sleep(0.01)

        result = next(
            message
            for message in messages
            if message.get("id") == "recognize" and message.get("type") == "result"
        )
        progress = next(message for message in messages if message.get("event") == "progress")
        self.assertEqual(result["type"], "result")
        self.assertTrue(result["result"]["cancelled"])
        self.assertEqual(progress["page"], 1)
        self.assertEqual(progress["pageCount"], 3)
        page_result = next(message for message in messages if message.get("event") == "page_result")
        self.assertEqual(page_result["pageResult"]["text"], "ok")
        self.assertEqual(page_result["pageCount"], 3)


if __name__ == "__main__":
    unittest.main()
