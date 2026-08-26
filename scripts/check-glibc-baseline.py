from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
from pathlib import Path


GLIBC_VERSION = re.compile(r"GLIBC_(\d+)\.(\d+)")


def parse_version(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)", value)
    if match is None:
        raise argparse.ArgumentTypeError("expected a version such as 2.28")
    return int(match.group(1)), int(match.group(2))


def is_elf(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        with path.open("rb") as stream:
            return stream.read(4) == b"\x7fELF"
    except OSError:
        return False


def required_glibc_versions(path: Path) -> set[tuple[int, int]]:
    completed = subprocess.run(
        ["readelf", "--version-info", str(path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return {
        (int(major), int(minor))
        for major, minor in GLIBC_VERSION.findall(completed.stdout)
    }


def scan_elf_files(paths: list[Path]) -> dict[Path, tuple[int, int]]:
    requirements: dict[Path, tuple[int, int]] = {}
    for path in paths:
        if not is_elf(path):
            continue
        versions = required_glibc_versions(path)
        if versions:
            requirements[path] = max(versions)
    return requirements


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail when an AppImage contains ELF files newer than a GLIBC baseline."
    )
    parser.add_argument("appimage", type=Path)
    parser.add_argument("--max", dest="maximum", type=parse_version, required=True)
    parser.add_argument(
        "--require-executable",
        action="append",
        default=[],
        help="Require an executable with this basename inside the AppImage.",
    )
    args = parser.parse_args()

    appimage = args.appimage.resolve()
    if not appimage.is_file():
        parser.error(f"AppImage not found: {appimage}")

    with tempfile.TemporaryDirectory(prefix="local-ocr-appimage-") as temp_dir:
        extraction_dir = Path(temp_dir)
        subprocess.run(
            [str(appimage), "--appimage-extract"],
            cwd=extraction_dir,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        appdir = extraction_dir / "squashfs-root"
        for executable_name in args.require_executable:
            matches = [
                path
                for path in appdir.rglob(executable_name)
                if path.is_file() and path.stat().st_mode & 0o111
            ]
            if not matches:
                raise RuntimeError(
                    f"Required executable is missing from AppImage: {executable_name}"
                )
            print(
                f"Found bundled executable {executable_name}: "
                f"{matches[0].relative_to(appdir)}"
            )
        candidates = [appimage, *(path for path in appdir.rglob("*") if path.is_file())]
        requirements = scan_elf_files(candidates)

    if not requirements:
        raise RuntimeError("No GLIBC requirements were found in the AppImage")

    highest = max(requirements.values())
    print(
        f"Scanned {len(requirements)} ELF files; highest required GLIBC is "
        f"{highest[0]}.{highest[1]} (allowed <= {args.maximum[0]}.{args.maximum[1]})."
    )

    violations = sorted(
        (
            (version, path)
            for path, version in requirements.items()
            if version > args.maximum
        ),
        reverse=True,
    )
    if not violations:
        return 0

    print("Files exceeding the configured baseline:")
    for version, path in violations[:30]:
        print(f"  GLIBC_{version[0]}.{version[1]}  {path}")
    if len(violations) > 30:
        print(f"  ... and {len(violations) - 30} more")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
