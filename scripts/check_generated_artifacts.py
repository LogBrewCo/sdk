#!/usr/bin/env python3
"""Detect generated build artifacts that should not remain after verifier runs."""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]

EXACT_PATHS = (
    "Cargo.lock",
    "php/logbrew-php/composer.lock",
    "php/logbrew-php/vendor",
    "js/logbrew-js/examples/node_modules",
    "js/logbrew-js/examples/pnpm-lock.yaml",
    "target",
    ".mypy_cache",
    ".ruff_cache",
    "java/logbrew-java/build",
    "python/logbrew_py/build",
    "python/logbrew_py/dist",
    "python/logbrew_py/src/logbrew_sdk.egg-info",
    "python/logbrew_fastapi/build",
    "python/logbrew_fastapi/dist",
    "python/logbrew_fastapi/src/logbrew_fastapi.egg-info",
    "python/logbrew_flask/build",
    "python/logbrew_flask/dist",
    "python/logbrew_flask/src/logbrew_flask.egg-info",
    "python/logbrew_django/build",
    "python/logbrew_django/dist",
    "python/logbrew_django/src/logbrew_django.egg-info",
    "swift/logbrew-swift/.build",
    "kotlin/logbrew-kotlin/build",
    "kotlin/logbrew-kotlin/.gradle",
    "kotlin/logbrew-kotlin-okhttp/build",
    "kotlin/logbrew-kotlin-okhttp/.gradle",
    "c/logbrew-c/build",
    "c/logbrew-c/examples/build",
    "cpp/logbrew-cpp/build",
    "cpp/logbrew-cpp/examples/build",
    "objc/logbrew-objc/build",
    "objc/logbrew-objc/examples/build",
)

GLOB_PATTERNS = (
    "__pycache__",
    "*.pyc",
    "dotnet/logbrew-dotnet/**/bin",
    "dotnet/logbrew-dotnet/**/obj",
    "dotnet/logbrew-dotnet/**/*.nupkg",
    "unity/logbrew-unity/**/bin",
    "unity/logbrew-unity/**/obj",
    "unity/logbrew-unity/**/*.tgz",
    "kotlin/logbrew-kotlin/**/*.jar",
    "kotlin/logbrew-kotlin-okhttp/**/*.jar",
    "c/logbrew-c/**/*.o",
    "c/logbrew-c/**/*.a",
    "cpp/logbrew-cpp/**/*.o",
    "cpp/logbrew-cpp/**/*.a",
    "objc/logbrew-objc/**/*.o",
    "objc/logbrew-objc/**/*.a",
)


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def validate(root: Path = REPO_ROOT) -> list[str]:
    failures: list[str] = []

    for item in EXACT_PATHS:
        path = root / item
        if path.exists():
            failures.append(f"generated artifact remains: {item}")

    for pattern in GLOB_PATTERNS:
        for path in root.rglob(pattern) if "/" not in pattern else root.glob(pattern):
            if ".git" in path.parts:
                continue
            failures.append(f"generated artifact remains: {relative(path, root)}")

    return sorted(set(failures))


def main() -> int:
    failures = validate()
    if failures:
        print("generated artifact hygiene failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        print("remove disposable build/package output before committing or reporting a clean cycle", file=sys.stderr)
        return 1
    print("generated artifact hygiene ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
