#!/usr/bin/env python3
"""Create and validate a typed plan for selected NuGet release packages."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, NoReturn

from release_metadata_dotnet import DOTNET_RELEASE_PACKAGES


SCHEMA_VERSION = 1
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?")
CATALOG = {package.package_id: package for package in DOTNET_RELEASE_PACKAGES}
TARGETED_RELEASE_PACKAGES = {"LogBrew", "LogBrew.HttpClient"}


def fail(message: str) -> NoReturn:
    raise ValueError(message)


def project_version(root: Path, project_path: str) -> str:
    try:
        value = ET.parse(root / project_path).getroot().findtext("./PropertyGroup/Version")
    except (OSError, ET.ParseError):
        fail("invalid NuGet release package metadata")
    if not isinstance(value, str) or VERSION.fullmatch(value.strip()) is None:
        fail("invalid NuGet release package metadata")
    return value.strip()


def parse_selection(raw: str) -> tuple[str, ...]:
    if "\r" in raw or "\n" in raw:
        fail("invalid NuGet package selection")
    if raw == "":
        return tuple(CATALOG)
    entries = [entry.strip() for entry in raw.split(",")]
    if any(not entry for entry in entries):
        fail("invalid NuGet package selection")
    if len(entries) != len(set(entries)) or any(entry not in CATALOG for entry in entries):
        fail("invalid NuGet package selection")
    selected = set(entries)
    if selected != TARGETED_RELEASE_PACKAGES:
        fail("invalid NuGet package selection")
    return tuple(package_id for package_id in CATALOG if package_id in selected)


def expected_plan(
    root: Path,
    selected_ids: tuple[str, ...],
    selection_mode: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "selectionMode": selection_mode,
        "selected": [
            {
                "packageId": package_id,
                "projectPath": CATALOG[package_id].project_path,
                "version": project_version(root, CATALOG[package_id].project_path),
                "versionOutput": CATALOG[package_id].version_output,
            }
            for package_id in selected_ids
        ],
    }


def load_plan(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail("invalid NuGet release plan")
    if not isinstance(payload, dict):
        fail("invalid NuGet release plan")
    return payload


def validate_plan(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    entries = payload.get("selected")
    selection_mode = payload.get("selectionMode")
    if (
        payload.get("schemaVersion") != SCHEMA_VERSION
        or selection_mode not in {"all", "selected"}
        or not isinstance(entries, list)
    ):
        fail("invalid NuGet release plan")
    selected_ids: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("packageId"), str):
            fail("invalid NuGet release plan")
        selected_ids.append(entry["packageId"])
    if (
        not selected_ids
        or len(selected_ids) != len(set(selected_ids))
        or any(package_id not in CATALOG for package_id in selected_ids)
        or tuple(selected_ids)
        != tuple(package_id for package_id in CATALOG if package_id in set(selected_ids))
    ):
        fail("invalid NuGet release plan")
    if selection_mode == "all" and tuple(selected_ids) != tuple(CATALOG):
        fail("invalid NuGet release plan")
    if selection_mode == "selected" and set(selected_ids) != TARGETED_RELEASE_PACKAGES:
        fail("invalid NuGet release plan")
    expected = expected_plan(root, tuple(selected_ids), selection_mode)
    if payload != expected:
        fail("invalid NuGet release plan")
    return expected


def write_plan(payload: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def parser() -> argparse.ArgumentParser:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    commands = argument_parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create")
    create.add_argument("--root", type=Path, required=True)
    create.add_argument("--packages-env", required=True)
    create.add_argument("--output", type=Path, required=True)

    validate = commands.add_parser("validate")
    validate.add_argument("--root", type=Path, required=True)
    validate.add_argument("--plan", type=Path, required=True)

    canonicalize = commands.add_parser("canonicalize")
    canonicalize.add_argument("--packages-env", required=True)

    entries = commands.add_parser("entries")
    entries.add_argument("--root", type=Path, required=True)
    entries.add_argument("--plan", type=Path, required=True)
    entries.add_argument(
        "--format",
        choices=("ids", "versions", "projects", "mode"),
        required=True,
    )
    return argument_parser


def print_entries(payload: dict[str, Any], output_format: str) -> None:
    if output_format == "mode":
        print(payload["selectionMode"])
        return
    for entry in payload["selected"]:
        if output_format == "ids":
            print(entry["packageId"])
        elif output_format == "versions":
            print(f'{entry["packageId"]}={entry["version"]}')
        else:
            print(
                entry["packageId"],
                entry["projectPath"],
                entry["version"],
                sep="\t",
            )


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command in {"create", "canonicalize"}:
            raw = os.environ.get(args.packages_env)
            if raw is None:
                fail("invalid NuGet package selection")
            selected = parse_selection(raw)
            if args.command == "create":
                selection_mode = "all" if raw == "" else "selected"
                write_plan(expected_plan(args.root, selected, selection_mode), args.output)
            else:
                print("" if raw == "" else ",".join(selected))
        else:
            payload = validate_plan(args.root, load_plan(args.plan))
            if args.command == "entries":
                print_entries(payload, args.format)
    except ValueError as error:
        prefix = "invalid NuGet package selection" if args.command == "create" else "invalid NuGet release plan"
        if str(error).startswith(prefix):
            print(prefix, file=sys.stderr)
        else:
            print(prefix, file=sys.stderr)
        return 1
    if args.command not in {"entries", "canonicalize"}:
        print("nuget release plan ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
