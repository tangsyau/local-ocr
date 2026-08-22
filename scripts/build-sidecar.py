from __future__ import annotations

import os
import shutil
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path

from platform_target import target_triple


ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "sidecar"
BINARIES = ROOT / "src-tauri" / "binaries"

# PaddleX checks these installed distributions with importlib.metadata before it
# creates the OCR pipeline. PyInstaller includes their modules, but distribution
# metadata is not guaranteed to be frozen unless it is requested explicitly.
OCR_METADATA_DISTRIBUTIONS = (
    "paddlex",
    "imagesize",
    "opencv-contrib-python",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
)


def paddle_cpu_runtimes() -> tuple[Path, ...]:
    """Locate Paddle's lazily loaded CPU runtimes for this platform."""

    spec = find_spec("paddle")
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError("The paddle package is not installed")

    if os.name == "nt":
        # mklml.dll is loaded by filename and depends on libiomp5md.dll.
        # Both must be in the onefile extraction directory's top level.
        library_names = ("mklml.dll", "libiomp5md.dll")
    elif sys.platform.startswith("linux"):
        library_names = ("libmklml_intel.so",)
    else:
        raise RuntimeError(f"Unsupported sidecar build platform: {sys.platform}")

    library_dir = Path(next(iter(spec.submodule_search_locations))) / "libs"
    libraries = tuple(library_dir / name for name in library_names)
    missing = [str(library) for library in libraries if not library.is_file()]
    if missing:
        raise FileNotFoundError(f"Paddle CPU runtime not found: {', '.join(missing)}")
    return libraries


def main() -> int:
    name = "ocr-sidecar"
    executable = f"{name}.exe" if os.name == "nt" else name
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        name,
        "--paths",
        str(SIDECAR),
        "--collect-all",
        "paddleocr",
        "--collect-all",
        "paddlex",
        "--collect-all",
        "paddle",
    ]
    # Paddle loads MKL by filename at predictor creation time. Put additional
    # top-level entries in the onefile extraction directory so the bootloader's
    # DLL/LD_LIBRARY_PATH search path can resolve them and their dependencies.
    for library in paddle_cpu_runtimes():
        command.extend(["--add-binary", f"{library}{os.pathsep}."])
    for distribution in OCR_METADATA_DISTRIBUTIONS:
        command.extend(["--copy-metadata", distribution])
    command.append(str(SIDECAR / "main.py"))
    subprocess.run(command, cwd=SIDECAR, check=True)

    source = SIDECAR / "dist" / executable
    destination = BINARIES / f"{name}-{target_triple()}{'.exe' if os.name == 'nt' else ''}"
    BINARIES.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    print(f"Created Tauri sidecar: {destination}")

    # The copied target-triple binary is the only file Tauri needs. Removing
    # PyInstaller's duplicate work products saves several GB on CI runners.
    shutil.rmtree(SIDECAR / "build", ignore_errors=True)
    shutil.rmtree(SIDECAR / "dist", ignore_errors=True)
    (SIDECAR / f"{name}.spec").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
