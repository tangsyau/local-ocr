from __future__ import annotations

import contextlib
import ctypes
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable

from network_guard import block_python_network


ProgressCallback = Callable[[str, int | None], None]
SUPPORTED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf"}


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


class OcrEngine:
    def __init__(self) -> None:
        self._ocr: Any | None = None
        self._native_runtime: Any | None = None

    @property
    def ready(self) -> bool:
        return self._ocr is not None

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

    def prepare(self, progress: ProgressCallback | None = None) -> dict[str, Any]:
        if self._ocr is not None:
            return {"ready": True, "downloaded": False, "model": "PP-OCRv5 mobile"}

        if progress:
            progress("正在检查并下载 PP-OCRv5 轻量模型……", None)

        # PaddleOCR may emit progress information. Keep stdout reserved for NDJSON.
        with contextlib.redirect_stdout(sys.stderr):
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device="cpu",
                cpu_threads=max(1, min(os.cpu_count() or 4, 8)),
            )

        if progress:
            progress("模型已下载并载入本机内存", None)
        return {"ready": True, "downloaded": True, "model": "PP-OCRv5 mobile"}

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
        if progress:
            progress("已封锁 Python 网络连接，开始读取本地文档……", None)

        with block_python_network(), contextlib.redirect_stdout(sys.stderr):
            results = self._ocr.predict_iter(
                str(path),
                text_rec_score_thresh=score_threshold,
            )
            for page_number, result in enumerate(results, start=1):
                pages.append(extract_page(result))
                if progress:
                    progress(f"已完成第 {page_number} 页", page_number)

        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "path": str(path),
            "text": "\n\n".join(page["text"] for page in pages if page["text"]),
            "pageCount": len(pages),
            "blockCount": sum(len(page["blocks"]) for page in pages),
            "elapsedMs": elapsed_ms,
            "pages": pages,
        }
