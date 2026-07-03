#!/usr/bin/env python3
"""Print the Rust crate version from Cargo.toml."""

from __future__ import annotations

import argparse
import tomllib
from pathlib import Path


def read_version(manifest_path: Path) -> str:
    package = tomllib.loads(manifest_path.read_text(encoding="utf-8")).get("package", {})
    version = package.get("version")
    if not isinstance(version, str) or not version:
        raise SystemExit(f"{manifest_path}: missing package.version")
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description="Print the Rust logbrew crate version.")
    parser.add_argument(
        "manifest",
        nargs="?",
        default=Path(__file__).resolve().parents[1] / "rust" / "logbrew" / "Cargo.toml",
        type=Path,
    )
    args = parser.parse_args()
    print(read_version(args.manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
