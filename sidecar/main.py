from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from engine import OcrEngine


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(engine: OcrEngine, request: dict[str, Any]) -> bool:
    request_id = str(request.get("id") or "")
    method = request.get("method")
    params = request.get("params") or {}

    def progress(message: str, page: int | None = None) -> None:
        event: dict[str, Any] = {
            "id": request_id,
            "type": "event",
            "event": "status",
            "message": message,
        }
        if page is not None:
            event["page"] = page
        emit(event)

    if method == "ping":
        result: Any = {"ok": True, "ready": engine.ready}
    elif method == "runtime_check":
        result = engine.check_native_runtime()
    elif method == "prepare":
        result = engine.prepare(progress)
    elif method == "recognize":
        result = engine.recognize(
            str(params.get("path") or ""),
            float(params.get("scoreThreshold", 0.5)),
            progress,
        )
    elif method == "shutdown":
        emit({"id": request_id, "type": "result", "result": {"ok": True}})
        return False
    else:
        raise ValueError(f"未知方法：{method}")

    emit({"id": request_id, "type": "result", "result": result})
    return True


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    engine = OcrEngine()
    emit({"id": None, "type": "event", "event": "ready", "message": "sidecar ready"})

    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            if not handle(engine, request):
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
