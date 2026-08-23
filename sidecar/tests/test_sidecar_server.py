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

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.pause_called = False
        self.cancel_called = False

    def reset_job_control(self) -> None:
        self.pause_called = False
        self.cancel_called = False

    def recognize(self, path: str, score: float, progress: Any) -> dict[str, Any]:
        self.started.set()
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


if __name__ == "__main__":
    unittest.main()
