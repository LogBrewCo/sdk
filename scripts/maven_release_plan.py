#!/usr/bin/env python3
"""Create and validate deterministic Maven release selections and manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, NoReturn, Sequence


GROUP_ID = "co.logbrew"
SCHEMA_VERSION = 1
SOURCE_COMMIT = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?")
CATALOG = (
    ("logbrew-sdk", "java/logbrew-java", ()),
    ("logbrew-kotlin", "kotlin/logbrew-kotlin", ()),
    (
        "logbrew-kotlin-okhttp",
        "kotlin/logbrew-kotlin-okhttp",
        ("logbrew-kotlin",),
    ),
)
CATALOG_BY_ID = {artifact_id: (package_dir, dependencies) for artifact_id, package_dir, dependencies in CATALOG}
DEFAULT_ARTIFACTS = tuple(artifact_id for artifact_id, _, _ in CATALOG)


def _fail(message: str) -> NoReturn:
    raise ValueError(message)


def _required_text(element: ET.Element, name: str, *, context: str) -> str:
    value = element.findtext(f"{{*}}{name}")
    if value is None or not value.strip():
        _fail(f"missing {name} in {context}")
    return value.strip()


def _read_pom(root: Path, artifact_id: str) -> dict[str, Any]:
    package_dir, expected_dependencies = CATALOG_BY_ID[artifact_id]
    pom_path = root / package_dir / "pom.xml"
    try:
        project = ET.fromstring(pom_path.read_text(encoding="utf-8"))
    except (OSError, ET.ParseError) as error:
        _fail(f"invalid Maven metadata for {artifact_id}: {error.__class__.__name__}")

    group_id = _required_text(project, "groupId", context=artifact_id)
    actual_artifact_id = _required_text(project, "artifactId", context=artifact_id)
    version = _required_text(project, "version", context=artifact_id)
    if group_id != GROUP_ID or actual_artifact_id != artifact_id:
        _fail(f"unexpected Maven coordinate in {package_dir}/pom.xml")
    if VERSION.fullmatch(version) is None:
        _fail(f"invalid Maven version for {artifact_id}")

    dependencies: dict[str, str] = {}
    for dependency in project.findall("./{*}dependencies/{*}dependency"):
        dependency_group = _required_text(dependency, "groupId", context=artifact_id)
        if dependency_group != GROUP_ID:
            continue
        dependency_artifact = _required_text(dependency, "artifactId", context=artifact_id)
        dependency_version = _required_text(dependency, "version", context=artifact_id)
        if dependency_artifact not in CATALOG_BY_ID:
            _fail(f"unsupported internal Maven dependency in {artifact_id}")
        if dependency_artifact in dependencies:
            _fail(f"duplicate internal Maven dependency in {artifact_id}")
        if VERSION.fullmatch(dependency_version) is None:
            _fail(f"invalid internal Maven dependency version in {artifact_id}")
        dependencies[dependency_artifact] = dependency_version

    if tuple(dependencies) != expected_dependencies:
        _fail(f"unexpected internal Maven dependency closure in {artifact_id}")

    return {
        "artifactId": artifact_id,
        "coordinate": f"{GROUP_ID}:{artifact_id}",
        "packageDir": package_dir,
        "version": version,
        "dependencies": dependencies,
    }


def create_plan(root: Path, selected_artifacts: Sequence[str]) -> dict[str, Any]:
    """Return an exact deterministic plan for the selected Maven coordinates."""
    if not selected_artifacts:
        _fail("select at least one Maven artifact")
    if len(set(selected_artifacts)) != len(selected_artifacts):
        _fail("duplicate Maven artifact selection")
    unsupported = [artifact for artifact in selected_artifacts if artifact not in CATALOG_BY_ID]
    if unsupported:
        _fail("unsupported Maven artifact selection")

    selected_set = set(selected_artifacts)
    metadata: dict[str, dict[str, Any]] = {}

    def metadata_for(artifact_id: str) -> dict[str, Any]:
        if artifact_id not in metadata:
            metadata[artifact_id] = _read_pom(root, artifact_id)
        return metadata[artifact_id]

    selected = []
    external_dependencies: dict[str, dict[str, str]] = {}
    for artifact_id, _, _ in CATALOG:
        if artifact_id not in selected_set:
            continue
        artifact = metadata_for(artifact_id)
        for dependency_id, dependency_version in artifact["dependencies"].items():
            dependency = metadata_for(dependency_id)
            if dependency["version"] != dependency_version:
                _fail(f"dependency version mismatch for {artifact_id}")
            if dependency_id not in selected_set:
                external_dependencies[dependency_id] = {
                    "artifactId": dependency_id,
                    "coordinate": dependency["coordinate"],
                    "version": dependency_version,
                }
        selected.append(
            {
                key: artifact[key]
                for key in ("artifactId", "coordinate", "packageDir", "version")
            }
        )

    ordered_external = [
        external_dependencies[artifact_id]
        for artifact_id, _, _ in CATALOG
        if artifact_id in external_dependencies
    ]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "selected": selected,
        "externalDependencies": ordered_external,
    }


def parse_artifact_selection(raw_selection: str) -> list[str]:
    """Parse one bounded comma-separated dispatch selection without reflecting input."""
    if raw_selection == "":
        return list(DEFAULT_ARTIFACTS)
    if "\r" in raw_selection or "\n" in raw_selection:
        _fail("invalid Maven artifact selection")
    selected = [artifact.strip() for artifact in raw_selection.split(",")]
    if any(not artifact for artifact in selected):
        _fail("invalid Maven artifact selection")
    return selected


def canonicalize_artifact_selection(root: Path, raw_selection: str) -> str:
    """Return selected artifact IDs in deterministic catalog order."""
    plan = create_plan(root, parse_artifact_selection(raw_selection))
    return ",".join(entry["artifactId"] for entry in plan["selected"])


def write_json(value: dict[str, Any], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            json.dump(value, temporary, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, output)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def write_plan(plan: dict[str, Any], output: Path) -> None:
    """Write a release plan atomically."""
    write_json(plan, output)


def load_plan(plan_path: Path) -> dict[str, Any]:
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        _fail(f"invalid Maven release plan: {error.__class__.__name__}")
    if not isinstance(plan, dict):
        _fail("invalid Maven release plan")
    return plan


def validate_plan(root: Path, plan_path: Path) -> dict[str, Any]:
    """Fail closed unless a saved plan exactly matches current Maven metadata."""
    plan = load_plan(plan_path)
    selected = plan.get("selected")
    if not isinstance(selected, list):
        _fail("invalid Maven release plan")
    artifact_ids = []
    for entry in selected:
        if not isinstance(entry, dict) or not isinstance(entry.get("artifactId"), str):
            _fail("invalid Maven release plan")
        artifact_ids.append(entry["artifactId"])
    expected = create_plan(root, artifact_ids)
    if plan != expected:
        _fail("saved release plan does not match current Maven metadata")
    return plan


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_manifest(
    plan: dict[str, Any],
    stage: Path,
    bundle: Path,
    source_commit: str,
) -> dict[str, Any]:
    """Bind a bundle and every selected staged file to an exact source commit."""
    if SOURCE_COMMIT.fullmatch(source_commit) is None:
        _fail("source commit must be 40 lowercase hexadecimal characters")
    if not bundle.is_file():
        _fail("Maven release bundle is missing")

    artifacts = []
    for entry in plan.get("selected", []):
        artifact_id = entry["artifactId"]
        version = entry["version"]
        artifact_root = stage / "co" / "logbrew" / artifact_id / version
        files = [path for path in sorted(artifact_root.rglob("*")) if path.is_file()]
        if not files:
            _fail(f"selected Maven artifact files are missing for {artifact_id}")
        artifacts.append(
            {
                **entry,
                "files": [
                    {
                        "path": path.relative_to(stage).as_posix(),
                        "sha256": _sha256(path),
                    }
                    for path in files
                ],
            }
        )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceCommit": source_commit,
        "bundle": {"sha256": _sha256(bundle)},
        "artifacts": artifacts,
        "externalDependencies": plan.get("externalDependencies", []),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("--root", type=Path, required=True)
    selection = create.add_mutually_exclusive_group(required=True)
    selection.add_argument("--artifact", action="append")
    selection.add_argument("--artifacts")
    selection.add_argument("--artifacts-env")
    create.add_argument("--output", type=Path, required=True)

    canonicalize = subparsers.add_parser("canonicalize")
    canonicalize.add_argument("--root", type=Path, required=True)
    canonical_selection = canonicalize.add_mutually_exclusive_group(required=True)
    canonical_selection.add_argument("--artifacts")
    canonical_selection.add_argument("--artifacts-env")

    validate = subparsers.add_parser("validate")
    validate.add_argument("--root", type=Path, required=True)
    validate.add_argument("--plan", type=Path, required=True)

    manifest = subparsers.add_parser("manifest")
    manifest.add_argument("--plan", type=Path, required=True)
    manifest.add_argument("--stage", type=Path, required=True)
    manifest.add_argument("--bundle", type=Path, required=True)
    manifest.add_argument("--source-commit", required=True)
    manifest.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "create":
            selected = args.artifact or []
            if args.artifacts is not None:
                selected = parse_artifact_selection(args.artifacts)
            elif args.artifacts_env is not None:
                selected = parse_artifact_selection(
                    os.environ.get(args.artifacts_env, "")
                )
            write_plan(create_plan(args.root, selected), args.output)
        elif args.command == "canonicalize":
            raw_selection = args.artifacts
            if args.artifacts_env is not None:
                raw_selection = os.environ.get(args.artifacts_env, "")
            print(canonicalize_artifact_selection(args.root, raw_selection))
        elif args.command == "validate":
            validate_plan(args.root, args.plan)
        else:
            plan = load_plan(args.plan)
            write_json(
                create_manifest(plan, args.stage, args.bundle, args.source_commit),
                args.output,
            )
    except ValueError as error:
        print(f"Maven release plan failed: {error}", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
