from __future__ import annotations

import contextlib
import ctypes
import gc
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from network_guard import block_python_network


ProgressCallback = Callable[[str, int | None, str, int | None], None]
SUPPORTED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf"}
MODEL_PROFILES = {
    "fast": {
        "label": "PP-OCRv5 轻量",
        "detection": "PP-OCRv5_mobile_det",
        "recognition": "PP-OCRv5_mobile_rec",
    },
    "accurate": {
        "label": "PP-OCRv5 高精度",
        "detection": "PP-OCRv5_server_det",
        "recognition": "PP-OCRv5_server_rec",
    },
}


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if hasattr(value, "tolist"):
        return _jsonable(value.tolist())
    return str(value)


def extract_page(result: Any) -> dict[str, Any]:
    """Convert PaddleOCR 3.x's Result.json payload into the stable app schema."""

    raw = _jsonable(result.json)
    payload = raw.get("res", raw) if isinstance(raw, dict) else {}
    texts = list(payload.get("rec_texts") or [])
    scores = list(payload.get("rec_scores") or [])
    polygons = list(payload.get("rec_polys") or [])
    boxes = list(payload.get("rec_boxes") or [])

    blocks: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        clean_text = str(text).strip()
        if not clean_text:
            continue
        blocks.append(
            {
                "text": clean_text,
                "score": float(scores[index]) if index < len(scores) else 0.0,
                "polygon": polygons[index] if index < len(polygons) else [],
                "box": boxes[index] if index < len(boxes) else [],
            }
        )

    return {
        "pageIndex": payload.get("page_index"),
        "text": "\n".join(block["text"] for block in blocks),
        "blocks": blocks,
    }


def document_page_count(path: Path) -> int:
    if path.suffix.lower() != ".pdf":
        return 1
    from pypdfium2 import PdfDocument

    document = PdfDocument(str(path))
    try:
        return len(document)
    finally:
        document.close()


class OcrEngine:
    def __init__(self) -> None:
        self._ocr: Any | None = None
        self._profile: str | None = None
        self._native_runtime: Any | None = None
        self._pause_requested = threading.Event()
        self._cancel_requested = threading.Event()

    @property
    def ready(self) -> bool:
        return self._ocr is not None

    @property
    def profile(self) -> str | None:
        return self._profile

    def check_native_runtime(self) -> dict[str, Any]:
        """Verify that Paddle's lazily loaded CPU runtime is discoverable."""

        if os.name == "nt":
            library_name = "mklml.dll"
            loader = ctypes.WinDLL
        elif sys.platform.startswith("linux"):
            library_name = "libmklml_intel.so"
            loader = ctypes.CDLL
        else:
            raise RuntimeError(f"Unsupported sidecar runtime platform: {sys.platform}")

        # Keep the handle alive for the rest of the process so Paddle can reuse
        # the already loaded library when it creates a predictor.
        if self._native_runtime is None:
            self._native_runtime = loader(library_name)
        return {"ok": True, "library": library_name}

    def prepare(self, profile: str = "fast", progress: ProgressCallback | None = None) -> dict[str, Any]:
        if profile not in MODEL_PROFILES:
            raise ValueError(f"未知模型档位：{profile}")
        model = MODEL_PROFILES[profile]
        if self._ocr is not None and self._profile == profile:
            return {"ready": True, "downloaded": False, "model": model["label"], "profile": profile}

        if progress:
            progress(f"正在检查并下载{model['label']}模型……", None, "status", None)

        if self._ocr is not None:
            self._ocr = None
            self._profile = None
            gc.collect()

        # PaddleOCR may emit progress information. Keep stdout reserved for NDJSON.
        with contextlib.redirect_stdout(sys.stderr):
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                text_detection_model_name=model["detection"],
                text_recognition_model_name=model["recognition"],
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device="cpu",
                cpu_threads=max(1, min(os.cpu_count() or 4, 8)),
            )
            self._profile = profile

        if progress:
            progress(f"{model['label']}模型已下载并载入本机内存", None, "status", None)
        return {"ready": True, "downloaded": True, "model": model["label"], "profile": profile}

    def reset_job_control(self) -> None:
        self._pause_requested.clear()
        self._cancel_requested.clear()

    def pause(self) -> None:
        self._pause_requested.set()

    def resume(self) -> None:
        self._pause_requested.clear()

    def cancel(self) -> None:
        self._cancel_requested.set()
        self._pause_requested.clear()

    def _wait_if_paused(self, page: int, page_count: int, progress: ProgressCallback | None) -> None:
        if not self._pause_requested.is_set() or self._cancel_requested.is_set():
            return
        if progress:
            progress(f"识别已暂停（第 {page}/{page_count} 页）；已完成的结果会保留", page, "paused", page_count)
        while self._pause_requested.is_set() and not self._cancel_requested.wait(0.1):
            pass
        if progress and not self._cancel_requested.is_set():
            progress(f"继续本地识别，第 {page + 1}/{page_count} 页……", page, "resumed", page_count)

    def recognize(
        self,
        path_value: str,
        score_threshold: float = 0.5,
        progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        path = Path(path_value).expanduser().resolve(strict=True)
        if not path.is_file():
            raise ValueError("所选路径不是文件")
        if path.suffix.lower() not in SUPPORTED_SUFFIXES:
            raise ValueError(f"不支持的文件类型：{path.suffix}")
        if not 0.0 <= score_threshold <= 1.0:
            raise ValueError("最低置信度必须在 0 到 1 之间")
        if self._ocr is None:
            raise RuntimeError("模型尚未准备，请先执行 prepare")

        started = time.perf_counter()
        pages: list[dict[str, Any]] = []
        total_page_count = document_page_count(path)
        if progress:
            if path.suffix.lower() == ".pdf":
                message = f"已读取 PDF，共 {total_page_count} 页；已封锁 Python 网络连接，开始识别……"
            else:
                message = "已封锁 Python 网络连接，开始读取本地图片……"
            progress(message, 0, "status", total_page_count)

        with block_python_network(), contextlib.redirect_stdout(sys.stderr):
            results = self._ocr.predict_iter(
                str(path),
                text_rec_score_thresh=score_threshold,
            )
            for page_number, result in enumerate(results, start=1):
                pages.append(extract_page(result))
                if progress:
                    percent = round(page_number / total_page_count * 100)
                    progress(
                        f"已完成第 {page_number}/{total_page_count} 页（{percent}%）",
                        page_number,
                        "progress",
                        total_page_count,
                    )
                if self._cancel_requested.is_set():
                    break
                self._wait_if_paused(page_number, total_page_count, progress)
                if self._cancel_requested.is_set():
                    break

        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "path": str(path),
            "profile": self._profile,
            "resultType": "text",
            "cancelled": self._cancel_requested.is_set(),
            "text": "\n\n".join(page["text"] for page in pages if page["text"]),
            "pageCount": len(pages),
            "totalPageCount": total_page_count,
            "blockCount": sum(len(page["blocks"]) for page in pages),
            "elapsedMs": elapsed_ms,
            "pages": pages,
        }


def export_text_results(directory_value: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    directory = Path(directory_value).expanduser().resolve(strict=True)
    if not directory.is_dir():
        raise ValueError("导出位置不是文件夹")

    exported: list[dict[str, str]] = []
    reserved: set[Path] = set()
    for item in items:
        source_name = Path(str(item.get("fileName") or "识别结果")).name
        stem = Path(source_name).stem.strip() or "识别结果"
        candidate = directory / f"{stem}.txt"
        index = 2
        while candidate.exists() or candidate in reserved:
            candidate = directory / f"{stem} ({index}).txt"
            index += 1
        candidate.write_text(str(item.get("text") or ""), encoding="utf-8")
        reserved.add(candidate)
        exported.append({"source": source_name, "path": str(candidate)})
    return {"count": len(exported), "files": exported}
