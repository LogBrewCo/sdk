#!/usr/bin/env python3
"""Validate and bind exact Python release artifacts before publication."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from dataclasses import dataclass
from email.parser import Parser
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn


SCHEMA_VERSION = 1
PUBLIC_RECONCILIATION_SCHEMA_VERSION = 1
SOURCE_COMMIT = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?")
DIGEST = re.compile(r"[0-9a-f]{64}")
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 1024
MAX_ARCHIVE_MEMBER_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_PACKAGE_METADATA_BYTES = 512 * 1024
MAX_ZIP_TAIL_BYTES = 65_557
MAX_TAR_STREAM_BYTES = (
    MAX_ARCHIVE_UNCOMPRESSED_BYTES + (MAX_ARCHIVE_MEMBERS + 2) * 512 + 10_240
)
PYPI_API_ROOT = "https://pypi.org/pypi"
PYPI_FILE_ORIGIN = "files.pythonhosted.org"


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


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    """Reject redirects so allowlisted origins remain authoritative."""

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
    return (
        bool(name)
        and "\x00" not in name
        and "\\" not in name
        and not path.is_absolute()
        and bool(path.parts)
        and all(part not in {"", ".", ".."} for part in path.parts)
    )


def zip_entry_is_regular(entry: zipfile.ZipInfo) -> bool:
    file_type = stat.S_IFMT((entry.external_attr >> 16) & 0xFFFF)
    expected = stat.S_IFDIR if entry.is_dir() else stat.S_IFREG
    return file_type in {0, expected}


def preflight_zip(path: Path, message: str) -> None:
    try:
        size = path.stat().st_size
        if size <= 0 or size > MAX_ARTIFACT_BYTES:
            fail(message)
        with path.open("rb") as source:
            start = max(0, size - MAX_ZIP_TAIL_BYTES)
            source.seek(start)
            tail = source.read(MAX_ZIP_TAIL_BYTES)
    except OSError:
        fail(message)
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        fail(message)
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
        fail(message)


def preflight_sdist(path: Path, message: str) -> None:
    try:
        size = path.stat().st_size
    except OSError:
        fail(message)
    if size <= 0 or size > MAX_ARTIFACT_BYTES:
        fail(message)
    members = 0
    aggregate = 0
    observed = 0
    zero_blocks = 0
    try:
        with gzip.open(path, "rb") as source:
            while True:
                header = source.read(512)
                observed += len(header)
                if observed > MAX_TAR_STREAM_BYTES or len(header) != 512:
                    fail(message)
                if header == bytes(512):
                    zero_blocks += 1
                    if zero_blocks == 2:
                        for chunk in iter(lambda: source.read(64 * 1024), b""):
                            observed += len(chunk)
                            if (
                                observed > MAX_TAR_STREAM_BYTES
                                or any(byte != 0 for byte in chunk)
                            ):
                                fail(message)
                        break
                    continue
                zero_blocks = 0
                members += 1
                member_size = parse_tar_size(header[124:136], message)
                aggregate += member_size
                if (
                    members > MAX_ARCHIVE_MEMBERS
                    or member_size > MAX_ARCHIVE_MEMBER_BYTES
                    or aggregate > MAX_ARCHIVE_UNCOMPRESSED_BYTES
                ):
                    fail(message)
                remaining = ((member_size + 511) // 512) * 512
                while remaining:
                    chunk = source.read(min(64 * 1024, remaining))
                    if not chunk:
                        fail(message)
                    observed += len(chunk)
                    remaining -= len(chunk)
                    if observed > MAX_TAR_STREAM_BYTES:
                        fail(message)
    except (EOFError, OSError, gzip.BadGzipFile, zlib.error):
        fail(message)


def parse_tar_size(raw: bytes, message: str) -> int:
    if not raw or raw[0] & 0x80:
        fail(message)
    value = raw.rstrip(b"\x00 ").lstrip(b" ")
    if not value or any(byte not in b"01234567" for byte in value):
        fail(message)
    return int(value, 8)


def bounded_zip_entries(
    archive: zipfile.ZipFile,
    message: str,
) -> list[zipfile.ZipInfo]:
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    total = 0
    if (
        len(entries) > MAX_ARCHIVE_MEMBERS
        or len(names) != len(set(names))
        or any(not safe_archive_name(name) for name in names)
    ):
        fail(message)
    for entry in entries:
        if (
            entry.file_size < 0
            or entry.file_size > MAX_ARCHIVE_MEMBER_BYTES
            or entry.flag_bits & 1
            or not zip_entry_is_regular(entry)
        ):
            fail(message)
        if not entry.is_dir():
            total += entry.file_size
            if total > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                fail(message)
    return entries


def bounded_tar_members(
    archive: tarfile.TarFile,
    message: str,
) -> list[tarfile.TarInfo]:
    members: list[tarfile.TarInfo] = []
    names: set[str] = set()
    total = 0
    for member in archive:
        if (
            len(members) >= MAX_ARCHIVE_MEMBERS
            or member.name in names
            or not safe_archive_name(member.name)
            or not (member.isfile() or member.isdir())
            or member.size < 0
            or member.size > MAX_ARCHIVE_MEMBER_BYTES
        ):
            fail(message)
        members.append(member)
        names.add(member.name)
        if member.isfile():
            total += member.size
            if total > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                fail(message)
    return members


def read_member(source: Any, expected_size: int, limit: int, message: str) -> bytes:
    if expected_size > limit:
        fail(message)
    contents = source.read(limit + 1)
    if len(contents) != expected_size or len(contents) > limit:
        fail(message)
    return contents


def hash_member(source: Any, expected_size: int, digest: Any, message: str) -> None:
    observed = 0
    while chunk := source.read(64 * 1024):
        observed += len(chunk)
        if observed > expected_size:
            fail(message)
        digest.update(chunk)
    if observed != expected_size:
        fail(message)


def parse_metadata(raw: bytes, package_id: str, version: str) -> None:
    try:
        metadata = Parser().parsestr(raw.decode("utf-8"))
    except UnicodeDecodeError:
        fail(f"{package_id}: invalid package metadata")
    if metadata.get("Name") != package_id or metadata.get("Version") != version:
        fail(f"{package_id}: package metadata mismatch")


def validate_wheel(path: Path, package_id: str, version: str) -> None:
    preflight_zip(path, f"{package_id}: invalid wheel archive")
    try:
        with zipfile.ZipFile(path) as archive:
            entries = bounded_zip_entries(
                archive,
                f"{package_id}: invalid wheel entries",
            )
            metadata_names = [
                entry
                for entry in entries
                if entry.filename.endswith(".dist-info/METADATA")
            ]
            if len(metadata_names) != 1:
                fail(f"{package_id}: expected one wheel metadata file")
            with archive.open(metadata_names[0]) as source:
                raw = read_member(
                    source,
                    metadata_names[0].file_size,
                    MAX_PACKAGE_METADATA_BYTES,
                    f"{package_id}: invalid wheel entries",
                )
            parse_metadata(raw, package_id, version)
    except (EOFError, OSError, RuntimeError, zipfile.BadZipFile):
        fail(f"{package_id}: invalid wheel archive")


def validate_sdist(path: Path, package_id: str, version: str) -> None:
    preflight_sdist(path, f"{package_id}: invalid source archive")
    try:
        with tarfile.open(path, "r:gz") as archive:
            members = bounded_tar_members(
                archive,
                f"{package_id}: invalid source archive entries",
            )
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
            raw = read_member(
                source,
                metadata_members[0].size,
                MAX_PACKAGE_METADATA_BYTES,
                f"{package_id}: invalid source archive entries",
            )
            parse_metadata(raw, package_id, version)
    except (EOFError, OSError, tarfile.TarError):
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


def expected_relative_artifact(
    package: PackageSpec,
    version: str,
    kind: str,
) -> PurePosixPath:
    suffix = "-py3-none-any.whl" if kind == "wheel" else ".tar.gz"
    return (
        PurePosixPath(package.directory) / f"{package.filename_name}-{version}{suffix}"
    )


def manifest_versions(manifest: dict[str, Any]) -> dict[str, str]:
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        fail("invalid Python release manifest schema")
    source_commit = manifest.get("sourceCommit")
    packages = manifest.get("packages")
    if (
        not isinstance(source_commit, str)
        or SOURCE_COMMIT.fullmatch(source_commit) is None
        or not isinstance(packages, list)
        or len(packages) != len(CATALOG)
    ):
        fail("invalid Python release manifest")

    versions: dict[str, str] = {}
    for package, entry in zip(CATALOG, packages, strict=True):
        if not isinstance(entry, dict) or set(entry) != {
            "id",
            "version",
            "wheel",
            "sdist",
        }:
            fail("invalid Python release manifest package order")
        version = entry.get("version")
        if (
            entry.get("id") != package.package_id
            or not isinstance(version, str)
            or VERSION.fullmatch(version) is None
        ):
            fail("invalid Python release manifest package")
        for kind in ("wheel", "sdist"):
            artifact = entry.get(kind)
            expected = expected_relative_artifact(package, version, kind)
            if (
                not isinstance(artifact, dict)
                or set(artifact) != {"file", "sha256"}
                or artifact.get("file") != expected.as_posix()
                or DIGEST.fullmatch(str(artifact.get("sha256", ""))) is None
            ):
                fail("invalid Python release manifest artifact")
        versions[package.package_id] = version
    return versions


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
    versions = manifest_versions(manifest)
    try:
        for package, entry in zip(CATALOG, manifest["packages"], strict=True):
            wheel, sdist = expected_artifacts(
                directory,
                package,
                versions[package.package_id],
            )
            for kind, path in (("wheel", wheel), ("sdist", sdist)):
                if not path.is_file() or sha256(path) != entry[kind]["sha256"]:
                    fail("Python release artifact digest or metadata mismatch")
    except OSError:
        fail("Python release artifact digest or metadata mismatch")
    expected = create_manifest(directory, versions, manifest["sourceCommit"])
    if manifest != expected:
        fail("Python release artifact digest or metadata mismatch")


def validate_manifest_identity(
    manifest: dict[str, Any],
    versions: dict[str, str],
    source_commit: str,
) -> None:
    if (
        manifest_versions(manifest) != versions
        or manifest.get("sourceCommit") != source_commit
    ):
        fail("Python release manifest identity mismatch")


def canonical_archive_digest(path: Path, kind: str) -> str:
    digest = hashlib.sha256()
    try:
        if kind == "wheel":
            preflight_zip(path, "public artifact verification failed")
            with zipfile.ZipFile(path) as archive:
                entries = bounded_zip_entries(
                    archive,
                    "public artifact verification failed",
                )
                for entry in sorted(
                    (entry for entry in entries if not entry.is_dir()),
                    key=lambda item: item.filename,
                ):
                    update_archive_record(digest, entry.filename, entry.file_size)
                    with archive.open(entry) as source:
                        hash_member(
                            source,
                            entry.file_size,
                            digest,
                            "public artifact verification failed",
                        )
        else:
            preflight_sdist(path, "public artifact verification failed")
            with tarfile.open(path, "r:gz") as archive:
                members = bounded_tar_members(
                    archive,
                    "public artifact verification failed",
                )
                for member in sorted(
                    (member for member in members if member.isfile()),
                    key=lambda item: item.name,
                ):
                    update_archive_record(digest, member.name, member.size)
                    source = archive.extractfile(member)
                    if source is None:
                        fail("public artifact verification failed")
                    hash_member(
                        source,
                        member.size,
                        digest,
                        "public artifact verification failed",
                    )
    except (EOFError, OSError, RuntimeError, tarfile.TarError, zipfile.BadZipFile):
        fail("public artifact verification failed")
    return digest.hexdigest()


def update_archive_record(digest: Any, name: str, size: int) -> None:
    encoded = name.encode("utf-8")
    digest.update(len(encoded).to_bytes(8, "big"))
    digest.update(encoded)
    digest.update(size.to_bytes(8, "big"))


def open_bounded(
    request: urllib.request.Request,
    limit: int,
    timeout: int,
    opener: Any | None,
) -> bytes:
    open_request = opener or urllib.request.build_opener(RejectRedirects()).open
    try:
        with open_request(request, timeout=timeout) as response:
            if response.getcode() != 200 or response.geturl() != request.full_url:
                fail("public artifact verification failed")
            body = response.read(limit + 1)
    except (
        OSError,
        urllib.error.HTTPError,
        urllib.error.URLError,
        ValueError,
    ):
        fail("public artifact verification failed")
    if len(body) > limit:
        fail("public artifact verification failed")
    return body


def validate_public_file_url(raw_url: Any, expected_filename: str) -> str:
    if not isinstance(raw_url, str):
        fail("public artifact verification failed")
    parsed = urllib.parse.urlsplit(raw_url)
    path = PurePosixPath(parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.netloc != PYPI_FILE_ORIGIN
        or parsed.query
        or parsed.fragment
        or "%" in parsed.path
        or not parsed.path.startswith("/")
        or ".." in path.parts
        or path.name != expected_filename
    ):
        fail("public artifact verification failed")
    return raw_url


def fetch_public_metadata(
    package: PackageSpec,
    version: str,
    opener: Any | None,
) -> dict[str, dict[str, str]]:
    encoded_id = urllib.parse.quote(package.package_id, safe="")
    encoded_version = urllib.parse.quote(version, safe="")
    request = urllib.request.Request(
        f"{PYPI_API_ROOT}/{encoded_id}/{encoded_version}/json",
        headers={"User-Agent": "LogBrew public package reconciliation"},
    )
    raw = open_bounded(request, MAX_METADATA_BYTES, 30, opener)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        fail("public artifact verification failed")
    info = payload.get("info") if isinstance(payload, dict) else None
    urls = payload.get("urls") if isinstance(payload, dict) else None
    if (
        not isinstance(info, dict)
        or info.get("name") != package.package_id
        or info.get("version") != version
        or not isinstance(urls, list)
    ):
        fail("public artifact verification failed")

    expected = {
        expected_relative_artifact(package, version, kind).name: kind
        for kind in ("wheel", "sdist")
    }
    records: dict[str, dict[str, str]] = {}
    for entry in urls:
        if not isinstance(entry, dict):
            fail("public artifact verification failed")
        filename = entry.get("filename")
        if (
            not isinstance(filename, str)
            or filename not in expected
            or filename in records
        ):
            fail("public artifact verification failed")
        digest = entry.get("digests")
        sha256_digest = digest.get("sha256") if isinstance(digest, dict) else None
        package_type = "bdist_wheel" if expected[filename] == "wheel" else "sdist"
        if (
            entry.get("packagetype") != package_type
            or not isinstance(sha256_digest, str)
            or DIGEST.fullmatch(sha256_digest) is None
        ):
            fail("public artifact verification failed")
        records[filename] = {
            "sha256": sha256_digest,
            "url": validate_public_file_url(entry.get("url"), filename),
        }
    if set(records) != set(expected):
        fail("public artifact verification failed")
    return records


def download_public_artifact(
    record: dict[str, str],
    destination: Path,
    opener: Any | None,
) -> str:
    request = urllib.request.Request(
        record["url"],
        headers={"User-Agent": "LogBrew public package reconciliation"},
    )
    body = open_bounded(request, MAX_ARTIFACT_BYTES, 60, opener)
    digest = hashlib.sha256(body).hexdigest()
    if digest != record["sha256"]:
        fail("public artifact verification failed")
    destination.write_bytes(body)
    return digest


def resolve_public_artifacts(
    manifest_path: Path,
    built_directory: Path,
    output_directory: Path,
    public_manifest_path: Path,
    reconciliation_path: Path,
    *,
    opener: Any | None = None,
) -> None:
    manifest = load_manifest(manifest_path)
    versions = manifest_versions(manifest)
    validate_manifest(built_directory, manifest)
    if output_directory.exists() or output_directory.is_symlink():
        fail("public artifact verification failed")
    output_directory.parent.mkdir(parents=True, exist_ok=True)

    temporary = Path(
        tempfile.mkdtemp(prefix=".python-public.", dir=output_directory.parent)
    )
    records: list[dict[str, Any]] = []
    try:
        for package, manifest_entry in zip(CATALOG, manifest["packages"], strict=True):
            version = versions[package.package_id]
            metadata = fetch_public_metadata(package, version, opener)
            package_root = temporary / package.directory
            package_root.mkdir()
            artifact_records: dict[str, dict[str, str]] = {}
            for kind in ("wheel", "sdist"):
                relative = expected_relative_artifact(package, version, kind)
                destination = temporary.joinpath(*relative.parts)
                registry = metadata[relative.name]
                public_digest = download_public_artifact(registry, destination, opener)
                built_path = built_directory.joinpath(*relative.parts)
                built_content = canonical_archive_digest(built_path, kind)
                public_content = canonical_archive_digest(destination, kind)
                if public_content != built_content:
                    fail("public artifact verification failed")
                artifact_records[kind] = {
                    "file": relative.as_posix(),
                    "sha256": public_digest,
                    "registrySha256": registry["sha256"],
                    "contentSha256": public_content,
                    "publicationState": (
                        "source-build"
                        if public_digest == manifest_entry[kind]["sha256"]
                        else "existing"
                    ),
                }
            records.append(
                {
                    "id": package.package_id,
                    "version": version,
                    **artifact_records,
                }
            )
        public_manifest = create_manifest(
            temporary,
            versions,
            manifest["sourceCommit"],
        )
        os.replace(temporary, output_directory)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)

    write_manifest(public_manifest, public_manifest_path)
    write_manifest(
        {
            "schemaVersion": PUBLIC_RECONCILIATION_SCHEMA_VERSION,
            "sourceCommit": manifest["sourceCommit"],
            "packages": records,
        },
        reconciliation_path,
    )


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
    check_manifest = commands.add_parser("check-manifest")
    check_manifest.add_argument("--manifest", type=Path, required=True)
    check_manifest.add_argument("--source-commit", required=True)
    check_manifest.add_argument("--python-version", action="append", default=[])
    resolve = commands.add_parser("resolve-public")
    resolve.add_argument("--directory", type=Path, required=True)
    resolve.add_argument("--manifest", type=Path, required=True)
    resolve.add_argument("--output-directory", type=Path, required=True)
    resolve.add_argument("--public-manifest", type=Path, required=True)
    resolve.add_argument("--reconciliation", type=Path, required=True)
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
        elif args.command == "verify":
            validate_manifest(args.directory, load_manifest(args.manifest))
        elif args.command == "check-manifest":
            validate_manifest_identity(
                load_manifest(args.manifest),
                parse_versions(args.python_version),
                args.source_commit,
            )
        else:
            resolve_public_artifacts(
                args.manifest,
                args.directory,
                args.output_directory,
                args.public_manifest,
                args.reconciliation,
            )
    except ValueError as error:
        print(f"Python release artifacts failed: {error}", file=sys.stderr)
        return 1
    print("python release artifacts ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
