"""Launch the actual packaged UI and require a frontend -> sidecar handshake.

Windows performs a silent NSIS install into a temporary directory. Run that
variant only in a disposable CI runner, never over a personal installation.
Linux extracts an AppImage into a temporary directory and runs its AppRun.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import tempfile
import time


def assert_x64(path: Path) -> None:
    with path.open("rb") as stream:
        header = stream.read(64)
        if header[:4] == b"\x7fELF":
            if header[4] != 2 or struct.unpack_from("<H", header, 18)[0] != 62:
                raise RuntimeError(f"Not an x64 ELF: {path.name}")
        elif header[:2] == b"MZ":
            stream.seek(struct.unpack_from("<I", header, 0x3C)[0])
            signature = stream.read(6)
            if signature[:4] != b"PE\0\0" or struct.unpack_from("<H", signature, 4)[0] != 0x8664:
                raise RuntimeError(f"Not an x64 PE: {path.name}")
        else:
            raise RuntimeError(f"Unknown executable format: {path.name}")


def stop_tree(process: subprocess.Popen) -> None:
    if os.name == "nt":
        if process.poll() is None:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    if process.poll() is None:
        process.wait(timeout=10)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=150)
    args = parser.parse_args()
    expected_version = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text(encoding="utf-8"))["version"]
    extension = "*.exe" if os.name == "nt" else "*.AppImage"
    bundles = sorted(args.bundle_dir.resolve().glob(extension))
    current_bundles = [bundle for bundle in bundles if expected_version in bundle.name]
    if current_bundles:
        bundles = current_bundles
    if len(bundles) != 1:
        raise RuntimeError(f"Expected exactly one installer/AppImage in {args.bundle_dir}, got {len(bundles)}")
    if os.name == "nt" and os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Windows installer smoke test is restricted to disposable GitHub Actions runners")
    with tempfile.TemporaryDirectory(prefix="ocr-desktop-test-") as temporary:
        root = Path(temporary)
        install = root / "installed"
        uninstallers: list[Path] = []
        if os.name == "nt":
            # NSIS requires /D as the last argument, without quoting its value.
            subprocess.run(f'"{bundles[0]}" /S /D={install}', check=True, timeout=240)
            applications = [file for file in install.glob("*.exe") if "sidecar" not in file.name.lower() and "unins" not in file.name.lower()]
            if len(applications) != 1:
                raise RuntimeError("Installed main executable missing or ambiguous")
            app = applications[0]
            assert_x64(app)
            sidecars = list(install.rglob("ocr-sidecar.exe"))
            uninstallers = list(install.glob("*ninstall*.exe"))
        else:
            assert_x64(bundles[0])
            subprocess.run([str(bundles[0]), "--appimage-extract"], cwd=root, check=True, stdout=subprocess.DEVNULL, timeout=180)
            install = root / "squashfs-root"
            app = install / "AppRun"
            sidecars = list(install.rglob("ocr-sidecar"))
        if not sidecars:
            raise RuntimeError("Package is missing its OCR sidecar")
        for sidecar in sidecars:
            assert_x64(sidecar)
        env = {**os.environ, "LOCAL_OCR_UI_SMOKE_DIR": str(root), "WEBKIT_DISABLE_COMPOSITING_MODE": "1"}
        with (root / "desktop.log").open("wb") as log:
            process = subprocess.Popen([str(app)], cwd=install, env=env, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=os.name != "nt")
            try:
                deadline = time.monotonic() + args.timeout
                marker = root / "ready.json"
                while not marker.exists():
                    if process.poll() is not None:
                        raise RuntimeError(f"Installed desktop app exited early: {process.returncode}")
                    if time.monotonic() > deadline:
                        raise TimeoutError("No frontend-to-sidecar handshake from the installed application")
                    time.sleep(0.25)
                report = json.loads(marker.read_text(encoding="utf-8"))
                if report.get("appVersion") != expected_version:
                    raise RuntimeError("Packaged sidecar version does not match the source version")
                if not report.get("sidecar") or report.get("width", 0) < 300 or report.get("height", 0) < 300:
                    raise RuntimeError(f"Invalid desktop handshake: {report}")
                if report["height"] >= 850 and not report.get("sidebarFits"):
                    raise RuntimeError("Initial sidebar overflows a full-size desktop window")
                time.sleep(1)
                if process.poll() is not None:
                    raise RuntimeError("Desktop exited immediately after its UI handshake")
                print("Packaged desktop UI smoke test passed: " + json.dumps(report))
            except Exception:
                print((root / "desktop.log").read_text(encoding="utf-8", errors="replace")[-8000:])
                raise
            finally:
                stop_tree(process)
                for uninstaller in uninstallers:
                    subprocess.run(f'"{uninstaller}" /S _?={install}', check=False, timeout=120)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
