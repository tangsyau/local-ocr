from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from collections import deque
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
            grid = (
                (20 <= x <= 300 and y in {12, 42, 72, 84})
                or (12 <= y <= 84 and x in {20, 160, 300})
            )
            text_bars = (
                (35 <= x < 125 and 23 <= y < 29)
                or (180 <= x < 270 and 23 <= y < 29)
                or (35 <= x < 110 and 53 <= y < 59)
                or (180 <= x < 250 and 53 <= y < 59)
            )
            is_ink = grid or text_bars
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


def run_sidecar(
    binary: Path,
    request_lines: list[str],
    request_timeout: int,
    scenario: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Run one isolated model scenario and return its protocol messages.

    Paddle's Windows native predictors are deliberately not switched repeatedly
    inside this release test. Each profile/mode gets a fresh process, matching
    the desktop client's safe model-switch behavior.
    """

    process = subprocess.Popen(
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env={**os.environ, "LOCAL_OCR_CI_PREPARE_TRACE": "1"},
        start_new_session=os.name != "nt",
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    stdout_lines: queue.Queue[str | None] = queue.Queue()
    stderr_tail: deque[str] = deque(maxlen=120)
    stderr_lock = threading.Lock()

    def recent_stderr() -> str:
        with stderr_lock:
            return "\n".join(stderr_tail)[-8000:]

    def pump_stdout() -> None:
        try:
            for line in process.stdout:
                stdout_lines.put(line)
        finally:
            stdout_lines.put(None)

    def pump_stderr() -> None:
        for line in process.stderr:
            with stderr_lock:
                stderr_tail.append(line.rstrip())
            write_utf8_stderr(line)

    stdout_thread = threading.Thread(target=pump_stdout, daemon=True)
    stderr_thread = threading.Thread(target=pump_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    results: dict[str, dict[str, Any]] = {}
    events: dict[str, list[dict[str, Any]]] = {}
    current_request = "startup"

    try:
        for line in request_lines:
            current_request = str(json.loads(line)["id"])
            write_utf8_stderr(f"[smoke:{scenario}] starting {current_request}\n")
            process.stdin.write(line + "\n")
            process.stdin.flush()
            started = time.monotonic()
            deadline = started + request_timeout
            next_heartbeat = started + 30
            last_event = ""
            while current_request not in results:
                now = time.monotonic()
                remaining = deadline - now
                if remaining <= 0:
                    detail = recent_stderr() or "(sidecar produced no stderr)"
                    raise TimeoutError(
                        f"Sidecar timed out after {request_timeout}s while running "
                        f"{current_request} ({scenario}); last event: {last_event or '(none)'}\n"
                        f"Recent sidecar stderr:\n{detail}"
                    )
                if now >= next_heartbeat:
                    write_utf8_stderr(
                        f"[smoke:{scenario}] waiting {round(now-started)}s for {current_request}; "
                        f"last event: {last_event or '(none)'}\n"
                    )
                    next_heartbeat = now + 30
                try:
                    output = stdout_lines.get(timeout=min(remaining, 5.0))
                except queue.Empty:
                    if process.poll() is not None:
                        detail = recent_stderr()
                        raise RuntimeError(
                            f"Sidecar exited with code {process.returncode} before answering "
                            f"{current_request} ({scenario})\n{detail}"
                        )
                    continue
                if output is None:
                    detail = recent_stderr()
                    raise RuntimeError(
                        f"Sidecar exited before answering {current_request} ({scenario})\n{detail}"
                    )
                try:
                    message = json.loads(output)
                except json.JSONDecodeError:
                    continue
                message_id = message.get("id")
                if message_id and message.get("type") == "event":
                    events.setdefault(str(message_id), []).append(message)
                    if str(message_id) == current_request:
                        last_event = str(message.get("message") or message.get("event") or "")
                        if last_event:
                            write_utf8_stderr(f"[smoke:{scenario}] {current_request}: {last_event}\n")
                if message_id and message.get("type") in {"result", "error"}:
                    results[str(message_id)] = message
            if results[current_request].get("type") == "error":
                raise RuntimeError(
                    f"Sidecar smoke test failed in {scenario}/{current_request}: "
                    f"{results[current_request]}"
                )
            write_utf8_stderr(f"[smoke:{scenario}] finished {current_request}\n")

        process.stdin.close()
        return_code = process.wait(timeout=60)
        if return_code != 0:
            raise RuntimeError(f"Sidecar exited with code {return_code} after {scenario}")
        return results, events
    finally:
        if process.poll() is None:
            stop_sidecar_tree(process)
        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)
        if not stdout_thread.is_alive():
            process.stdout.close()
        if not stderr_thread.is_alive():
            process.stderr.close()
        try:
            process.stdin.close()
        except OSError:
            pass


def stop_sidecar_tree(process: subprocess.Popen) -> None:
    """Stop only this test's process tree, including the PyInstaller child."""
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if process.poll() is None:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Start the frozen OCR sidecar and verify its NDJSON protocol.")
    parser.add_argument(
        "--prepare",
        action="store_true",
        help="also load/download the PaddleOCR models and run one local inference",
    )
    parser.add_argument(
        "--all-profiles",
        action="store_true",
        help="with --prepare, verify both fast and accurate model profiles",
    )
    parser.add_argument(
        "--table",
        action="store_true",
        help="also load the lightweight table pipeline and run one local inference",
    )
    parser.add_argument(
        "--request-timeout",
        type=int,
        default=15 * 60,
        help="maximum seconds for each protocol request (default: 900)",
    )
    args = parser.parse_args()
    if args.request_timeout < 30:
        parser.error("--request-timeout must be at least 30 seconds")

    suffix = ".exe" if os.name == "nt" else ""
    binary = ROOT / "src-tauri" / "binaries" / f"ocr-sidecar-{target_triple()}{suffix}"
    if not binary.is_file():
        raise FileNotFoundError(f"Sidecar not found: {binary}")

    with tempfile.TemporaryDirectory(prefix="local-ocr-smoke-") as temp_dir:
        base_requests = [
            request("smoke-ping", "ping"),
            request("smoke-runtime", "runtime_check"),
            request("smoke-model-status", "model_status", {"profile": "fast", "mode": "text"}),
            request("smoke-diagnostics", "diagnostics"),
        ]
        scenarios: list[tuple[str, list[str]]] = []
        if args.prepare:
            image_path = Path(temp_dir) / "inference-smoke.png"
            write_smoke_png(image_path)
            profiles = ("fast", "accurate") if args.all_profiles else ("fast",)
            for index, profile in enumerate(profiles):
                model_requests = list(base_requests if index == 0 else [request(f"smoke-ping-{profile}", "ping")])
                model_requests.append(
                    request(
                        f"smoke-prepare-{profile}",
                        "prepare",
                        {"profile": profile, "mode": "text"},
                    )
                )
                model_requests.append(
                    request(
                        f"smoke-recognize-{profile}",
                        "recognize",
                        {"path": str(image_path), "scoreThreshold": 0.5, "mode": "text"},
                    )
                )
                model_requests.append(request(f"smoke-shutdown-{profile}", "shutdown"))
                scenarios.append((f"text-{profile}", model_requests))
            if args.table:
                scenarios.append(("table-fast", [
                    request("smoke-ping-table", "ping"),
                    request(
                        "smoke-prepare-table",
                        "prepare",
                        {"profile": "fast", "mode": "table"},
                    ),
                    request(
                        "smoke-recognize-table",
                        "recognize",
                        {"path": str(image_path), "scoreThreshold": 0.5, "mode": "table"},
                    ),
                    request("smoke-shutdown-table", "shutdown"),
                ]))
        else:
            scenarios.append(("protocol", [*base_requests, request("smoke-shutdown", "shutdown")]))

        results: dict[str, dict[str, Any]] = {}
        events: dict[str, list[dict[str, Any]]] = {}
        for scenario, lines in scenarios:
            scenario_results, scenario_events = run_sidecar(binary, lines, args.request_timeout, scenario)
            results.update(scenario_results)
            events.update(scenario_events)

        if args.prepare:
            recognition_ids = [f"smoke-recognize-{profile}" for profile in profiles]
            if args.table:
                recognition_ids.append("smoke-recognize-table")
            for request_id in recognition_ids:
                progress_events = [
                    event for event in events.get(request_id, []) if event.get("event") == "progress"
                ]
                if not progress_events:
                    raise RuntimeError(f"Sidecar did not emit OCR progress events: {request_id}")
                final_progress = progress_events[-1]
                if final_progress.get("page") != 1 or final_progress.get("pageCount") != 1:
                    raise RuntimeError(f"Invalid OCR progress event: {final_progress}")
                page_events = [event for event in events.get(request_id, []) if event.get("event") == "page_result"]
                if len(page_events) != 1 or "tables" not in page_events[0].get("pageResult", {}):
                    raise RuntimeError(f"Missing per-page recovery data: {request_id}")
            if args.table:
                table_result = results["smoke-recognize-table"].get("result") or {}
                if table_result.get("resultType") != "table" or "tableCount" not in table_result:
                    raise RuntimeError(f"Invalid table recognition result: {table_result}")

        model_status = results["smoke-model-status"].get("result") or {}
        if model_status.get("modelCount") != 2 or "cacheRoot" not in model_status:
            raise RuntimeError(f"Invalid model cache status: {model_status}")
        diagnostics = results["smoke-diagnostics"].get("result") or {}
        if not diagnostics.get("python") or "packages" not in diagnostics:
            raise RuntimeError(f"Invalid diagnostics result: {diagnostics}")
        if {"executable", "cacheRoot", "text", "stderr"} & set(diagnostics):
            raise RuntimeError("Diagnostics contains private fields")

    print(f"Sidecar smoke test passed: {', '.join(sorted(results))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
