"""Preview and publish locally rendered exports with explicit collision rules."""
from __future__ import annotations

import copy
import datetime as dt
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from engine import export_table_results, export_text_results


def safe_name(value: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" .")[:160]
    if not name:
        name = "识别结果"
    if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.I):
        name = f"_{name}"
    return name


def _decorate(stem: str, item: dict[str, Any], options: dict[str, Any]) -> str:
    tokens = {
        "{date}": dt.date.today().isoformat(),
        "{profile}": {"fast": "轻量", "accurate": "高精度"}.get(item.get("profile"), "混合"),
        "{mode}": {"text": "文字", "table": "表格"}.get(item.get("mode"), "混合"),
    }
    value = f"{str(options.get('prefix') or '')[:100]}{stem}{str(options.get('suffix') or '')[:100]}"
    for token, replacement in tokens.items():
        value = value.replace(token, replacement)
    return safe_name(value)


def _documents(payload: dict[str, Any]) -> list[dict[str, Any]]:
    options = payload.get("options") or {}
    formats = list(dict.fromkeys(payload.get("formats") or []))
    if not formats or set(formats) - {"txt", "xlsx", "html"}:
        raise ValueError("请选择 TXT、XLSX、HTML 中的至少一种格式")
    texts = list(payload.get("textItems") or [])
    tables = [item for item in payload.get("tableItems") or [] if item.get("tables")]
    if options.get("grouping", "separate") not in {"separate", "combined"}:
        raise ValueError("未知导出分组方式")
    if options.get("grouping") == "combined":
        source = str(options.get("name") or "批量识别结果")
        profiles = {item.get("profile") for item in texts}
        modes = {item.get("mode") for item in texts}
        common = {"fileName": source + ".ocr", "profile": next(iter(profiles)) if len(profiles) == 1 else None,
                  "mode": next(iter(modes)) if len(modes) == 1 else None}
        if texts:
            texts = [{**common, "ids": [item["id"] for item in texts],
                      "text": "\n\n".join(f"—— {item.get('fileName', '')} ——\n{item.get('text', '')}" for item in texts)}]
        if tables:
            joined = []
            for item in tables:
                for table in item["tables"]:
                    joined.append({**copy.deepcopy(table), "sourceName": item.get("fileName", "")})
            tables = [{**common, "ids": [task_id for item in tables for task_id in item.get("ids", [])], "tables": joined}]
    documents = []
    for fmt in formats:
        for item in texts if fmt == "txt" else tables:
            # Interpret both Windows and POSIX source basenames on either OS.
            source_name = str(item.get("fileName") or "识别结果").replace("\\", "/").split("/")[-1]
            stem = Path(source_name).stem
            suffix = ".tables.html" if fmt == "html" else f".{fmt}"
            documents.append({"name": _decorate(stem, item, options) + suffix, "format": fmt,
                              "ids": item.get("ids") or [item.get("id")], "item": item})
    return documents


def _plan(payload: dict[str, Any]) -> tuple[Path, list[dict[str, Any]]]:
    directory = Path(str(payload.get("directory") or "")).expanduser().resolve(strict=True)
    if not str(payload.get("directory") or "") or not directory.is_dir():
        raise ValueError("请选择有效的导出文件夹")
    collision = (payload.get("options") or {}).get("collision", "rename")
    if collision not in {"rename", "skip", "overwrite"}:
        raise ValueError("未知同名文件处理方式")
    reserved: set[Path] = set()
    planned = []
    for document in _documents(payload):
        target = directory / document["name"]
        original = target
        number = 2
        # Two documents in this export must never overwrite each other, even if
        # the user chose overwrite for pre-existing files.
        while target in reserved or (collision == "rename" and target.exists()):
            target = directory / f"{original.stem} ({number}){original.suffix}"
            number += 1
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError("导出目标包含符号链接或同名目录，请更改文件名或导出目录")
        action = "skip" if target.exists() and collision == "skip" else "overwrite" if target.exists() else "create"
        reserved.add(target)
        planned.append({**document, "name": target.name, "target": target, "action": action})
    return directory, planned


def preview_exports(payload: dict[str, Any]) -> dict[str, Any]:
    _, planned = _plan(payload)
    ids_with_tables = {task_id for item in payload.get("tableItems") or [] if item.get("tables") for task_id in item.get("ids", [])}
    no_tables = sum(item.get("id") not in ids_with_tables for item in payload.get("textItems") or [])
    return {
        "count": sum(item["action"] != "skip" for item in planned),
        "skipped": sum(item["action"] == "skip" for item in planned),
        "overwrites": sum(item["action"] == "overwrite" for item in planned),
        "noTableCount": no_tables,
        "files": [{"name": item["name"], "format": item["format"], "action": item["action"]} for item in planned],
    }


def export_results(payload: dict[str, Any]) -> dict[str, Any]:
    directory, planned = _plan(payload)
    summary = preview_exports(payload)
    exported = []
    # No source document is read here. The renderer receives only OCR result data.
    with tempfile.TemporaryDirectory(prefix="local-ocr-render-") as temporary:
        for ordinal, item in enumerate(planned):
            if item["action"] == "skip":
                continue
            source_name = str(item["item"].get("fileName") or "识别结果").replace("\\", "/").split("/")[-1]
            render_item = {**item["item"], "fileName": safe_name(source_name)}
            if item["format"] == "txt":
                rendered = export_text_results(temporary, [render_item])["files"][0]["path"]
            else:
                rendered = export_table_results(temporary, [render_item], [item["format"]])["files"][0][item["format"]]
            target = item["target"]
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise ValueError("导出目标发生变化，已停止写入")
            if item["action"] == "overwrite":
                descriptor, temporary_name = tempfile.mkstemp(prefix=".local-ocr-export-", dir=directory)
                try:
                    with os.fdopen(descriptor, "wb") as destination, open(rendered, "rb") as source:
                        shutil.copyfileobj(source, destination)
                        destination.flush()
                        os.fsync(destination.fileno())
                    os.replace(temporary_name, target)
                finally:
                    if os.path.exists(temporary_name):
                        os.unlink(temporary_name)
            else:
                # Fail safely if another process creates the target after preview.
                with target.open("xb") as destination:
                    try:
                        with open(rendered, "rb") as source:
                            shutil.copyfileobj(source, destination)
                        destination.flush()
                        os.fsync(destination.fileno())
                    except Exception:
                        destination.close()
                        target.unlink(missing_ok=True)
                        raise
            exported.append({"name": target.name, "format": item["format"], "ids": item["ids"]})
    return {**summary, "count": len(exported), "files": exported,
            "exportedIds": list(dict.fromkeys(task_id for item in exported for task_id in item["ids"] if task_id))}
