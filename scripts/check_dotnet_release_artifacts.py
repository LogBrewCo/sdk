#!/usr/bin/env python3
"""Validate exact .NET release artifacts before registry publication."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from release_metadata_dotnet import DOTNET_RELEASE_PACKAGES, compatible_dependency_range


REPOSITORY_URL = "https://github.com/LogBrewCo/sdk"
SOURCE_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
NUGET_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
DEPENDENCY_RANGE_RE = re.compile(r"^\[([^,\s]+), ([^\)\s]+)\)$")


def parse_versions(raw_versions: list[str]) -> dict[str, str]:
    allowed = {package.package_id for package in DOTNET_RELEASE_PACKAGES}
    versions: dict[str, str] = {}
    for raw_version in raw_versions:
        package_id, separator, version = raw_version.partition("=")
        package_id = package_id.strip()
        version = version.strip()
        if (
            not separator
            or package_id not in allowed
            or NUGET_VERSION_RE.fullmatch(version) is None
        ):
            raise ValueError("invalid NuGet package version selection")
        if package_id in versions:
            raise ValueError(f"duplicate NuGet package selection: {package_id}")
        versions[package_id] = version
    if not versions:
        raise ValueError("missing NuGet package version selection")
    return versions


def parse_dependency_ranges(raw_ranges: list[str]) -> dict[str, dict[str, str]]:
    allowed = {package.package_id for package in DOTNET_RELEASE_PACKAGES}
    ranges: dict[str, dict[str, str]] = {}
    for raw_range in raw_ranges:
        selection, separator, version_range = raw_range.partition("=")
        package_id, dependency_separator, dependency_id = selection.partition(":")
        package_id = package_id.strip()
        dependency_id = dependency_id.strip()
        version_range = version_range.strip()
        match = DEPENDENCY_RANGE_RE.fullmatch(version_range)
        if (
            not separator
            or not dependency_separator
            or package_id not in allowed
            or dependency_id not in allowed
            or match is None
            or NUGET_VERSION_RE.fullmatch(match.group(1)) is None
            or NUGET_VERSION_RE.fullmatch(match.group(2)) is None
        ):
            raise ValueError("invalid NuGet dependency range selection")
        package_ranges = ranges.setdefault(package_id, {})
        if dependency_id in package_ranges:
            raise ValueError("duplicate NuGet dependency range selection")
        package_ranges[dependency_id] = version_range
    return ranges


def validate_artifacts(
    directory: Path,
    versions: dict[str, str],
    source_commit: str,
    dependency_ranges: dict[str, dict[str, str]],
) -> tuple[list[str], list[dict[str, str]]]:
    failures: list[str] = []
    records: list[dict[str, str]] = []
    expected_main = {f"{package_id}.{version}.nupkg" for package_id, version in versions.items()}
    expected_symbols = {f"{package_id}.{version}.snupkg" for package_id, version in versions.items()}
    actual_main = {path.name for path in directory.glob("*.nupkg") if not path.name.endswith(".snupkg")}
    actual_symbols = {path.name for path in directory.glob("*.snupkg")}

    report_set_difference(failures, "nupkg", expected_main, actual_main)
    report_set_difference(failures, "snupkg", expected_symbols, actual_symbols)
    if failures:
        return failures, records

    for package_id, version in sorted(versions.items()):
        main_path = directory / f"{package_id}.{version}.nupkg"
        symbol_path = directory / f"{package_id}.{version}.snupkg"
        expected_dependencies = dependency_ranges.get(package_id, {})
        main_files = validate_archive(
            main_path,
            package_id,
            version,
            source_commit,
            expected_dependencies,
            failures,
        )
        symbol_files = validate_archive(
            symbol_path,
            package_id,
            version,
            source_commit,
            expected_dependencies,
            failures,
        )
        dll_files = {name[:-4] for name in main_files if name.endswith(".dll") and name.startswith("lib/")}
        xml_files = {name[:-4] for name in main_files if name.endswith(".xml") and name.startswith("lib/")}
        pdb_names = {name for name in symbol_files if name.endswith(".pdb") and name.startswith("lib/")}
        pdb_files = {name[:-4] for name in pdb_names}
        if not dll_files:
            failures.append(f"{package_id}: missing package assemblies")
        if dll_files != xml_files:
            failures.append(f"{package_id}: missing XML documentation for package assemblies")
        if dll_files != pdb_files:
            failures.append(f"{package_id}: missing portable symbols for package assemblies")
        validate_source_link(symbol_path, package_id, pdb_names, source_commit, failures)
        try:
            content_digest = package_content_sha256(main_path)
        except (OSError, RuntimeError, ValueError, zipfile.BadZipFile):
            failures.append(f"{package_id}: invalid package content")
            content_digest = ""
        records.append(
            {
                "id": package_id,
                "version": version,
                "nupkgSha256": sha256(main_path),
                "nupkgContentSha256": content_digest,
                "snupkgSha256": sha256(symbol_path),
            }
        )
    return failures, records


def report_set_difference(
    failures: list[str],
    label: str,
    expected: set[str],
    actual: set[str],
) -> None:
    for name in sorted(expected - actual):
        failures.append(f"missing {label}: {name}")
    for name in sorted(actual - expected):
        failures.append(f"unexpected {label}: {name}")


def validate_archive(
    path: Path,
    package_id: str,
    version: str,
    source_commit: str,
    expected_dependencies: dict[str, str],
    failures: list[str],
) -> set[str]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            nuspec_names = sorted(name for name in names if name.endswith(".nuspec"))
            if len(nuspec_names) != 1:
                failures.append(f"{package_id}: expected one nuspec")
                return names
            root = ET.fromstring(archive.read(nuspec_names[0]))
    except (OSError, ET.ParseError, zipfile.BadZipFile):
        failures.append(f"{package_id}: invalid package archive")
        return set()

    metadata = find_child(root, "metadata")
    if metadata is None:
        failures.append(f"{package_id}: missing package metadata")
        return names
    if child_text(metadata, "id") != package_id:
        failures.append(f"{package_id}: package id mismatch")
    if child_text(metadata, "version") != version:
        failures.append(f"{package_id}: package version mismatch")
    repository = find_child(metadata, "repository")
    if (
        repository is None
        or repository.attrib.get("type") != "git"
        or repository.attrib.get("url") != REPOSITORY_URL
    ):
        failures.append(f"{package_id}: repository source mismatch")
    elif repository.attrib.get("commit") != source_commit:
        failures.append(f"{package_id}: source commit mismatch")
    validate_dependencies(metadata, package_id, expected_dependencies, failures)
    return names


def validate_dependencies(
    metadata: ET.Element,
    package_id: str,
    expected: dict[str, str],
    failures: list[str],
) -> None:
    if not expected:
        return
    dependencies = find_child(metadata, "dependencies")
    if dependencies is None:
        failures.append(f"{package_id}: missing dependency range metadata")
        return
    groups = [child for child in dependencies if strip_namespace(child.tag) == "group"]
    containers = groups or [dependencies]
    if not containers:
        failures.append(f"{package_id}: missing dependency range metadata")
        return
    for dependency_id, expected_range in sorted(expected.items()):
        for container in containers:
            matches = [
                child
                for child in container
                if strip_namespace(child.tag) == "dependency"
                and child.attrib.get("id") == dependency_id
            ]
            if len(matches) != 1 or matches[0].attrib.get("version") != expected_range:
                failures.append(
                    f"{package_id}: {dependency_id} dependency range mismatch"
                )
                break


def validate_source_link(
    path: Path,
    package_id: str,
    pdb_names: set[str],
    source_commit: str,
    failures: list[str],
) -> None:
    source_root = b"raw.githubusercontent.com/LogBrewCo/sdk"
    commit = source_commit.encode("ascii")
    try:
        with zipfile.ZipFile(path) as archive:
            for name in sorted(pdb_names):
                contents = archive.read(name)
                if source_root not in contents or commit not in contents:
                    failures.append(f"{package_id}: portable symbols are missing exact Source Link")
                    return
    except (OSError, RuntimeError, zipfile.BadZipFile):
        failures.append(f"{package_id}: invalid portable symbols")


def find_child(element: ET.Element, name: str) -> ET.Element | None:
    return next((child for child in element if strip_namespace(child.tag) == name), None)


def child_text(element: ET.Element, name: str) -> str | None:
    child = find_child(element, name)
    return child.text if child is not None else None


def strip_namespace(tag: str) -> str:
    return tag.split("}", 1)[-1]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_content_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with zipfile.ZipFile(path) as archive:
        entries = [entry for entry in archive.infolist() if entry.filename != ".signature.p7s"]
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("package archive contains duplicate entries")
        for entry in sorted(entries, key=lambda item: item.filename):
            name = entry.filename.encode("utf-8")
            digest.update(len(name).to_bytes(8, "big"))
            digest.update(name)
            digest.update(entry.file_size.to_bytes(8, "big"))
            with archive.open(entry) as source:
                while chunk := source.read(64 * 1024):
                    digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--nuget-version", action="append", default=[])
    parser.add_argument("--dependency-range", action="append", default=[])
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    if not SOURCE_COMMIT_RE.fullmatch(args.source_commit):
        parser.error("--source-commit must be 40 lowercase hexadecimal characters")
    try:
        versions = parse_versions(args.nuget_version)
        dependency_ranges = parse_dependency_ranges(args.dependency_range)
    except ValueError as error:
        parser.error(str(error))
    if not set(dependency_ranges).issubset(versions):
        parser.error("dependency range package must be selected for validation")
    if "LogBrew.HttpClient" in versions:
        httpclient_dependencies = dependency_ranges.get("LogBrew.HttpClient", {})
        if set(httpclient_dependencies) != {"LogBrew"}:
            parser.error("missing HttpClient core dependency range")
        if "LogBrew" in versions and httpclient_dependencies["LogBrew"] != compatible_dependency_range(
            versions["LogBrew"]
        ):
            parser.error("HttpClient core dependency range does not match selected core version")

    failures, records = validate_artifacts(
        args.directory,
        versions,
        args.source_commit,
        dependency_ranges,
    )
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    payload = {"sourceCommit": args.source_commit, "packages": records}
    manifest_temp = args.manifest.with_suffix(args.manifest.suffix + ".tmp")
    manifest_temp.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest_temp.replace(args.manifest)
    for record in records:
        print(
            f"{record['id']}@{record['version']} "
            f"nupkg_sha256={record['nupkgSha256']} "
            f"content_sha256={record['nupkgContentSha256']} "
            f"snupkg_sha256={record['snupkgSha256']}"
        )
    print("dotnet release artifacts ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
