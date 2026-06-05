from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATHS = (
    ROOT / "scripts",
    ROOT / "tests",
    ROOT / "python" / "logbrew_py" / "src",
    ROOT / "python" / "logbrew_py" / "tests",
    ROOT / "python" / "logbrew_py" / "examples",
    ROOT / "python" / "logbrew_fastapi" / "src",
    ROOT / "python" / "logbrew_fastapi" / "tests",
    ROOT / "python" / "logbrew_fastapi" / "examples",
    ROOT / "python" / "logbrew_django" / "src",
    ROOT / "python" / "logbrew_django" / "tests",
    ROOT / "python" / "logbrew_django" / "examples",
)


def iter_python_files(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_file() and path.suffix == ".py":
            files.append(path)
            continue
        if path.is_dir():
            files.extend(sorted(path.rglob("*.py")))
    return sorted(set(files))


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile public Python sources without writing bytecode caches.")
    parser.add_argument("paths", nargs="*", type=Path, help="Optional files or directories to check.")
    args = parser.parse_args()

    paths = [path if path.is_absolute() else ROOT / path for path in args.paths] if args.paths else list(DEFAULT_PATHS)
    files = iter_python_files(paths)
    if not files:
        print("no Python sources found")
        return 1

    for path in files:
        source = path.read_text(encoding="utf-8")
        compile(source, str(path.relative_to(ROOT)), "exec")

    print(f"python source syntax ok ({len(files)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
