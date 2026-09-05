"""Geometry shared by embedded PDF text and OCR. No language-model rewriting."""
from __future__ import annotations

import math
import statistics
from typing import Any


def bounds(block: dict) -> list[float]:
    box = block.get("box", [])
    if len(box) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in box):
        return list(box)
    points = block.get("polygon", [])
    if points:
        return [min(p[0] for p in points), min(p[1] for p in points),
                max(p[0] for p in points), max(p[1] for p in points)]
    return []


def group_glyphs(glyphs: list[dict], direction: str) -> list[dict]:
    """Bucket glyphs by their cross-axis centers, separating sizes and large gaps."""
    vertical = direction == "vertical"
    cross, along = (0, 1) if vertical else (1, 0)
    buckets: dict[int, list[list[dict]]] = {}
    unit = max(1., statistics.median(g["size"] for g in glyphs) * .4) if glyphs else 1.
    for glyph in glyphs:
        box, size = glyph["box"], glyph["size"]
        center = (box[cross] + box[cross + 2]) / 2
        slot = int(center / unit)
        candidates = [line for key in (slot - 1, slot, slot + 1) for line in buckets.get(key, [])]
        line = next((line for line in candidates if
                     abs(center - (line[0]["box"][cross] + line[0]["box"][cross + 2]) / 2) < size * .38
                     and .72 < size / max(line[0]["size"], .1) < 1.4), None)
        if line is None:
            line = []
            buckets.setdefault(slot, []).append(line)
        line.append(glyph)
    result = []
    for lines in buckets.values():
        for line in lines:
            line.sort(key=lambda g: g["box"][along])
            segments: list[list[dict]] = [[]]
            for glyph in line:
                last = segments[-1][-1] if segments[-1] else None
                if last and glyph["box"][along] - last["box"][along + 2] > glyph["size"] * 1.7:
                    segments.append([])
                segments[-1].append(glyph)
            for segment in segments:
                text, chars = "", []
                for index, glyph in enumerate(segment):
                    if index and not vertical:
                        prev = segment[index - 1]
                        if (glyph["box"][0] - prev["box"][2] > glyph["size"] * .22
                                and prev["text"][-1:].isascii() and glyph["text"][:1].isascii()
                                and not text.endswith(" ") and glyph["text"] != " "):
                            text += " "
                    chars.append({"text": glyph["text"], "box": glyph["box"], "offset": len(text)})
                    text += glyph["text"]
                box = [min(g["box"][0] for g in segment), min(g["box"][1] for g in segment),
                       max(g["box"][2] for g in segment), max(g["box"][3] for g in segment)]
                if text.strip():
                    result.append({"text": text, "score": None, "box": box, "polygon": [],
                                   "direction": direction, "fontSize": statistics.median(g["size"] for g in segment),
                                   "chars": chars, "source": "pdf-text"})
    result.sort(key=lambda b: (-b["box"][0], b["box"][1]) if vertical else (b["box"][1], b["box"][0]))
    return result


def infer_glyph_direction(glyphs: list[dict]) -> str:
    votes = []
    for a, b in zip(glyphs, glyphs[1:]):
        if not a["text"].strip() or not b["text"].strip():
            continue
        dx = abs(b["box"][0] - a["box"][0])
        dy = abs(b["box"][1] - a["box"][1])
        size = max(a["size"], b["size"])
        if dy > dx * 2 and dy < size * 2.5:
            votes.append(1)
        elif dx > dy * 2 and dx < size * 2.5:
            votes.append(0)
    return "vertical" if votes and sum(votes) > len(votes) * .65 else "horizontal"


def normalize_page(page: dict, width: float, height: float, source: str, ruby: bool = False) -> dict:
    page.update({"schemaVersion": 1, "width": width, "height": height, "source": source,
                 "rawText": page["text"], "rubyEnabled": ruby})
    for index, block in enumerate(page["blocks"]):
        box = bounds(block)
        block.update({"id": str(index), "box": box, "source": source})
        block.setdefault("direction", "vertical" if box and box[3] - box[1] > (box[2] - box[0]) * 1.8 else "horizontal")
        block.setdefault("fontSize", min(box[2] - box[0], box[3] - box[1]) if box else 0)
        block.setdefault("role", "body")
    if ruby:
        bind_ruby(page["blocks"])
    return page


def bind_ruby(blocks: list[dict]) -> None:
    """Bind small side text without a dictionary; unmatched text stays recoverable."""
    for small in blocks:
        if not small.get("box") or not small.get("text", "").strip():
            continue
        s = small["box"]
        candidates = []
        for body in blocks:
            b = body.get("box")
            if body is small or not b or body.get("role") == "ruby":
                continue
            if not .22 <= small["fontSize"] / max(body["fontSize"], .1) <= .7:
                continue
            vertical = body["direction"] == "vertical"
            axis = 1 if vertical else 0
            overlap = min(s[axis+2], b[axis+2]) - max(s[axis], b[axis])
            gap = s[0] - b[2] if vertical else b[1] - s[3]
            if overlap < (s[axis+2] - s[axis]) * .45 or not -body["fontSize"] * .15 <= gap <= body["fontSize"] * .9:
                continue
            candidates.append((max(0, gap), body, axis))
        if not candidates:
            if small.get("rubyCandidate"):
                small["role"] = "ruby-unmatched"
            continue
        _, body, axis = min(candidates, key=lambda v: v[0])
        b = body["box"]
        chars = body.get("chars", [])
        matching = [c for c in chars if s[axis] <= (c["box"][axis] + c["box"][axis+2]) / 2 <= s[axis+2]]
        if matching:
            start = matching[0]["offset"]
            end = matching[-1]["offset"] + len(matching[-1]["text"])
        else:
            length = len(body["text"])
            extent = max(1, b[axis+2] - b[axis])
            start = max(0, min(length - 1, round((s[axis] - b[axis]) / extent * length)))
            end = max(start + 1, min(length, round((s[axis+2] - b[axis]) / extent * length)))
        # Do not create overlapping ruby ranges; preserve ambiguous candidates.
        if any(start < r["end"] and end > r["start"] for r in body.get("ruby", [])):
            small["role"] = "ruby-unmatched"
            continue
        body.setdefault("ruby", []).append({"start": start, "end": end, "text": small["text"].strip(),
                                            "score": small.get("score"), "box": s,
                                            "alignment": "characters" if matching else "estimated"})
        small.update({"role": "ruby", "parentId": body["id"]})


def ruby_regions(pixels: Any) -> list[list[int]]:
    """Conservative CPU preprocessor for regular printed pages, not manga.

    Estimate glyph sizes, group small connected components into short rows and
    columns, and require a larger adjacent text run. No source image is changed.
    """
    import cv2
    gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
    # Limit analysis work independently of the high-DPI OCR image.
    ratio = min(1., 2200 / max(gray.shape))
    if ratio < 1:
        gray = cv2.resize(gray, None, fx=ratio, fy=ratio)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    count, _, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    h, w = gray.shape
    components = [r for r in stats[1:] if r[4] >= 4 and 2 <= max(r[2], r[3]) <= min(h, w) * .08]
    if len(components) < 15 or count > 100000:
        return []
    size = float(__import__("numpy").percentile([max(r[2], r[3]) for r in components], 70))
    big, small = [], []
    for x, y, cw, ch, area in components:
        extent = max(cw, ch)
        glyph = {"text": "字", "box": [int(x), int(y), int(x+cw), int(y+ch)], "size": size}
        if .75 * size <= extent <= 1.5 * size:
            big.append(glyph)
        elif .24 * size <= extent <= .65 * size:
            small.append({**glyph, "size": size * .5})
    regions = []
    layouts = {direction: [b for b in group_glyphs(big, direction) if len(b["text"]) >= 3]
               for direction in ("horizontal", "vertical")}
    # Regular-book scope: choose the dominant writing axis. Running both axes
    # indiscriminately mistakes components of kanji for horizontal ruby.
    direction = max(layouts, key=lambda key: sum(len(b["text"])**2 for b in layouts[key]))
    for direction in (direction,):
        bodies = layouts[direction]
        readings = [b for b in group_glyphs(small, direction) if 2 <= len(b["text"]) <= 24]
        cross = 0 if direction == "vertical" else 1
        readings = [reading for reading in readings if not any(
            min(reading["box"][cross+2], b["box"][cross+2]) - max(reading["box"][cross], b["box"][cross])
            > (reading["box"][cross+2]-reading["box"][cross]) * .3
            for b in bodies if len(b["text"]) >= 6)]
        for i, block in enumerate(bodies + readings):
            block.update({"id": str(i), "role": "body"})
        bind_ruby(bodies + readings)
        for reading in readings:
            if reading["role"] != "ruby":
                continue
            region = [int(v / ratio) for v in reading["box"]]
            if not any(abs(region[0]-b[0]) < size and abs(region[1]-b[1]) < size for b in regions):
                regions.append(region)
    return regions[:300]
