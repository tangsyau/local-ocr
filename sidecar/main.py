from __future__ import annotations

import json
import faulthandler
import os
import platform
import sys
import threading
import traceback
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
from engine import OcrEngine, document_page_count, export_table_results, export_text_results, model_cache_status, official_model_cache
from document_input import parse_page_range
from model_pack import TransferCancelled, export_pack, import_pack, model_worker_main
from export_service import export_results, preview_exports
from diagnostics import error_category, export_diagnostics, open_logs, record_event, safe_report


EMIT_LOCK = threading.Lock()
PROTOCOL_STDOUT = sys.stdout
TRACE_STDERR = sys.stderr


def start_operation_trace() -> None:
    # Opt-in release-test tracing only, never the user's saved diagnostic log.
    # faulthandler uses a native watchdog, so a blocked Python thread can be seen.
    if os.environ.get("LOCAL_OCR_CI_PREPARE_TRACE") == "1":
        try:
            interval = max(1, min(60, int(os.environ.get("LOCAL_OCR_CI_TRACE_INTERVAL", "60"))))
        except ValueError:
            interval = 60
        faulthandler.dump_traceback_later(interval, repeat=True, file=TRACE_STDERR)


def stop_operation_trace() -> None:
    if os.environ.get("LOCAL_OCR_CI_PREPARE_TRACE") == "1":
        faulthandler.cancel_dump_traceback_later()


def package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def diagnostic_info(engine: OcrEngine) -> dict[str, Any]:
    return safe_report({
        "engineReady": engine.ready,
        "profile": engine.profile,
        "mode": engine.mode,
        "packages": {
            "paddlepaddle": package_version("paddlepaddle"),
            "paddleocr": package_version("paddleocr"),
            "paddlex": package_version("paddlex"),
            "pyinstaller": package_version("pyinstaller"),
        },
    })


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
        self._initializing = False
        self._transfer_cancel = threading.Event()

    @property
    def active(self) -> bool:
        with self._worker_lock:
            return self._initializing or (self._worker is not None and self._worker.is_alive())

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
            if self._initializing or (self._worker is not None and self._worker.is_alive()):
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

    def start_prepare(self, request_id: str, params: dict[str, Any]) -> None:
        with self._worker_lock:
            if self._initializing or (self._worker is not None and self._worker.is_alive()):
                raise RuntimeError("已有模型准备或识别任务正在运行")
            self._initializing = True
        try:
            start_operation_trace()
            self.engine.initialize_runtime(
                lambda message, page, event, count: self._progress(request_id, message, page, event, count)
            )
            with self._worker_lock:
                self._worker = threading.Thread(target=self._run_prepare, args=(request_id, params), name="model-prepare", daemon=True)
                self._worker.start()
        except BaseException:
            stop_operation_trace()
            raise
        finally:
            with self._worker_lock:
                self._initializing = False

    def _run_prepare(self, request_id: str, params: dict[str, Any]) -> None:
        method = "prepare"
        try:
            profile, mode = str(params.get("profile") or "fast"), str(params.get("mode") or "text")
            if params.get("reload"):
                self.engine.unload()
            result = self.engine.prepare(profile, mode, lambda message, page, event, count: self._progress(request_id, message, page, event, count),
                                         local_only=bool(params.get("localOnly")))
            response = {"id": request_id, "type": "result", "result": result}
            record_event(method)
        except Exception as error:
            category = error_category(error)
            record_event(method, category)
            response = {"id": request_id, "type": "error", "message": str(error), "details": traceback.format_exc(limit=24), "category": category}
        finally:
            stop_operation_trace()
            with self._worker_lock:
                self._worker = None
        emit(response)

    def _run_recognition(self, request_id: str, params: dict[str, Any]) -> None:
        response: dict[str, Any]
        try:
            start_operation_trace()
            result = self.engine.recognize(
                str(params.get("path") or ""),
                float(params.get("scoreThreshold", 0.5)),
                str(params.get("mode") or "text"),
                lambda message, page, event, page_count: self._progress(
                    request_id, message, page, event, page_count
                ),
                on_page=lambda page, elapsed, total, completed=None: emit({
                    "id": request_id, "type": "event", "event": "page_result",
                    "pageResult": page, "elapsedMs": elapsed, "pageCount": total,
                    "page": completed,
                }),
                page_range=str(params.get("pageRange") or ""),
                rotation=params.get("rotation", 0),
                completed_pages=list(params.get("completedPages") or []),
            )
            response = {"id": request_id, "type": "result", "result": result}
            record_event("recognize", "cancelled" if result.get("cancelled") else "ok")
        except Exception as error:
            detail = traceback.format_exc(limit=24)
            sys.stderr.write(detail)
            response = {
                "id": request_id,
                "type": "error",
                "message": str(error),
                "details": detail,
                "category": error_category(error),
            }
            record_event("recognize", error_category(error))
        finally:
            stop_operation_trace()
            with self._worker_lock:
                self._worker = None
        emit(response)

    def shutdown(self) -> None:
        self._transfer_cancel.set()
        self.engine.cancel()
        with self._worker_lock:
            worker = self._worker
        if worker is not None:
            worker.join(timeout=10)

    def start_model_transfer(self, request_id: str, method: str, params: dict[str, Any]) -> None:
        with self._worker_lock:
            if self._initializing or (self._worker is not None and self._worker.is_alive()):
                raise RuntimeError("请等待当前操作结束再迁移模型")
            self._transfer_cancel.clear()
            self._worker = threading.Thread(target=self._run_model_transfer, args=(request_id, method, params), daemon=True)
            self._worker.start()

    def _run_model_transfer(self, request_id: str, method: str, params: dict[str, Any]) -> None:
        callback = lambda message, page, event, count: self._progress(request_id, message, page, event, count)
        try:
            if method == "export_model_pack":
                result = export_pack(str(params.get("directory") or ""), params.get("capabilities"), callback, self._transfer_cancel)
            else:
                result = import_pack(str(params.get("directory") or ""), callback, self._transfer_cancel, before_commit=self.engine.unload)
            response = {"id": request_id, "type": "result", "result": result}
        except TransferCancelled as error:
            response = {"id": request_id, "type": "result", "result": {"cancelled": True, "message": str(error)}}
        except Exception as error:
            response = {"id": request_id, "type": "error", "message": str(error), "details": traceback.format_exc(limit=24)}
        finally:
            with self._worker_lock:
                self._worker = None
        emit(response)

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
                "mode": self.engine.mode,
            }
        elif method == "runtime_check":
            result = self.engine.check_native_runtime()
        elif method == "prepare":
            self.start_prepare(request_id, params)
            return True
        elif method == "model_status":
            result = model_cache_status(
                str(params.get("profile") or "fast"),
                str(params.get("mode") or "text"),
            )
        elif method in {"export_model_pack", "import_model_pack"}:
            self.start_model_transfer(request_id, method, params)
            return True
        elif method == "cancel_model_transfer":
            self._transfer_cancel.set()
            result = {"requested": True}
        elif method == "document_info":
            # PDFium is not thread-safe: do not inspect another PDF while the
            # recognition worker is rendering pages.
            if self.active:
                raise RuntimeError("请等待当前任务结束再检查页码")
            path = Path(str(params.get("path") or "")).expanduser().resolve(strict=True)
            if not path.is_file() or path.suffix.lower() != ".pdf":
                raise ValueError("页码设置仅用于 PDF 文件")
            total = document_page_count(path)
            selected = parse_page_range(str(params.get("pageRange") or ""), total)
            source_stat = path.stat()
            result = {"totalPageCount": total, "selectedPageCount": len(selected),
                      "sourceSize": source_stat.st_size, "sourceMtimeNs": str(source_stat.st_mtime_ns)}
        elif method == "delete_models":
            if self.active:
                raise RuntimeError("识别期间不能删除模型")
            result = self.engine.delete_model_cache(
                str(params.get("profile") or "fast"),
                str(params.get("mode") or "text"),
            )
        elif method == "diagnostics":
            result = diagnostic_info(self.engine)
        elif method == "open_logs":
            result = open_logs()
        elif method == "export_diagnostics":
            result = export_diagnostics(str(params.get("directory") or ""), diagnostic_info(self.engine))
        elif method == "validate_paths":
            checked = []
            for item in list(params.get("items") or []):
                path = Path(str(item.get("path") or ""))
                exists = path.is_file()
                source_stat = path.stat() if exists else None
                checked.append({"id": str(item.get("id") or ""), "exists": exists,
                                "sourceSize": source_stat.st_size if source_stat else None,
                                "sourceMtimeNs": str(source_stat.st_mtime_ns) if source_stat else None})
            result = {"items": checked}
        elif method == "export_preview":
            result = preview_exports(params)
        elif method == "export_results":
            if self.active:
                raise RuntimeError("请等待识别或模型准备结束再导出")
            result = export_results(params)
        elif method == "ui_smoke_status":
            result = {"enabled": bool(os.environ.get("LOCAL_OCR_UI_SMOKE_DIR"))}
        elif method == "ui_smoke_ready":
            target = os.environ.get("LOCAL_OCR_UI_SMOKE_DIR")
            if not target or not Path(target).is_dir():
                raise ValueError("UI 测试未启用")
            report = {"appVersion": "0.9.1", "sidecar": True,
                      "width": int(params.get("width") or 0), "height": int(params.get("height") or 0),
                      "sidebarFits": bool(params.get("sidebarFits"))}
            marker = Path(target) / "ready.tmp"
            marker.write_text(json.dumps(report), encoding="utf-8")
            marker.replace(Path(target) / "ready.json")
            result = {"ok": True}
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
        elif method == "export_tables":
            formats_value = params.get("formats")
            result = export_table_results(
                str(params.get("directory") or ""),
                list(params.get("items") or []),
                list(formats_value) if formats_value is not None else None,
            )
        elif method == "shutdown":
            self.shutdown()
            emit({"id": request_id, "type": "result", "result": {"ok": True}})
            return False
        else:
            raise ValueError(f"未知方法：{method}")

        emit({"id": request_id, "type": "result", "result": result})
        if method in {"delete_models", "export_results", "shutdown"}:
            record_event(method)
        return True


def main() -> int:
    global PROTOCOL_STDOUT
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    PROTOCOL_STDOUT = sys.stdout

    server = SidecarServer()
    record_event("startup")
    emit({"id": None, "type": "event", "event": "ready", "message": "sidecar ready"})

    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = ""
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            if not server.handle(request):
                return 0
        except Exception as error:  # Keep the worker alive after a bad job.
            detail = traceback.format_exc(limit=24)
            sys.stderr.write(detail)
            record_event(str(request.get("method") or "other"), error_category(error))
            emit(
                {
                    "id": request_id,
                    "type": "error",
                    "message": str(error),
                    "details": detail,
                    "category": error_category(error),
                }
            )
    return 0


if __name__ == "__main__":
    if "--model-worker" in sys.argv:
        for stream in (sys.stdin, sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        start_operation_trace()
        try:
            raise SystemExit(model_worker_main())
        finally:
            stop_operation_trace()
    raise SystemExit(main())
