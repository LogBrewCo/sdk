#!/usr/bin/env python3
"""Run independent repository contract-test modules concurrently."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
TEST_PATTERN = "test_*.py"


def run_module(path: Path) -> tuple[Path, subprocess.CompletedProcess[str], int]:
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run(
        [sys.executable, "-m", "unittest", str(path.relative_to(ROOT))],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    match = re.search(r"Ran (\d+) tests?", result.stderr)
    return path, result, int(match.group(1)) if match else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--jobs",
        type=int,
        default=min(8, os.cpu_count() or 1),
        help="Maximum test modules to run at once.",
    )
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")

    paths = sorted((ROOT / "tests").glob(TEST_PATTERN))
    with ThreadPoolExecutor(max_workers=min(args.jobs, len(paths))) as executor:
        results = list(executor.map(run_module, paths))

    failures = [(path, result) for path, result, _ in results if result.returncode]
    for path, result in failures:
        print(f"--- {path.relative_to(ROOT)} ---", file=sys.stderr)
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
    if failures:
        print(f"{len(failures)} contract-test modules failed", file=sys.stderr)
        return 1

    print(f"python contract tests ok ({sum(count for _, _, count in results)} tests in {len(paths)} modules)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
