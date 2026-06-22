#!/usr/bin/env python3
"""Block CI workflows from duplicating local-only lint/static gates."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


WORKFLOW_DIR = Path(".github/workflows")
DISALLOWED_COMMAND_RE = re.compile(
    r"\b("
    r"scripts/check_(?:js_lint|shell_static|python_static|go_static|java_static|php_static|swift_style|kotlin_style)\.sh"
    r"|npm\s+run\s+lint"
    r"|pnpm\s+(?:run\s+)?lint"
    r"|yarn\s+lint"
    r"|eslint\b"
    r"|ruff\s+check\b"
    r"|mypy\b"
    r"|shellcheck\b"
    r"|staticcheck\b"
    r"|go\s+vet\b"
    r"|gofmt\b"
    r"|cargo\s+fmt\b"
    r"|cargo\s+clippy\b"
    r"|swiftformat\b"
    r"|swiftlint\b"
    r"|ktlint\b"
    r"|rubocop\b"
    r"|phpstan\b"
    r")",
    re.IGNORECASE,
)


def workflow_files(root: Path) -> list[Path]:
    workflows = root / WORKFLOW_DIR
    if not workflows.exists():
        return []
    return sorted([*workflows.glob("*.yml"), *workflows.glob("*.yaml")])


def validate(root: Path) -> list[str]:
    failures: list[str] = []
    for workflow in workflow_files(root):
        relative = workflow.relative_to(root)
        for line_number, line in enumerate(workflow.read_text(encoding="utf-8").splitlines(), start=1):
            match = DISALLOWED_COMMAND_RE.search(line)
            if match is None:
                continue
            failures.append(
                f"{relative}:{line_number}: move local-only lint/static gate out of CI/Blacksmith: "
                f"{match.group(0)}"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check that GitHub Actions/Blacksmith workflows do not rerun local-only lint/static gates."
    )
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args()

    failures = validate(args.root.resolve())
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print("ci duplicate static checks ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
