"""Local-only page selection and orientation; source files are never modified."""
from __future__ import annotations

import contextlib
import re
import threading
from pathlib import Path
from typing import Any, Iterator


def initialize_document_runtime() -> None:
    """Warm native readers and Pillow plugins before stdin resumes on Windows.

    Keep decoding/rendering in the worker, but do not let the first image trigger
    native module or image-plugin initialization there. This also covers a
    source test that substitutes Paddle and therefore doesn't import its readers.
    """
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("图片与 PDF 依赖首次初始化必须由 sidecar 主线程执行")
    import numpy  # noqa: F401
    from PIL import Image, ImageOps  # noqa: F401
    import pypdfium2  # noqa: F401
    import cv2  # noqa: F401

    Image.init()


def parse_page_range(value: str, total: int) -> list[int]:
    """Return sorted zero-based physical PDF pages, rejecting every invalid token."""
    if total < 1:
        raise ValueError("PDF 没有可识别的页面")
    if not isinstance(value, str) or len(value) > 2000:
        raise ValueError("页码格式无效，请输入例如 1,3-5,8")
    value = value.strip().replace("，", ",")
    if not value:
        return list(range(total))
    selected: set[int] = set()
    for token in value.split(","):
        match = re.fullmatch(r"\s*([0-9]{1,9})\s*(?:-\s*([0-9]{1,9})\s*)?", token)
        if not match:
            raise ValueError(f"页码格式无效：{token.strip()}；例如 1,3-5,8")
        start, end = int(match[1]), int(match[2] or match[1])
        if start < 1 or end < start or end > total:
            raise ValueError(f"页码 {token.strip()} 无效；此 PDF 共 {total} 页，请使用 1–{total} 且起始页不大于结束页")
        selected.update(range(start - 1, end))
    return sorted(selected)


def validate_rotation(value: Any) -> int:
    if type(value) is not int or value not in (0, 90, 180, 270):
        raise ValueError("图片旋转角度只能是 0、90、180 或 270 度")
    return value


def load_image(path: Path, rotation: int = 0) -> Any:
    import numpy as np
    from PIL import Image, ImageOps

    validate_rotation(rotation)
    with Image.open(path) as source:
        oriented = ImageOps.exif_transpose(source)
        try:
            rgba = oriented.convert("RGBA")
            try:
                background = Image.new("RGBA", rgba.size, "white")
                try:
                    background.alpha_composite(rgba)
                    rgb = background.convert("RGB")
                finally:
                    background.close()
            finally:
                rgba.close()
            with rgb:
                with rgb.rotate(-rotation, expand=True) as rotated:
                    # PaddleX ndarray inputs are BGR, not Pillow's RGB.
                    return np.ascontiguousarray(np.asarray(rotated)[:, :, ::-1])
        finally:
            oriented.close()


@contextlib.contextmanager
def document_inputs(path: Path, selected: list[int], rotation: int = 0, *, pdf_source: str = "ocr", ruby: bool = False) -> Iterator[Iterator[tuple[int, Any]]]:
    if path.suffix.lower() != ".pdf":
        # Match PDF's lazy reader: emit the source-page event and check cancel
        # before any potentially expensive image decoding starts.
        def read_image() -> Iterator[tuple[int, Any]]:
            yield 0, load_image(path, rotation)
        yield read_image()
        return
    if rotation:
        raise ValueError("本版本仅支持图片旋转，PDF 请保持 0 度")
    import numpy as np
    from pypdfium2 import PdfDocument

    document = PdfDocument(str(path))
    try:
        def render() -> Iterator[tuple[int, Any]]:
            for index in selected:
                page = document[index]
                try:
                    if pdf_source == "auto":
                        from pdf_text import extract_pdf_page
                        try:
                            extracted = extract_pdf_page(page, index, ruby)
                        except (ValueError, RuntimeError):
                            extracted = None
                        if extracted is not None:
                            yield index, extracted
                            continue
                    # Same 2x scale as the former PaddleX PDF reader. Bound huge
                    # engineering sheets to avoid unbounded bitmap allocation.
                    width, height = page.get_size()
                    scale = min(4.2 if ruby else 2.0, (24_000_000 / max(width * height, 1)) ** 0.5, 8192 / max(width, height, 1))
                    bitmap = page.render(scale=scale)
                    try:
                        with bitmap.to_pil().convert("RGB") as image:
                            pixels = np.ascontiguousarray(np.asarray(image)[:, :, ::-1])
                    finally:
                        bitmap.close()
                finally:
                    page.close()
                yield index, pixels
                del pixels
        yield render()
    finally:
        document.close()
