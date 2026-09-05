"""Conservative PDFium text-layer extraction, with top-left point coordinates."""
from __future__ import annotations

import unicodedata
from contextlib import closing
from text_layout import group_glyphs, infer_glyph_direction, normalize_page


def extract_pdf_page(page, index: int, ruby: bool = False) -> dict | None:
    from pypdfium2 import raw
    width, height = page.get_size()
    # Rotated and cropped coordinate systems need special transforms; fall back
    # to rendering until these can be verified rather than misplacing ruby.
    if page.get_rotation() or tuple(page.get_bbox()) != (0., 0., width, height):
        return None
    # A text header over a scanned body is not a complete text page. Keep the
    # whole page visual when it includes a nontrivial raster image (also covers
    # PDF OCR overlays whose correctness cannot be proved from text alone).
    for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE], max_depth=8):
        left, bottom, right, top = obj.get_bounds()
        if (right-left) * (top-bottom) > width * height * .025:
            return None
    with closing(page.get_textpage()) as textpage:
        count = textpage.count_chars()
        if not 1 <= count <= 100000:
            return None
        glyphs, bad, visible = [], 0, 0
        for index_char in range(count):
            code = raw.FPDFText_GetUnicode(textpage, index_char)
            if code == 0 or code > 0x10FFFF:
                bad += 1
                continue
            char = chr(code)
            if char in "\r\n\t":
                continue
            if char == "\ufffd" or unicodedata.category(char) in {"Co", "Cs", "Cn", "Cc"}:
                bad += 1
                continue
            if not char.isspace():
                visible += 1
            left, bottom, right, top = textpage.get_charbox(index_char)
            size = raw.FPDFText_GetFontSize(textpage, index_char)
            if right <= left or top <= bottom or size <= 0:
                if not char.isspace():
                    bad += 1
                continue
            glyphs.append({"text": char, "box": [left, height-top, right, height-bottom], "size": size})
        if visible < 3 or bad or not glyphs:
            return None
        blocks = group_glyphs(glyphs, infer_glyph_direction(glyphs))
        if not blocks:
            return None
        return normalize_page({"pageIndex": index, "text": "\n".join(b["text"] for b in blocks),
                               "blocks": blocks, "tables": []}, width, height, "pdf-text", ruby)
