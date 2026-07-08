#!/usr/bin/env python3
"""Classify changed paths into SDK CI areas.

The CI workflow keeps the required "Contract checks" context, but expensive
language smokes should only run when their owned files or smoke scripts changed.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections.abc import Iterable


AREA_NAMES = (
    "release_artifacts",
    "rust",
    "javascript",
    "python",
    "go",
    "c",
    "cpp",
    "java",
    "dotnet",
    "unity",
    "ruby",
    "php",
    "swift",
    "objc",
    "kotlin",
    "maven",
)


SCRIPT_AREA_PREFIXES = {
    "real_user_js_": {"javascript"},
    "real_user_browser_": {"javascript"},
    "real_user_node_": {"javascript"},
    "real_user_prisma_": {"javascript"},
    "real_user_bullmq_": {"javascript"},
    "real_user_kafkajs_": {"javascript"},
    "real_user_amqplib_": {"javascript"},
    "real_user_aws_sqs_": {"javascript"},
    "real_user_express_": {"javascript"},
    "real_user_fastify_": {"javascript"},
    "real_user_nestjs_": {"javascript"},
    "real_user_angular_": {"javascript"},
    "real_user_vue_": {"javascript"},
    "real_user_svelte_": {"javascript"},
    "real_user_react_": {"javascript"},
    "check_js_": {"javascript"},
    "real_user_rust_": {"rust"},
    "check_rust_": {"rust"},
    "real_user_python_": {"python"},
    "check_python_": {"python"},
    "check_fastapi_": {"python"},
    "check_flask_": {"python"},
    "check_django_": {"python"},
    "real_user_fastapi_": {"python"},
    "real_user_flask_": {"python"},
    "real_user_django_": {"python"},
    "real_user_go_": {"go"},
    "check_go_": {"go"},
    "real_user_c_": {"c"},
    "check_c_": {"c"},
    "real_user_cpp_": {"cpp"},
    "check_cpp_": {"cpp"},
    "real_user_java_": {"java"},
    "check_java_": {"java"},
    "real_user_spring_": {"java"},
    "real_user_dotnet_": {"dotnet"},
    "check_dotnet_": {"dotnet"},
    "real_user_unity_": {"unity"},
    "check_unity_": {"unity"},
    "real_user_ruby_": {"ruby"},
    "check_ruby_": {"ruby"},
    "real_user_php_": {"php"},
    "check_php_": {"php"},
    "real_user_swift_": {"swift"},
    "check_swift_": {"swift"},
    "real_user_objc_": {"objc"},
    "check_objc_": {"objc"},
    "real_user_kotlin_": {"kotlin"},
    "check_kotlin_": {"kotlin"},
    "real_user_maven_": {"maven"},
    "build_maven_": {"maven"},
    "check_maven_": {"maven"},
}


RELEASE_ARTIFACT_SCRIPT_NAMES = {
    "real_user_js_release_artifact_smoke.sh",
    "real_user_js_release_artifact_cli_smoke.sh",
    "real_user_vite_release_artifact_smoke.sh",
    "real_user_next_release_artifact_smoke.sh",
    "real_user_react_native_release_artifact_smoke.sh",
    "real_user_react_native_native_release_artifact_smoke.sh",
    "real_user_js_release_artifact_upload_smoke.sh",
    "real_user_native_release_artifact_smoke.sh",
    "real_user_native_release_artifact_upload_smoke.sh",
    "create_js_release_artifact_manifest.py",
    "create_native_release_artifact_manifest.py",
    "prepare_js_release_artifact_debug_ids.py",
    "upload_js_release_artifacts.py",
    "upload_native_release_artifacts.py",
    "verify_js_release_artifact_symbolication.py",
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


def add_script_areas(path: str, areas: set[str]) -> None:
    if not path.startswith("scripts/"):
        return
    name = path.removeprefix("scripts/")
    if name in RELEASE_ARTIFACT_SCRIPT_NAMES or "release_artifact" in name:
        areas.add("release_artifacts")
    for prefix, owned_areas in SCRIPT_AREA_PREFIXES.items():
        if name.startswith(prefix):
            areas.update(owned_areas)


def classify(paths: Iterable[str]) -> dict[str, bool]:
    areas = {name: False for name in AREA_NAMES}
    enabled: set[str] = set()
    for raw_path in paths:
        path = raw_path.strip().lstrip("./")
        if not path:
            continue
        add_script_areas(path, enabled)
        if path.startswith("rust/") or path in {"Cargo.toml", "Cargo.lock"}:
            enabled.add("rust")
        if path.startswith("js/"):
            enabled.add("javascript")
            if "release-artifact" in path or "release_artifact" in path:
                enabled.add("release_artifacts")
        if path.startswith("python/"):
            enabled.add("python")
        if path.startswith("go/"):
            enabled.add("go")
        if path.startswith("c/"):
            enabled.add("c")
        if path.startswith("cpp/"):
            enabled.add("cpp")
        if path.startswith("java/"):
            enabled.add("java")
        if path.startswith("dotnet/"):
            enabled.add("dotnet")
        if path.startswith("unity/"):
            enabled.add("unity")
        if path.startswith("ruby/"):
            enabled.add("ruby")
        if path.startswith("php/"):
            enabled.add("php")
        if path.startswith("swift/") or path == "Package.swift":
            enabled.add("swift")
        if path.startswith("objc/"):
            enabled.add("objc")
        if path.startswith("kotlin/"):
            enabled.add("kotlin")
        if path == ".github/workflows/publish-packages.yml":
            enabled.add("maven")
    for name in enabled:
        areas[name] = True
    return areas


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Classify changed SDK CI areas.")
    parser.add_argument("paths", nargs="*", help="Changed paths. Defaults to git/GitHub env.")
    parser.add_argument(
        "--github-output",
        action="store_true",
        help="Append area booleans to $GITHUB_OUTPUT.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    paths = args.paths or changed_paths_from_git()
    areas = classify(paths)
    lines = [f"{name}={'true' if areas[name] else 'false'}" for name in AREA_NAMES]
    if args.github_output:
        output_path = os.environ.get("GITHUB_OUTPUT")
        if not output_path:
            print("GITHUB_OUTPUT is required with --github-output", file=sys.stderr)
            return 2
        with open(output_path, "a", encoding="utf-8") as output:
            output.write("\n".join(lines) + "\n")
    else:
        print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
