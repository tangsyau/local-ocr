"""Exercise real frozen subprocesses, selected PDF pages and portable model packs.

Run after smoke-sidecar --prepare --table. Only the lightweight profile is
transferred; this does not download accurate models again.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path

from platform_target import target_triple

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("smoke_sidecar", ROOT / "scripts/smoke-sidecar.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main() -> None:
    from pypdfium2 import PdfDocument
    binary = ROOT / "src-tauri/binaries" / f"ocr-sidecar-{target_triple()}{'.exe' if os.name == 'nt' else ''}"
    with tempfile.TemporaryDirectory(prefix="local-ocr-transfer-smoke-") as directory:
        root = Path(directory)
        pdf_path = root / "three-pages.pdf"
        with PdfDocument.new() as document:
            for _ in range(3):
                document.new_page(200, 120).close()
            document.save(pdf_path)
        png_path = root / "image.png"
        smoke.write_smoke_png(png_path)
        pack_path = root / "LocalOCR-models"
        requests = [
            smoke.request("pack-export", "export_model_pack", {"directory": directory, "capabilities": [{"profile": "fast", "mode": "table"}]}),
            smoke.request("pack-import", "import_model_pack", {"directory": str(pack_path)}),
            smoke.request("local-prepare", "prepare", {"profile": "fast", "mode": "text", "localOnly": True}),
            smoke.request("selected-pages", "recognize", {"path": str(pdf_path), "pageRange": "1,3", "mode": "text"}),
            smoke.request("rotated-image", "recognize", {"path": str(png_path), "rotation": 90, "mode": "text"}),
            smoke.request("done", "shutdown"),
        ]
        results, events = smoke.run_sidecar(binary, requests, 1800, "portable-models-and-document-settings")
        for request_id, response in results.items():
            if response.get("type") == "error":
                raise RuntimeError(f"{request_id}: {response}")
        manifest = json.loads((pack_path / "model-pack.json").read_text(encoding="utf-8"))
        assert len({entry["path"] for entry in manifest["files"]}) == len(manifest["files"])
        assert results["pack-import"]["result"]["modelCount"] == 4
        selected = results["selected-pages"]["result"]
        assert [page["pageIndex"] for page in selected["pages"]] == [0, 2]
        assert selected["totalPageCount"] == 3 and selected["selectedPageCount"] == 2
        progress = [event for event in events["selected-pages"] if event.get("event") == "progress"]
        assert [event["page"] for event in progress] == [1, 2]
        assert all(event["pageCount"] == 2 for event in progress)
        assert results["rotated-image"]["result"]["rotation"] == 90
        print("Frozen model export/import, local-only preparation, PDF selection and rotation passed")


if __name__ == "__main__":
    main()
