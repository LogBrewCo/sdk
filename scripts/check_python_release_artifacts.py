#!/usr/bin/env python3
"""Validate and bind exact Python release artifacts before publication."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from email.parser import Parser
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn


SCHEMA_VERSION = 1
SOURCE_COMMIT = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?")


@dataclass(frozen=True)
class PackageSpec:
    package_id: str
    directory: str
    filename_name: str


CATALOG = (
    PackageSpec("logbrew-sdk", "logbrew_py", "logbrew_sdk"),
    PackageSpec("logbrew-fastapi", "logbrew_fastapi", "logbrew_fastapi"),
    PackageSpec("logbrew-flask", "logbrew_flask", "logbrew_flask"),
    PackageSpec("logbrew-django", "logbrew_django", "logbrew_django"),
)
CATALOG_BY_ID = {package.package_id: package for package in CATALOG}


def fail(message: str) -> NoReturn:
    raise ValueError(message)


def parse_versions(raw_versions: list[str]) -> dict[str, str]:
    versions: dict[str, str] = {}
    for raw_version in raw_versions:
        package_id, separator, version = raw_version.partition("=")
        package_id = package_id.strip()
        version = version.strip()
        if (
            not separator
            or package_id not in CATALOG_BY_ID
            or VERSION.fullmatch(version) is None
        ):
            fail("invalid Python package version selection")
        if package_id in versions:
            fail("duplicate Python package version selection")
        versions[package_id] = version
    if set(versions) != set(CATALOG_BY_ID):
        fail("Python release validation requires every public package version")
    return versions


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_archive_name(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts and "" not in path.parts


def parse_metadata(raw: bytes, package_id: str, version: str) -> None:
    try:
        metadata = Parser().parsestr(raw.decode("utf-8"))
    except UnicodeDecodeError:
        fail(f"{package_id}: invalid package metadata")
    if metadata.get("Name") != package_id or metadata.get("Version") != version:
        fail(f"{package_id}: package metadata mismatch")


def validate_wheel(path: Path, package_id: str, version: str) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or any(
                not safe_archive_name(name) for name in names
            ):
                fail(f"{package_id}: invalid wheel entries")
            metadata_names = [name for name in names if name.endswith(".dist-info/METADATA")]
            if len(metadata_names) != 1:
                fail(f"{package_id}: expected one wheel metadata file")
            parse_metadata(archive.read(metadata_names[0]), package_id, version)
    except (OSError, zipfile.BadZipFile):
        fail(f"{package_id}: invalid wheel archive")


def validate_sdist(path: Path, package_id: str, version: str) -> None:
    try:
        with tarfile.open(path, "r:gz") as archive:
            members = archive.getmembers()
            names = [member.name for member in members]
            if (
                len(names) != len(set(names))
                or any(not safe_archive_name(name) for name in names)
                or any(member.issym() or member.islnk() for member in members)
            ):
                fail(f"{package_id}: invalid source archive entries")
            archive_root = path.name.removesuffix(".tar.gz")
            metadata_name = f"{archive_root}/PKG-INFO"
            metadata_members = [
                member for member in members if member.isfile() and member.name == metadata_name
            ]
            if len(metadata_members) != 1:
                fail(f"{package_id}: expected one source metadata file")
            source = archive.extractfile(metadata_members[0])
            if source is None:
                fail(f"{package_id}: missing source metadata")
            parse_metadata(source.read(), package_id, version)
    except (OSError, tarfile.TarError):
        fail(f"{package_id}: invalid source archive")


def expected_artifacts(
    directory: Path,
    package: PackageSpec,
    version: str,
) -> tuple[Path, Path]:
    package_root = directory / package.directory
    wheel = package_root / f"{package.filename_name}-{version}-py3-none-any.whl"
    sdist = package_root / f"{package.filename_name}-{version}.tar.gz"
    return wheel, sdist


def create_manifest(
    directory: Path,
    versions: dict[str, str],
    source_commit: str,
) -> dict[str, Any]:
    if SOURCE_COMMIT.fullmatch(source_commit) is None:
        fail("source commit must be 40 lowercase hexadecimal characters")

    missing: list[str] = []
    unexpected: list[str] = []
    records: list[dict[str, Any]] = []
    for package in CATALOG:
        version = versions[package.package_id]
        wheel, sdist = expected_artifacts(directory, package, version)
        package_root = directory / package.directory
        expected = {wheel.name, sdist.name}
        actual = (
            {
                path.name
                for path in package_root.iterdir()
                if path.is_file() and (path.suffix == ".whl" or path.name.endswith(".tar.gz"))
            }
            if package_root.is_dir()
            else set()
        )
        missing.extend(f"{package.directory}/{name}" for name in sorted(expected - actual))
        unexpected.extend(f"{package.directory}/{name}" for name in sorted(actual - expected))
        if wheel.is_file() and sdist.is_file():
            validate_wheel(wheel, package.package_id, version)
            validate_sdist(sdist, package.package_id, version)
            records.append(
                {
                    "id": package.package_id,
                    "version": version,
                    "wheel": {
                        "file": wheel.relative_to(directory).as_posix(),
                        "sha256": sha256(wheel),
                    },
                    "sdist": {
                        "file": sdist.relative_to(directory).as_posix(),
                        "sha256": sha256(sdist),
                    },
                }
            )
    if missing or unexpected:
        details = [*(f"missing artifact: {name}" for name in missing)]
        details.extend(f"unexpected artifact: {name}" for name in unexpected)
        fail("\n".join(details))

    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceCommit": source_commit,
        "packages": records,
    }


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail("invalid Python release manifest")
    if not isinstance(payload, dict):
        fail("invalid Python release manifest")
    return payload


def validate_manifest(directory: Path, manifest: dict[str, Any]) -> None:
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        fail("invalid Python release manifest schema")
    source_commit = manifest.get("sourceCommit")
    packages = manifest.get("packages")
    if (
        not isinstance(source_commit, str)
        or SOURCE_COMMIT.fullmatch(source_commit) is None
        or not isinstance(packages, list)
    ):
        fail("invalid Python release manifest")

    versions: dict[str, str] = {}
    for package, entry in zip(CATALOG, packages, strict=False):
        if not isinstance(entry, dict) or entry.get("id") != package.package_id:
            fail("invalid Python release manifest package order")
        version = entry.get("version")
        if not isinstance(version, str) or VERSION.fullmatch(version) is None:
            fail("invalid Python release manifest package version")
        versions[package.package_id] = version
    if len(packages) != len(CATALOG) or len(versions) != len(CATALOG):
        fail("invalid Python release manifest package count")

    expected = create_manifest(directory, versions, source_commit)
    if manifest != expected:
        fail("Python release artifact digest or metadata mismatch")


def write_manifest(payload: dict[str, Any], path: Path) -> None:
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
    create.add_argument("--directory", type=Path, required=True)
    create.add_argument("--source-commit", required=True)
    create.add_argument("--python-version", action="append", default=[])
    create.add_argument("--manifest", type=Path, required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--directory", type=Path, required=True)
    verify.add_argument("--manifest", type=Path, required=True)
    return argument_parser


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "create":
            manifest = create_manifest(
                args.directory,
                parse_versions(args.python_version),
                args.source_commit,
            )
            write_manifest(manifest, args.manifest)
        else:
            validate_manifest(args.directory, load_manifest(args.manifest))
    except ValueError as error:
        print(f"Python release artifacts failed: {error}", file=sys.stderr)
        return 1
    print("python release artifacts ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
