"""Local diagnostics deliberately exclude document names, paths and OCR text."""
from __future__ import annotations

import datetime as dt
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import platform
from pathlib import Path
import subprocess
import sys
import zipfile
from typing import Any


METHODS = {"startup", "shutdown", "recognize", "prepare", "delete_models", "export_results", "export_preview", "validate_paths", "ping"}
CATEGORIES = {"ok", "download", "model", "runtime", "file", "storage", "unknown", "cancelled"}


def error_category(error: Exception) -> str:
    if type(error).__name__ == "LocalModelsMissingError":
        return "model"
    value = str(error).lower()
    if any(token in value for token in ("download", "hoster", "model source", "connection", "timeout", "网络", "下载")):
        return "download"
    if any(token in value for token in ("dll", ".so", "glibc", "onednn", "pir::", "dynlib")):
        return "runtime"
    if isinstance(error, (FileNotFoundError, IsADirectoryError)):
        return "file"
    if isinstance(error, (PermissionError, OSError)):
        return "storage"
    if any(token in value for token in ("model", "pdiparams", "inference", "模型")):
        return "model"
    return "unknown"


def log_directory() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    directory = base / "local-ocr" / "logs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


_logger: logging.Logger | None = None
def record_event(method: str, category: str = "ok") -> None:
    global _logger
    try:
        if _logger is None:
            _logger = logging.getLogger("local-ocr-safe-events")
            _logger.setLevel(logging.INFO)
            _logger.propagate = False
            handler = RotatingFileHandler(log_directory() / "events.jsonl", maxBytes=256_000, backupCount=2, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(message)s"))
            _logger.addHandler(handler)
        value = {"time": dt.datetime.now(dt.timezone.utc).isoformat(),
                 "method": method if method in METHODS else "other",
                 "category": category if category in CATEGORIES else "unknown"}
        _logger.info(json.dumps(value, ensure_ascii=True))
    except OSError:
        # Logging must never prevent recognition or recovery.
        pass


def safe_report(info: dict[str, Any]) -> dict[str, Any]:
    packages = info.get("packages") or {}
    return {
        "appVersion": "0.11.1", "os": platform.system(), "osRelease": platform.release(),
        "architecture": platform.machine(), "python": sys.version.split()[0],
        "frozen": bool(getattr(sys, "frozen", False)), "engineReady": bool(info.get("engineReady")),
        "profile": info.get("profile") if info.get("profile") in {"fast", "accurate"} else None,
        "mode": info.get("mode") if info.get("mode") in {"text", "table"} else None,
        "packages": {name: packages.get(name) for name in ("paddlepaddle", "paddleocr", "paddlex", "pyinstaller")},
        "privacy": "No document paths, OCR text, raw stderr, source documents or environment variables included."
    }


def open_logs() -> dict[str, Any]:
    directory = log_directory()
    if os.name == "nt":
        os.startfile(str(directory))
    else:
        subprocess.Popen(["xdg-open", str(directory)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"opened": True}


def export_diagnostics(directory_value: str, report: dict[str, Any]) -> dict[str, str]:
    directory = Path(directory_value).expanduser().resolve(strict=True)
    if not directory_value or not directory.is_dir():
        raise ValueError("请选择诊断包导出目录")
    stem = "local-ocr-diagnostics-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = directory / f"{stem}.zip"
    number = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{number}.zip"
        number += 1
    with zipfile.ZipFile(candidate, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("diagnostics.json", json.dumps(safe_report(report), ensure_ascii=False, indent=2))
        for name in ("events.jsonl.2", "events.jsonl.1", "events.jsonl"):
            source = log_directory() / name
            if not source.is_file() or source.is_symlink():
                continue
            clean_lines = []
            for line in source.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    entry = json.loads(line)
                    timestamp = dt.datetime.fromisoformat(entry["time"]).isoformat()
                    clean_lines.append(json.dumps({"time": timestamp,
                        "method": entry.get("method") if entry.get("method") in METHODS else "other",
                        "category": entry.get("category") if entry.get("category") in CATEGORIES else "unknown"}))
                except (ValueError, KeyError, TypeError):
                    continue
            archive.writestr(name, "\n".join(clean_lines))
    return {"path": str(candidate)}
