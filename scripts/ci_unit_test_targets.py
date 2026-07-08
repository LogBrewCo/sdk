#!/usr/bin/env python3
"""Select the narrow Python unittest target set for CI changes."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import NamedTuple


class UnitTestTargets(NamedTuple):
    run_all: bool
    modules: tuple[str, ...]


PATH_TARGETS = {
    ".github/workflows/ci.yml": (
        "tests.test_ci_changed_areas",
        "tests.test_ci_duplicate_static_checks",
        "tests.test_github_release_safety_gates",
        "tests.test_go_workflow_cache_path",
        "tests.test_js_installed_artifact_workflow_gates",
        "tests.test_release_artifact_smoke_gates",
        "tests.test_ci_unit_test_targets",
    ),
    ".github/workflows/release-readiness.yml": (
        "tests.test_ci_duplicate_static_checks",
        "tests.test_github_release_safety_gates",
        "tests.test_js_installed_artifact_workflow_gates",
    ),
    "scripts/ci_changed_areas.py": ("tests.test_ci_changed_areas",),
    "scripts/ci_unit_test_targets.py": ("tests.test_ci_unit_test_targets",),
    "scripts/check_ci_no_duplicate_static_checks.py": (
        "tests.test_ci_duplicate_static_checks",
    ),
    "scripts/real_user_maven_central_public_smoke.sh": (
        "tests.test_maven_central_public_smoke",
    ),
    "scripts/check_github_release_safety.py": ("tests.test_github_release_safety",),
    "scripts/check_backend_contract_reports.py": ("tests.test_backend_contract_reports",),
    "scripts/check_release_metadata.py": ("tests.test_release_metadata",),
    "scripts/validate_fixtures.py": ("tests.test_validate_fixtures",),
    "scripts/check_confidentiality_scan.py": ("tests.test_confidentiality_scan",),
}


def run_git(args: list[str]) -> list[str]:
    result = subprocess.run(
        ["git", *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def changed_paths_from_git() -> list[str]:
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    before = os.environ.get("GITHUB_EVENT_BEFORE", "")
    sha = os.environ.get("GITHUB_SHA", "HEAD")
    base_ref = os.environ.get("GITHUB_BASE_REF", "")

    if event_name == "pull_request" and base_ref:
        return run_git(["diff", "--name-only", f"origin/{base_ref}...HEAD"])
    if before and set(before) != {"0"}:
        return run_git(["diff", "--name-only", f"{before}..{sha}"])
    return run_git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])


def test_module_from_path(path: str) -> str | None:
    normalized = normalize_path(path)
    if not normalized.startswith("tests/test_") or not normalized.endswith(".py"):
        return None
    return normalized.removesuffix(".py").replace("/", ".")


def normalize_path(path: str) -> str:
    normalized = path.strip()
    if normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def select_targets(paths: Iterable[str]) -> UnitTestTargets:
    modules: set[str] = set()
    saw_path = False
    for raw_path in paths:
        path = normalize_path(raw_path)
        if not path:
            continue
        saw_path = True

        test_module = test_module_from_path(path)
        if test_module is not None:
            modules.add(test_module)
            continue

        explicit_targets = PATH_TARGETS.get(path)
        if explicit_targets is not None:
            modules.update(explicit_targets)
            continue

        if path.startswith("tests/") and path.endswith(".py"):
            return UnitTestTargets(run_all=True, modules=())
        if path.startswith("scripts/") and (path.endswith(".py") or path.endswith(".sh")):
            return UnitTestTargets(run_all=True, modules=())
        if path.startswith(".github/workflows/"):
            return UnitTestTargets(run_all=True, modules=())

    if not saw_path:
        return UnitTestTargets(run_all=True, modules=())
    if not modules:
        return UnitTestTargets(run_all=True, modules=())
    return UnitTestTargets(run_all=False, modules=tuple(sorted(modules)))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Select narrow CI unittest targets.")
    parser.add_argument("paths", nargs="*", help="Changed paths. Defaults to git/GitHub env.")
    parser.add_argument(
        "--github-output",
        action="store_true",
        help="Append run_all/modules to $GITHUB_OUTPUT.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    paths = args.paths or changed_paths_from_git()
    targets = select_targets(paths)
    modules = " ".join(targets.modules)
    lines = [
        f"run_all={'true' if targets.run_all else 'false'}",
        f"modules={modules}",
    ]
    if args.github_output:
        output_path = os.environ.get("GITHUB_OUTPUT")
        if not output_path:
            print("GITHUB_OUTPUT is required with --github-output", file=sys.stderr)
            return 2
        Path(output_path).open("a", encoding="utf-8").write("\n".join(lines) + "\n")
    else:
        print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
