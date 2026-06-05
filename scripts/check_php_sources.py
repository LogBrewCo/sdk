from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATHS = (ROOT / "php" / "logbrew-php",)
SKIPPED_DIRS = {"vendor", "dist", "build", "coverage"}


def iter_php_files(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_file() and path.suffix == ".php":
            files.append(path)
            continue
        if path.is_dir():
            for child in sorted(path.rglob("*.php")):
                if child.is_file() and SKIPPED_DIRS.isdisjoint(child.parts):
                    files.append(child)
    return sorted(set(files))


def main() -> int:
    parser = argparse.ArgumentParser(description="Check public PHP sources with php -l.")
    parser.add_argument("paths", nargs="*", type=Path, help="Optional files or directories to check.")
    args = parser.parse_args()

    paths = [path if path.is_absolute() else ROOT / path for path in args.paths] if args.paths else list(DEFAULT_PATHS)
    files = iter_php_files(paths)
    if not files:
        print("no PHP sources found")
        return 1

    for path in files:
        completed = subprocess.run(["php", "-l", str(path)], check=False, capture_output=True, text=True)
        if completed.returncode != 0:
            if completed.stdout:
                print(completed.stdout, end="")
            if completed.stderr:
                print(completed.stderr, end="")
            return completed.returncode

    print(f"php source syntax ok ({len(files)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
