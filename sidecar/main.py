from __future__ import annotations

import json
import sys
import threading
import traceback
from typing import Any

from engine import OcrEngine, export_text_results


EMIT_LOCK = threading.Lock()
PROTOCOL_STDOUT = sys.stdout


def emit(message: dict[str, Any]) -> None:
    # PaddleOCR writes diagnostics to stdout, so the worker temporarily redirects
    # sys.stdout to stderr.  Keep the NDJSON pipe captured separately: progress
    # events and control responses may be emitted while that redirect is active.
    with EMIT_LOCK:
        PROTOCOL_STDOUT.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        PROTOCOL_STDOUT.flush()


class SidecarServer:
    def __init__(self) -> None:
        self.engine = OcrEngine()
        self._worker: threading.Thread | None = None
        self._worker_lock = threading.Lock()

    @property
    def active(self) -> bool:
        with self._worker_lock:
            return self._worker is not None and self._worker.is_alive()

    def _progress(
        self,
        request_id: str,
        message: str,
        page: int | None,
        event: str,
        page_count: int | None,
    ) -> None:
        payload: dict[str, Any] = {
            "id": request_id,
            "type": "event",
            "event": event,
            "message": message,
        }
        if page is not None:
            payload["page"] = page
        if page_count is not None:
            payload["pageCount"] = page_count
        emit(payload)

    def start_recognition(self, request_id: str, params: dict[str, Any]) -> None:
        with self._worker_lock:
            if self._worker is not None and self._worker.is_alive():
                raise RuntimeError("已有识别任务正在运行")
            self.engine.reset_job_control()
            worker = threading.Thread(
                target=self._run_recognition,
                args=(request_id, params),
                name="ocr-worker",
                daemon=True,
            )
            self._worker = worker
            worker.start()

    def _run_recognition(self, request_id: str, params: dict[str, Any]) -> None:
        response: dict[str, Any]
        try:
            result = self.engine.recognize(
                str(params.get("path") or ""),
                float(params.get("scoreThreshold", 0.5)),
                lambda message, page, event, page_count: self._progress(
                    request_id, message, page, event, page_count
                ),
            )
            response = {"id": request_id, "type": "result", "result": result}
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            response = {
                "id": request_id,
                "type": "error",
                "message": str(error),
                "details": error.__class__.__name__,
            }
        finally:
            with self._worker_lock:
                self._worker = None
        emit(response)

    def shutdown(self) -> None:
        self.engine.cancel()
        with self._worker_lock:
            worker = self._worker
        if worker is not None:
            worker.join(timeout=10)

    def handle(self, request: dict[str, Any]) -> bool:
        request_id = str(request.get("id") or "")
        method = request.get("method")
        params = request.get("params") or {}

        def progress(
            message: str,
            page: int | None = None,
            event: str = "status",
            page_count: int | None = None,
        ) -> None:
            self._progress(request_id, message, page, event, page_count)

        if method == "ping":
            result: Any = {
                "ok": True,
                "ready": self.engine.ready,
                "active": self.active,
                "profile": self.engine.profile,
            }
        elif method == "runtime_check":
            result = self.engine.check_native_runtime()
        elif method == "prepare":
            if self.active:
                raise RuntimeError("识别期间不能切换模型")
            result = self.engine.prepare(str(params.get("profile") or "fast"), progress)
        elif method == "recognize":
            self.start_recognition(request_id, params)
            return True
        elif method == "pause":
            if self.active:
                self.engine.pause()
            result = {"active": self.active, "pauseRequested": self.active}
        elif method == "resume":
            self.engine.resume()
            result = {"active": self.active}
        elif method == "cancel":
            if self.active:
                self.engine.cancel()
            result = {"active": self.active, "cancelRequested": self.active}
        elif method == "export_texts":
            result = export_text_results(str(params.get("directory") or ""), list(params.get("items") or []))
        elif method == "shutdown":
            self.shutdown()
            emit({"id": request_id, "type": "result", "result": {"ok": True}})
            return False
        else:
            raise ValueError(f"未知方法：{method}")

        emit({"id": request_id, "type": "result", "result": result})
        return True


def main() -> int:
    global PROTOCOL_STDOUT
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    PROTOCOL_STDOUT = sys.stdout

    server = SidecarServer()
    emit({"id": None, "type": "event", "event": "ready", "message": "sidecar ready"})

    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            if not server.handle(request):
                return 0
        except Exception as error:  # Keep the worker alive after a bad job.
            traceback.print_exc(file=sys.stderr)
            emit(
                {
                    "id": request_id,
                    "type": "error",
                    "message": str(error),
                    "details": error.__class__.__name__,
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
