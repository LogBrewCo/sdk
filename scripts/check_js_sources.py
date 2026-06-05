from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATHS = (ROOT / "js",)
SOURCE_EXTENSIONS = {".cjs", ".js", ".mjs"}
SKIPPED_DIRS = {"node_modules", "dist", "build", "coverage"}


def iter_js_files(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_file() and path.suffix in SOURCE_EXTENSIONS:
            files.append(path)
            continue
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix in SOURCE_EXTENSIONS and SKIPPED_DIRS.isdisjoint(child.parts):
                    files.append(child)
    return sorted(set(files))


def main() -> int:
    parser = argparse.ArgumentParser(description="Check public JavaScript sources with Node's syntax checker.")
    parser.add_argument("paths", nargs="*", type=Path, help="Optional files or directories to check.")
    args = parser.parse_args()

    paths = [path if path.is_absolute() else ROOT / path for path in args.paths] if args.paths else list(DEFAULT_PATHS)
    files = iter_js_files(paths)
    if not files:
        print("no JavaScript sources found")
        return 1

    for path in files:
        completed = subprocess.run(["node", "--check", str(path)], check=False, capture_output=True, text=True)
        if completed.returncode != 0:
            if completed.stdout:
                print(completed.stdout, end="")
            if completed.stderr:
                print(completed.stderr, end="")
            return completed.returncode

    print(f"javascript source syntax ok ({len(files)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
