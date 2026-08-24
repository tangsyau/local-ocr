from __future__ import annotations

import os
import shutil
from pathlib import Path

from platform_target import target_triple


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "src-tauri" / "binaries"
DESTINATION_DIR = ROOT / "compat" / "webkitgtk-4.0" / "src-tauri" / "binaries"


def main() -> int:
    suffix = ".exe" if os.name == "nt" else ""
    filename = f"ocr-sidecar-{target_triple()}{suffix}"
    source = SOURCE_DIR / filename
    if not source.is_file():
        raise FileNotFoundError(f"Frozen sidecar not found: {source}")

    DESTINATION_DIR.mkdir(parents=True, exist_ok=True)
    destination = DESTINATION_DIR / filename
    shutil.copy2(source, destination)
    print(f"Staged WebKitGTK 4.0 sidecar: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
