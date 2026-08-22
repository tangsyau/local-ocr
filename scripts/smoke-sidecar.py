from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path
from typing import Any

from platform_target import target_triple


ROOT = Path(__file__).resolve().parents[1]


def request(request_id: str, method: str, params: dict[str, Any] | None = None) -> str:
    return json.dumps({"id": request_id, "method": method, "params": params or {}}, ensure_ascii=False)


def write_smoke_png(path: Path) -> None:
    """Create a dependency-free test image that forces the OCR predictor to run."""

    width, height = 320, 96

    def chunk(kind: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", checksum)

    rows = bytearray()
    for y in range(height):
        rows.append(0)  # PNG filter type: None
        for x in range(width):
            is_ink = (20 <= x < 300 and 20 <= y < 32) or (45 <= x < 275 and 55 <= y < 68)
            value = 0 if is_ink else 255
            rows.extend((value, value, value))

    payload = b"\x89PNG\r\n\x1a\n"
    payload += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    payload += chunk(b"IDAT", zlib.compress(bytes(rows), level=9))
    payload += chunk(b"IEND", b"")
    path.write_bytes(payload)


def write_utf8_stderr(value: str) -> None:
    """Preserve sidecar diagnostics even on a Windows cp1252 CI console."""

    data = value.encode("utf-8", errors="backslashreplace")
    buffer = getattr(sys.stderr, "buffer", None)
    if buffer is not None:
        buffer.write(data)
        if data and not data.endswith(b"\n"):
            buffer.write(b"\n")
        buffer.flush()
        return

    encoding = getattr(sys.stderr, "encoding", None) or "ascii"
    safe_value = value.encode(encoding, errors="backslashreplace").decode(encoding)
    sys.stderr.write(safe_value)
    if safe_value and not safe_value.endswith("\n"):
        sys.stderr.write("\n")
    sys.stderr.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="Start the frozen OCR sidecar and verify its NDJSON protocol.")
    parser.add_argument(
        "--prepare",
        action="store_true",
        help="also load/download the PaddleOCR models and run one local inference",
    )
    args = parser.parse_args()

    suffix = ".exe" if os.name == "nt" else ""
    binary = ROOT / "src-tauri" / "binaries" / f"ocr-sidecar-{target_triple()}{suffix}"
    if not binary.is_file():
        raise FileNotFoundError(f"Sidecar not found: {binary}")

    with tempfile.TemporaryDirectory(prefix="local-ocr-smoke-") as temp_dir:
        requests = [request("smoke-ping", "ping"), request("smoke-runtime", "runtime_check")]
        expected = {"smoke-ping", "smoke-runtime", "smoke-shutdown"}
        if args.prepare:
            image_path = Path(temp_dir) / "inference-smoke.png"
            write_smoke_png(image_path)
            requests.append(request("smoke-prepare", "prepare"))
            requests.append(
                request(
                    "smoke-recognize",
                    "recognize",
                    {"path": str(image_path), "scoreThreshold": 0.5},
                )
            )
            expected.update({"smoke-prepare", "smoke-recognize"})
        requests.append(request("smoke-shutdown", "shutdown"))

        completed = subprocess.run(
            [str(binary)],
            input="\n".join(requests) + "\n",
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=20 * 60,
            check=False,
        )
    if completed.stderr:
        write_utf8_stderr(completed.stderr)
    if completed.returncode != 0:
        raise RuntimeError(f"Sidecar exited with code {completed.returncode}")

    results: dict[str, dict[str, Any]] = {}
    for line in completed.stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        request_id = message.get("id")
        if request_id in expected and message.get("type") in {"result", "error"}:
            results[str(request_id)] = message

    missing = expected.difference(results)
    if missing:
        raise RuntimeError(f"Sidecar did not answer: {', '.join(sorted(missing))}")
    errors = [message for message in results.values() if message.get("type") == "error"]
    if errors:
        raise RuntimeError(f"Sidecar smoke test failed: {errors}")

    print(f"Sidecar smoke test passed: {', '.join(sorted(expected))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
