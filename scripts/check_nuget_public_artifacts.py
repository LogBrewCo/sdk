#!/usr/bin/env python3
"""Resolve and validate exact public NuGet package bytes for reconciliation."""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime
import hashlib
import http.client
import json
import os
import re
import shutil
import stat
import struct
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn


SCHEMA_VERSION = 1
SOURCE_COMMIT = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?")
DIGEST = re.compile(r"[0-9a-f]{64}")
PACKAGE_IDS = ("LogBrew", "LogBrew.HttpClient")
SOURCE_PROJECTS = {
    "LogBrew": "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
    "LogBrew.HttpClient": (
        "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj"
    ),
}
REPOSITORY_URL = "https://github.com/LogBrewCo/sdk"
REGISTRATION_ROOT = "https://api.nuget.org/v3/registration5-gz-semver2"
PACKAGE_ROOT = "https://api.nuget.org/v3-flatcontainer"
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_METADATA_COMPRESSED_BYTES = 1024 * 1024
MAX_PACKAGE_BYTES = 50 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 1024
MAX_ARCHIVE_MEMBER_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_NUSPEC_BYTES = 512 * 1024
MAX_PROJECT_BYTES = 512 * 1024
MAX_ZIP_TAIL_BYTES = 65_557
CATALOG_TIMESTAMP = re.compile(r"[0-9]{4}(?:\.[0-9]{2}){5}")


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    """Reject registry redirects before any artifact bytes are accepted."""

    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        redirected_url: str,
    ) -> None:
        del request, file_pointer, code, message, headers, redirected_url
        return None


def fail(message: str = "NuGet public artifact verification failed") -> NoReturn:
    raise ValueError(message)


def parse_versions(raw_versions: list[str]) -> dict[str, str]:
    versions: dict[str, str] = {}
    for raw in raw_versions:
        package_id, separator, version = raw.partition("=")
        package_id = package_id.strip()
        version = version.strip()
        if (
            not separator
            or package_id not in PACKAGE_IDS
            or VERSION.fullmatch(version) is None
            or package_id in versions
        ):
            fail("invalid NuGet public package selection")
        versions[package_id] = version
    if tuple(versions) != PACKAGE_IDS:
        fail("invalid NuGet public package selection")
    return versions


def open_bounded(
    url: str,
    limit: int,
    timeout: int,
    opener: Any | None,
    *,
    allow_metadata_encoding: bool = False,
) -> bytes:
    headers = {"User-Agent": "LogBrew public package reconciliation"}
    if allow_metadata_encoding:
        headers["Accept-Encoding"] = "gzip"
    request = urllib.request.Request(
        url,
        headers=headers,
    )
    open_request = opener or urllib.request.build_opener(RejectRedirects()).open
    try:
        with open_request(request, timeout=timeout) as response:
            if response.getcode() != 200 or response.geturl() != request.full_url:
                fail()
            encoding = content_encoding(response)
            if encoding is None or (allow_metadata_encoding and encoding == "identity"):
                body = read_bounded(response, limit)
            elif allow_metadata_encoding and encoding == "gzip":
                body = read_gzip_bounded(
                    response,
                    MAX_METADATA_COMPRESSED_BYTES,
                    limit,
                )
            else:
                fail()
    except (
        http.client.HTTPException,
        OSError,
        urllib.error.HTTPError,
        urllib.error.URLError,
        ValueError,
    ):
        fail()
    return body


def content_encoding(response: Any) -> str | None:
    try:
        values = response.headers.get_all("Content-Encoding")
    except (AttributeError, TypeError, ValueError):
        fail()
    if values is None:
        return None
    if (
        not isinstance(values, list)
        or len(values) != 1
        or values[0] not in {"gzip", "identity"}
    ):
        fail()
    return values[0]


def read_bounded(response: Any, limit: int) -> bytes:
    body = bytearray()
    while chunk := response.read(min(64 * 1024, limit + 1 - len(body))):
        if not isinstance(chunk, bytes):
            fail()
        body.extend(chunk)
        if len(body) > limit:
            fail()
    return bytes(body)


def read_gzip_bounded(
    response: Any,
    compressed_limit: int,
    decompressed_limit: int,
) -> bytes:
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    body = bytearray()
    compressed = 0
    try:
        while chunk := response.read(64 * 1024):
            if not isinstance(chunk, bytes):
                fail()
            compressed += len(chunk)
            if compressed > compressed_limit:
                fail()
            pending = chunk
            while pending:
                available = decompressed_limit + 1 - len(body)
                if available <= 0:
                    fail()
                body.extend(decoder.decompress(pending, available))
                if len(body) > decompressed_limit or decoder.unused_data:
                    fail()
                pending = decoder.unconsumed_tail
        body.extend(decoder.flush(max(1, decompressed_limit + 1 - len(body))))
    except zlib.error:
        fail()
    if (
        len(body) > decompressed_limit
        or not decoder.eof
        or decoder.unused_data
        or decoder.unconsumed_tail
    ):
        fail()
    return bytes(body)


def registry_urls(package_id: str, version: str) -> tuple[str, str]:
    normalized = package_id.lower()
    metadata = f"{REGISTRATION_ROOT}/{normalized}/{version}.json"
    package = f"{PACKAGE_ROOT}/{normalized}/{version}/{normalized}.{version}.nupkg"
    return metadata, package


def decode_registry_digest(raw: Any) -> bytes:
    if not isinstance(raw, str):
        fail()
    try:
        decoded = base64.b64decode(raw, validate=True)
    except (ValueError, binascii.Error):
        fail()
    if len(decoded) != hashlib.sha512().digest_size:
        fail()
    return decoded


def canonical_dependency_range(raw: Any) -> str:
    if not isinstance(raw, str):
        fail()
    if VERSION.fullmatch(raw) is not None:
        return f"[{raw}, )"
    parts = raw[1:-1].split(", ") if raw.startswith("[") and raw.endswith(")") else []
    if (
        len(parts) != 2
        or VERSION.fullmatch(parts[0]) is None
        or (parts[1] and VERSION.fullmatch(parts[1]) is None)
    ):
        fail()
    return raw


def preflight_package(path: Path) -> None:
    try:
        size = path.stat().st_size
        if size <= 0 or size > MAX_PACKAGE_BYTES:
            fail()
        with path.open("rb") as source:
            start = max(0, size - MAX_ZIP_TAIL_BYTES)
            source.seek(start)
            tail = source.read(MAX_ZIP_TAIL_BYTES)
    except OSError:
        fail()
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        fail()
    (
        disk,
        directory_disk,
        disk_members,
        total_members,
        directory_size,
        directory_offset,
        comment_size,
    ) = struct.unpack_from("<4H2LH", tail, offset + 4)
    end_offset = start + offset
    if (
        disk != 0
        or directory_disk != 0
        or disk_members != total_members
        or total_members > MAX_ARCHIVE_MEMBERS
        or total_members == 0xFFFF
        or directory_size == 0xFFFFFFFF
        or directory_offset == 0xFFFFFFFF
        or directory_offset + directory_size != end_offset
        or end_offset + 22 + comment_size != size
    ):
        fail()


def bounded_package_entries(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    total = 0
    if (
        len(entries) > MAX_ARCHIVE_MEMBERS
        or len(names) != len(set(names))
        or any(not safe_archive_name(name) for name in names)
    ):
        fail()
    for entry in entries:
        file_type = stat.S_IFMT((entry.external_attr >> 16) & 0xFFFF)
        expected_type = stat.S_IFDIR if entry.is_dir() else stat.S_IFREG
        if (
            entry.file_size < 0
            or entry.file_size > MAX_ARCHIVE_MEMBER_BYTES
            or entry.flag_bits & 1
            or file_type not in {0, expected_type}
        ):
            fail()
        if not entry.is_dir():
            total += entry.file_size
            if total > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                fail()
    return entries


def read_package_member(
    archive: zipfile.ZipFile,
    entry: zipfile.ZipInfo,
    limit: int,
) -> bytes:
    if entry.file_size > limit:
        fail()
    with archive.open(entry) as source:
        document = source.read(limit + 1)
    if len(document) != entry.file_size or len(document) > limit:
        fail()
    return document


def source_dependency_contract(
    source_root: Path,
    package_id: str,
    core_dependency_range: str,
) -> tuple[tuple[str, ...], dict[str, str]]:
    if (
        not source_root.is_absolute()
        or source_root.is_symlink()
        or not source_root.is_dir()
    ):
        fail()
    try:
        project_path = source_root / SOURCE_PROJECTS[package_id]
        if (
            project_path.is_symlink()
            or not project_path.is_file()
            or project_path.stat().st_size > MAX_PROJECT_BYTES
        ):
            fail()
        document = project_path.read_bytes()
    except OSError:
        fail()
    upper = document.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        fail()
    try:
        project = ET.fromstring(document)
    except ET.ParseError:
        fail()

    frameworks = [
        element.text.strip()
        for element in project.iter()
        if strip_namespace(element.tag) == "TargetFrameworks"
        and element.text
        and element.text.strip()
    ]
    if len(frameworks) != 1:
        fail()
    target_frameworks = frameworks[0].split(";")
    if len(target_frameworks) != len(set(target_frameworks)) or any(
        not framework for framework in target_frameworks
    ):
        fail()

    dependencies: dict[str, str] = {}
    project_references: list[str] = []
    for item_group in project.iter():
        if strip_namespace(item_group.tag) != "ItemGroup":
            continue
        for item in item_group:
            item_name = strip_namespace(item.tag)
            if item_name not in {"PackageReference", "ProjectReference"}:
                continue
            if item_group.attrib.get("Condition") or item.attrib.get("Condition"):
                fail()
            include = item.attrib.get("Include")
            if not isinstance(include, str) or not include:
                fail()
            if item_name == "ProjectReference":
                project_references.append(include)
                continue
            version = item.attrib.get("Version")
            if (
                not isinstance(version, str)
                or VERSION.fullmatch(version) is None
                or include in dependencies
            ):
                fail()
            dependencies[include] = canonical_dependency_range(version)
    if package_id == "LogBrew":
        if project_references:
            fail()
    elif project_references != ["../LogBrew/LogBrew.csproj"]:
        fail()
    else:
        dependencies["LogBrew"] = canonical_dependency_range(core_dependency_range)
    if not dependencies:
        fail()
    return tuple(target_frameworks), dependencies


def validate_dependency_groups(
    groups: Any,
    contract: tuple[tuple[str, ...], dict[str, str]],
    *,
    dependency_key: str,
    framework_key: str,
) -> None:
    expected_frameworks, expected_dependencies = contract
    if not isinstance(groups, list) or len(groups) != len(expected_frameworks):
        fail()
    frameworks: set[str] = set()
    for group in groups:
        if not isinstance(group, dict):
            fail()
        framework = group.get(framework_key)
        dependencies = group.get("dependencies")
        if (
            not isinstance(framework, str)
            or not framework
            or framework in frameworks
            or not isinstance(dependencies, list)
        ):
            fail()
        frameworks.add(framework)
        actual: dict[str, str] = {}
        for dependency in dependencies:
            dependency_id = (
                dependency.get("id") if isinstance(dependency, dict) else None
            )
            raw_dependency_range = (
                dependency.get(dependency_key) if isinstance(dependency, dict) else None
            )
            if not isinstance(dependency_id, str) or dependency_id in actual:
                fail()
            actual[dependency_id] = canonical_dependency_range(raw_dependency_range)
        if actual != expected_dependencies:
            fail()
    if frameworks != set(expected_frameworks):
        fail()


def validate_catalog_url(raw: Any, package_id: str, version: str) -> str:
    if (
        not isinstance(raw, str)
        or not isinstance(package_id, str)
        or not isinstance(version, str)
    ):
        fail()
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError:
        fail()
    segments = parsed.path.split("/")
    expected_filename = f"{package_id.lower()}.{version}.json"
    if (
        raw != parsed.geturl()
        or parsed.scheme != "https"
        or parsed.netloc != "api.nuget.org"
        or parsed.query
        or parsed.fragment
        or len(segments) != 6
        or segments[:4] != ["", "v3", "catalog0", "data"]
        or not valid_catalog_timestamp(segments[4])
        or segments[5] != expected_filename
        or urllib.parse.quote(parsed.path, safe="/.-") != parsed.path
    ):
        fail()
    return raw


def valid_catalog_timestamp(raw: str) -> bool:
    if CATALOG_TIMESTAMP.fullmatch(raw) is None:
        return False
    try:
        datetime.datetime.strptime(raw, "%Y.%m.%d.%H.%M.%S")
    except ValueError:
        return False
    return True


def fetch_registry_record(
    package_id: str,
    version: str,
    dependency_contract: tuple[tuple[str, ...], dict[str, str]],
    opener: Any | None,
) -> tuple[str, bytes]:
    metadata_url, expected_package_url = registry_urls(package_id, version)
    raw = open_bounded(
        metadata_url,
        MAX_METADATA_BYTES,
        30,
        opener,
        allow_metadata_encoding=True,
    )
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        fail()
    if (
        not isinstance(payload, dict)
        or payload.get("packageContent") != expected_package_url
    ):
        fail()
    catalog_url = validate_catalog_url(
        payload.get("catalogEntry"),
        package_id,
        version,
    )
    raw_catalog = open_bounded(
        catalog_url,
        MAX_METADATA_BYTES,
        30,
        opener,
        allow_metadata_encoding=True,
    )
    try:
        catalog = json.loads(raw_catalog)
    except (json.JSONDecodeError, UnicodeDecodeError):
        fail()
    if (
        not isinstance(catalog, dict)
        or catalog.get("id") != package_id
        or catalog.get("version") != version
        or catalog.get("packageHashAlgorithm") != "SHA512"
    ):
        fail()
    validate_dependency_groups(
        catalog.get("dependencyGroups"),
        dependency_contract,
        dependency_key="range",
        framework_key="targetFramework",
    )
    digest = decode_registry_digest(catalog.get("packageHash"))
    return expected_package_url, digest


def safe_archive_name(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        bool(name)
        and "\x00" not in name
        and "\\" not in name
        and not path.is_absolute()
        and bool(path.parts)
        and all(part not in {"", ".", ".."} for part in path.parts)
    )


def strip_namespace(tag: str) -> str:
    return tag.split("}", 1)[-1]


def find_child(element: ET.Element, name: str) -> ET.Element | None:
    return next(
        (child for child in element if strip_namespace(child.tag) == name), None
    )


def child_text(element: ET.Element, name: str) -> str | None:
    child = find_child(element, name)
    return child.text.strip() if child is not None and child.text else None


def validate_nuspec_dependencies(
    metadata: ET.Element,
    dependency_contract: tuple[tuple[str, ...], dict[str, str]],
) -> None:
    dependency_nodes = [
        child for child in metadata if strip_namespace(child.tag) == "dependencies"
    ]
    if len(dependency_nodes) != 1:
        fail()
    groups = list(dependency_nodes[0])
    if (
        len(groups) != len(dependency_contract[0])
        or any(strip_namespace(group.tag) != "group" for group in groups)
        or any(
            strip_namespace(child.tag) != "dependency"
            for group in groups
            for child in group
        )
    ):
        fail()
    payload = [
        {
            "targetFramework": group.attrib.get("targetFramework"),
            "dependencies": [
                {
                    "id": child.attrib.get("id"),
                    "version": child.attrib.get("version"),
                }
                for child in group
            ],
        }
        for group in groups
    ]
    validate_dependency_groups(
        payload,
        dependency_contract,
        dependency_key="version",
        framework_key="targetFramework",
    )


def validate_package(
    path: Path,
    package_id: str,
    version: str,
    source_commit: str,
    dependency_contract: tuple[tuple[str, ...], dict[str, str]],
) -> str:
    preflight_package(path)
    try:
        with zipfile.ZipFile(path) as archive:
            entries = bounded_package_entries(archive)
            nuspecs = [entry for entry in entries if entry.filename.endswith(".nuspec")]
            if len(nuspecs) != 1:
                fail()
            document = read_package_member(archive, nuspecs[0], MAX_NUSPEC_BYTES)
    except (EOFError, OSError, RuntimeError, zipfile.BadZipFile, KeyError):
        fail()
    upper = document.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        fail()
    try:
        root = ET.fromstring(document)
    except ET.ParseError:
        fail()
    metadata = find_child(root, "metadata")
    repository = find_child(metadata, "repository") if metadata is not None else None
    if (
        metadata is None
        or child_text(metadata, "id") != package_id
        or child_text(metadata, "version") != version
        or repository is None
        or repository.attrib.get("type") != "git"
        or repository.attrib.get("url") != REPOSITORY_URL
        or repository.attrib.get("commit") != source_commit
    ):
        fail()
    validate_nuspec_dependencies(metadata, dependency_contract)
    return package_content_sha256(path)


def package_content_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    preflight_package(path)
    try:
        with zipfile.ZipFile(path) as archive:
            entries = [
                entry
                for entry in bounded_package_entries(archive)
                if entry.filename != ".signature.p7s"
            ]
            for entry in sorted(entries, key=lambda item: item.filename):
                name = entry.filename.encode("utf-8")
                digest.update(len(name).to_bytes(8, "big"))
                digest.update(name)
                digest.update(entry.file_size.to_bytes(8, "big"))
                with archive.open(entry) as source:
                    observed = 0
                    while chunk := source.read(64 * 1024):
                        observed += len(chunk)
                        if observed > entry.file_size:
                            fail()
                        digest.update(chunk)
                    if observed != entry.file_size:
                        fail()
    except (EOFError, OSError, RuntimeError, zipfile.BadZipFile):
        fail()
    return digest.hexdigest()


def write_json(payload: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
    )
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


def resolve_public_artifacts(
    versions: dict[str, str],
    source_commit: str,
    dependency_range: str,
    source_root: Path,
    output_directory: Path,
    manifest_path: Path,
    *,
    opener: Any | None = None,
) -> None:
    if (
        tuple(versions) != PACKAGE_IDS
        or SOURCE_COMMIT.fullmatch(source_commit) is None
        or not dependency_range.startswith(f"[{versions['LogBrew']}, ")
        or not dependency_range.endswith(")")
        or output_directory.exists()
        or output_directory.is_symlink()
    ):
        fail()
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=".nuget-public.", dir=output_directory.parent)
    )
    records: list[dict[str, str]] = []
    dependency_contracts = {
        package_id: source_dependency_contract(
            source_root,
            package_id,
            dependency_range,
        )
        for package_id in PACKAGE_IDS
    }
    try:
        for package_id, version in versions.items():
            package_url, registry_digest = fetch_registry_record(
                package_id,
                version,
                dependency_contracts[package_id],
                opener,
            )
            body = open_bounded(package_url, MAX_PACKAGE_BYTES, 60, opener)
            if hashlib.sha512(body).digest() != registry_digest:
                fail()
            destination = temporary / f"{package_id}.{version}.nupkg"
            destination.write_bytes(body)
            content_digest = validate_package(
                destination,
                package_id,
                version,
                source_commit,
                dependency_contracts[package_id],
            )
            records.append(
                {
                    "id": package_id,
                    "version": version,
                    "file": destination.name,
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "registrySha512": base64.b64encode(registry_digest).decode(),
                    "contentSha256": content_digest,
                }
            )
        os.replace(temporary, output_directory)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    write_json(
        {
            "schemaVersion": SCHEMA_VERSION,
            "sourceCommit": source_commit,
            "packages": records,
        },
        manifest_path,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nuget-version", action="append", default=[])
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--dependency-range", required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        resolve_public_artifacts(
            parse_versions(args.nuget_version),
            args.source_commit,
            args.dependency_range,
            args.source_root,
            args.output_directory,
            args.manifest,
        )
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("NuGet public artifact verification ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
