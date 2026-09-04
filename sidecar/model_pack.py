"""Portable weights only: no documents, sessions, Python environment or user paths."""
from __future__ import annotations

import hashlib
import json
import os
import queue
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

from engine import model_cache_status, model_names, official_model_cache

PACK_SCHEMA = 1
RUNTIME = {"paddlepaddle": "3.2.2", "paddleocr": "3.7.0", "paddlex": "3.7.2"}
MODEL_FILES = {"inference.json", "inference.pdmodel", "inference.pdiparams", "inference.yml"}
Progress = Callable[[str, int | None, str, int | None], None]


class TransferCancelled(RuntimeError):
    pass


def checkpoint(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise TransferCancelled("已取消模型迁移；未提交的导入已撤销，已下载的模型缓存会保留，原文档不受影响")


def capabilities(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 4:
        raise ValueError("请至少选择一种识别能力")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("模型能力清单无效")
        profile, mode = item.get("profile"), item.get("mode")
        model_names(profile, mode)
        pair = {"profile": profile, "mode": mode}
        if pair not in result:
            result.append(pair)
    return result


def required_names(items: list[dict[str, str]]) -> list[str]:
    return sorted({name for item in items for name in model_names(item["profile"], item["mode"])})


def run_model_worker(item: dict[str, str], root: Path, online: bool, progress: Progress, cancel: threading.Event) -> None:
    """Cold imports run on a fresh process's main thread for every profile."""
    checkpoint(cancel)
    command = [sys.executable]
    if not getattr(sys, "frozen", False):
        command.append(str(Path(__file__).with_name("main.py")))
    command.append("--model-worker")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True")
    options: dict[str, Any] = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding="utf-8", errors="replace", env=env, start_new_session=os.name != "nt", **options)
    lines: queue.Queue[str | None] = queue.Queue()
    def read() -> None:
        try:
            for line in process.stdout:
                lines.put(line)
        finally:
            lines.put(None)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    tail: deque[str] = deque(maxlen=12)
    success = False
    deadline = time.monotonic() + 30 * 60
    try:
        process.stdin.write(json.dumps({**item, "root": str(root), "online": online}) + "\n")
        process.stdin.close()
        while True:
            checkpoint(cancel)
            if time.monotonic() > deadline:
                raise TimeoutError("模型准备或试识别超时。请检查模型下载进度、可用内存，稍后重试。")
            try:
                line = lines.get(timeout=0.25)
            except queue.Empty:
                continue
            if line is None:
                break
            try:
                message = json.loads(line)
            except (ValueError, TypeError):
                tail.append(line.strip()[:1000])
                if os.environ.get("LOCAL_OCR_CI_PREPARE_TRACE") == "1":
                    sys.stderr.write(line)
                    sys.stderr.flush()
                continue
            if not isinstance(message, dict) or message.get("localOcrWorker") != 1:
                continue
            if message.get("type") == "event":
                progress(str(message.get("message") or "正在验证模型……"), None, "model", None)
            elif message.get("type") == "error":
                raise RuntimeError(str(message.get("message") or "本地模型验证失败"))
            elif message.get("type") == "result":
                success = True
        if process.wait(timeout=10) or not success:
            raise RuntimeError("模型验证进程异常退出：" + "\n".join(tail))
    finally:
        if process.poll() is None:
            # A PyInstaller onefile launch has a bootloader AND a Python child.
            # Killing only Popen.pid would leave native inference running.
            if os.name == "nt":
                subprocess.run([str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/taskkill.exe"),
                                "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                               creationflags=subprocess.CREATE_NO_WINDOW, check=False)
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        reader.join(timeout=2)
        process.stdout.close()


def hash_file(path: Path, cancel: threading.Event, destination: Path | None = None,
              progress_bytes: Callable[[int], None] | None = None) -> tuple[int, str]:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"模型文件不是普通文件：{path.name}")
    digest, size = hashlib.sha256(), 0
    output = destination.open("xb") if destination is not None else None
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                checkpoint(cancel)
                digest.update(chunk)
                size += len(chunk)
                if output:
                    output.write(chunk)
                if progress_bytes:
                    progress_bytes(len(chunk))
    finally:
        if output:
            output.close()
    return size, digest.hexdigest()


def check_space(directory: Path, required: int) -> None:
    if shutil.disk_usage(directory).free < required + 64 * 1024 * 1024:
        raise RuntimeError("目标磁盘剩余空间不足，请选择空间充足的本地磁盘或 U 盘")


def pack_manifest(root: Path) -> dict[str, Any]:
    file = root / "model-pack.json"
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 1024 * 1024:
        raise ValueError("所选目录不是离线模型包，请选择包含 model-pack.json 的 LocalOCR-models 文件夹")
    try:
        manifest = json.loads(file.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as error:
        raise ValueError("模型包清单无法读取，请重新完整导出并复制模型包") from error
    if not isinstance(manifest, dict) or manifest.get("schema") != PACK_SCHEMA or manifest.get("runtime") != RUNTIME:
        raise ValueError("模型包格式或模型运行环境版本不兼容，请使用相同版本软件重新导出")
    items = capabilities(manifest.get("capabilities"))
    names = required_names(items)
    files = manifest.get("files")
    if not isinstance(files, list) or not files or len(files) > len(names) * len(MODEL_FILES):
        raise ValueError("模型包文件清单无效")
    seen = set()
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError("模型包文件清单无效")
        relative = entry.get("path", "")
        allowed = {f"{name}/{filename}" for name in names for filename in MODEL_FILES}
        if relative not in allowed or relative in seen or type(entry.get("size")) is not int or entry["size"] < 1:
            raise ValueError("模型包包含非法路径、重复文件或无效文件大小")
        digest = entry.get("sha256", "")
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("模型包校验信息无效")
        seen.add(relative)
        model_dir = root / relative.split("/")[0]
        source = root / relative
        if model_dir.is_symlink() or source.is_symlink() or not source.is_file() or source.stat().st_size != entry["size"]:
            raise ValueError(f"模型包文件缺失或大小不一致：{relative}；请重新完整复制文件夹")
    for name in names:
        if not {f"{name}/inference.yml", f"{name}/inference.pdiparams"} <= seen or not (
                f"{name}/inference.json" in seen or f"{name}/inference.pdmodel" in seen):
            raise ValueError(f"模型包缺少必要文件：{name}")
    return {**manifest, "capabilities": items, "models": names}


def export_pack(directory: str, selected: Any, progress: Progress, cancel: threading.Event,
                worker: Callable = run_model_worker, cache_root: Path | None = None) -> dict[str, Any]:
    if not directory:
        raise ValueError("请选择导出文件夹")
    destination = Path(directory).expanduser().resolve(strict=True)
    if not destination.is_dir():
        raise ValueError("请选择导出文件夹")
    items = capabilities(selected)
    root = (cache_root or official_model_cache()).expanduser().resolve()
    # Never nest a pack inside the source model cache.
    if destination == root or root in destination.parents:
        raise ValueError("请将离线包导出到模型缓存之外的目录")
    for index, item in enumerate(items):
        progress(f"准备并试识别第 {index + 1}/{len(items)} 组模型……", None, "model", None)
        worker(item, root, True, progress, cancel)
    checkpoint(cancel)
    names = required_names(items)
    for item in items:
        if not model_cache_status(item["profile"], item["mode"], root)["installed"]:
            raise RuntimeError("模型文件仍不完整，请重新准备模型后导出")
    sources = [(name, filename) for name in names for filename in sorted(MODEL_FILES) if (root / name / filename).is_file()]
    total = sum((root / name / filename).stat().st_size for name, filename in sources)
    check_space(destination, total)
    target = destination / "LocalOCR-models"
    index = 2
    while target.exists():
        target = destination / f"LocalOCR-models-{index}"
        index += 1
    done = 0
    def copied(size: int) -> None:
        nonlocal done
        done += size
        progress(f"正在导出模型文件：{round(done / total * 100)}%", done, "transfer", total)
    with tempfile.TemporaryDirectory(prefix=".local-ocr-export-", dir=destination) as temporary:
        stage = Path(temporary) / "pack"
        stage.mkdir()
        files = []
        for name, filename in sources:
            (stage / name).mkdir(exist_ok=True)
            size, digest = hash_file(root / name / filename, cancel, stage / name / filename, copied)
            files.append({"path": f"{name}/{filename}", "size": size, "sha256": digest})
        manifest = {"schema": PACK_SCHEMA, "appVersion": "0.9.1", "runtime": RUNTIME, "capabilities": items, "files": files}
        (stage / "model-pack.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        (stage / "使用说明.txt").write_text(
            "本地 OCR 离线模型包\n\n1. 将本文件夹完整复制到离线电脑，同时携带对应系统的软件安装包/AppImage。\n"
            "2. 安装或打开软件，在“模型管理 → 在离线电脑上使用”点击“从本地导入模型”，选择本文件夹。\n"
            "3. 等待完整性校验和本地试识别完成。导入本机后可以拔出 U 盘。\n"
            "4. 保持“仅使用本地模型”开启，选择本包包含的档位/模式后准备模型、识别。\n\n"
            "本包不包含原文档、识别结果或历史记录。只导入自己导出或可信来源的模型包，校验和不是数字签名。\n"
            "Windows 如提示缺少 WebView2，请在联网电脑从微软官网下载 Evergreen Standalone Installer x64，复制后安装；Bootstrapper 需要联网。\n"
            "https://developer.microsoft.com/microsoft-edge/webview2/\n"
            "Linux 请选用适合目标系统的 AppImage；旧系统使用 WebKitGTK 4.0/glibc 2.28 兼容版。模型不能解决系统库不兼容。\n",
            encoding="utf-8")
        checkpoint(cancel)
        stage.rename(target)
    return {"path": str(target), "modelCount": len(names), "sizeBytes": total, "capabilities": items}


def import_pack(directory: str, progress: Progress, cancel: threading.Event,
                worker: Callable = run_model_worker, cache_root: Path | None = None,
                before_commit: Callable[[], None] = lambda: None) -> dict[str, Any]:
    if not directory:
        raise ValueError("请选择离线模型包文件夹")
    source = Path(directory).expanduser().resolve(strict=True)
    manifest = pack_manifest(source)
    root = (cache_root or official_model_cache()).expanduser().resolve()
    if root == source or source in root.parents or root in source.parents:
        raise ValueError("请从模型缓存之外的离线模型包导入")
    root.mkdir(parents=True, exist_ok=True)
    total = sum(item["size"] for item in manifest["files"])
    check_space(root, total)
    done = 0
    def copied(size: int) -> None:
        nonlocal done
        done += size
        progress(f"正在复制并校验模型文件：{round(done / total * 100)}%", done, "transfer", total)
    temporary = Path(tempfile.mkdtemp(prefix=".local-ocr-import-", dir=root))
    stage, backup = temporary / "models", temporary / "backup"
    stage.mkdir()
    backup.mkdir()
    committed: list[str] = []
    backed_up: list[str] = []
    cleanup = True
    try:
        for entry in manifest["files"]:
            output = stage / entry["path"]
            output.parent.mkdir(exist_ok=True)
            size, digest = hash_file(source / entry["path"], cancel, output, copied)
            if size != entry["size"] or digest != entry["sha256"]:
                raise ValueError(f"模型文件校验失败：{entry['path']}；请重新复制模型包，原有模型未改动")
        for item in manifest["capabilities"]:
            worker(item, stage, False, progress, cancel)
        checkpoint(cancel)
        for name in manifest["models"]:
            target = root / name
            if target.is_symlink() or (target.exists() and not target.is_dir()):
                raise ValueError(f"拒绝覆盖异常模型缓存目录：{name}")
        before_commit()
        # Cancel is deliberately not polled during the short commit/rollback.
        progress("本地试识别通过，正在提交模型（此阶段请勿关闭程序）……", None, "commit", None)
        try:
            for name in manifest["models"]:
                target = root / name
                if target.exists():
                    target.rename(backup / name)
                    backed_up.append(name)
                (stage / name).rename(target)
                committed.append(name)
        except BaseException:
            try:
                for name in reversed(committed):
                    (root / name).rename(stage / name)
                for name in reversed(backed_up):
                    (backup / name).rename(root / name)
            except OSError as error:
                cleanup = False
                raise RuntimeError(f"导入提交失败且自动恢复受阻；旧模型保留在 {backup}，请勿删除此目录") from error
            raise
        return {"path": str(root), "modelCount": len(manifest["models"]), "sizeBytes": total, "capabilities": manifest["capabilities"]}
    finally:
        if cleanup:
            shutil.rmtree(temporary)


def model_worker_main() -> int:
    """Entry point shared by source Python and the frozen sidecar executable."""
    from engine import OcrEngine
    from PIL import Image, ImageDraw
    protocol = sys.stdout
    def send(value: dict[str, Any]) -> None:
        protocol.write(json.dumps({"localOcrWorker": 1, **value}, ensure_ascii=False) + "\n")
        protocol.flush()
    def progress(message: str, *_: Any) -> None:
        send({"type": "event", "message": message})
    engine = OcrEngine()
    try:
        params = json.loads(sys.stdin.readline())
        item = capabilities([params])[0]
        root = Path(params["root"])
        engine.initialize_runtime(progress)
        engine.prepare(item["profile"], item["mode"], progress, local_only=not params.get("online"), model_root=root)
        progress("模型已载入，正在使用内置样张进行断网试识别……")
        with tempfile.TemporaryDirectory(prefix="local-ocr-model-check-") as temporary:
            sample = Path(temporary) / "sample.png"
            with Image.new("RGB", (800, 320), "white") as image:
                draw = ImageDraw.Draw(image)
                for x in (30, 400, 770):
                    draw.line((x, 30, x, 290), fill="black", width=3)
                for y in (30, 115, 200, 290):
                    draw.line((30, y, 770, y), fill="black", width=3)
                for x, y, text in ((60, 55, "ITEM"), (430, 55, "VALUE"), (60, 140, "LOCAL OCR"), (430, 140, "12345"), (60, 230, "OFFLINE"), (430, 230, "67890")):
                    with Image.new("RGB", (100, 20), "white") as label:
                        ImageDraw.Draw(label).text((1, 1), text, fill="black")
                        with label.resize((300, 60)) as enlarged:
                            image.paste(enlarged, (x, y))
                image.save(sample)
            result = engine.recognize(str(sample), 0.1, item["mode"], progress)
            if result["pageCount"] != 1 or not result["text"].strip():
                raise RuntimeError("模型虽已载入，但内置样张未识别出文字；请检查运行环境后重试")
            if item["mode"] == "table" and not result["rawTableCount"]:
                raise RuntimeError("表格模型未通过内置表格样张验证，请检查模型和运行环境后重试")
        send({"type": "result", "ok": True})
        return 0
    except Exception as error:
        send({"type": "error", "message": str(error)})
        return 1
    finally:
        engine.unload()
