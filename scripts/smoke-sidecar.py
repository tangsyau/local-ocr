from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from platform_target import target_triple


ROOT = Path(__file__).resolve().parents[1]


def request(request_id: str, method: str) -> str:
    return json.dumps({"id": request_id, "method": method, "params": {}}, ensure_ascii=False)


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
        help="also load/download the PaddleOCR models to verify the frozen runtime",
    )
    args = parser.parse_args()

    suffix = ".exe" if os.name == "nt" else ""
    binary = ROOT / "src-tauri" / "binaries" / f"ocr-sidecar-{target_triple()}{suffix}"
    if not binary.is_file():
        raise FileNotFoundError(f"Sidecar not found: {binary}")

    requests = [request("smoke-ping", "ping"), request("smoke-runtime", "runtime_check")]
    expected = {"smoke-ping", "smoke-runtime", "smoke-shutdown"}
    if args.prepare:
        requests.append(request("smoke-prepare", "prepare"))
        expected.add("smoke-prepare")
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
