#!/usr/bin/env python3
"""Bind exact release artifacts for installed-package receipt smokes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import NoReturn


MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 20_000
COPY_CHUNK_BYTES = 1024 * 1024
DIGEST_PREFIX = "sha256:"


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    filename: str


FAMILIES = {
    "crates": (Artifact("crates:logbrew", "0.crate"),),
    "go": (Artifact("go:github.com/LogBrewCo/sdk/go/logbrew", "0.zip"),),
    "maven": (Artifact("maven:co.logbrew:logbrew-sdk", "0.jar"),),
    "nuget": (
        Artifact("nuget:LogBrew", "0.nupkg"),
        Artifact("nuget:LogBrew.HttpClient", "1.nupkg"),
    ),
    "packagist": (Artifact("packagist:logbrew/sdk", "0.zip"),),
    "pypi": (
        Artifact("pypi:logbrew-sdk", "0.whl"),
        Artifact("pypi:logbrew-fastapi", "1.whl"),
        Artifact("pypi:logbrew-flask", "2.whl"),
        Artifact("pypi:logbrew-django", "3.whl"),
    ),
    "rubygems": (Artifact("rubygems:logbrew-sdk", "0.gem"),),
    "swiftpm": (Artifact("swiftpm:LogBrewCo/sdk", "0.archive"),),
}


class ReceiptError(ValueError):
    """Raised when artifact receipt input is not exact and safe."""


def fail() -> NoReturn:
    raise ReceiptError


def family_artifacts(family: str) -> tuple[Artifact, ...]:
    artifacts = FAMILIES.get(family)
    if artifacts is None:
        fail()
    return artifacts


def load_supplied(artifacts: tuple[Artifact, ...]) -> dict[str, str]:
    try:
        supplied = json.loads(os.environ.get("LOGBREW_RELEASE_ARTIFACT_FILES_JSON", ""))
    except (json.JSONDecodeError, TypeError):
        fail()
    expected_ids = [artifact.artifact_id for artifact in artifacts]
    if (
        not isinstance(supplied, dict)
        or list(supplied) != expected_ids
        or any(not isinstance(supplied.get(artifact_id), str) for artifact_id in expected_ids)
    ):
        fail()
    return supplied


def copy_bound_artifact(source: Path, destination: Path) -> str:
    if not source.is_absolute() or not hasattr(os, "O_NOFOLLOW"):
        fail()
    try:
        source_metadata = source.lstat()
        if stat.S_ISLNK(source_metadata.st_mode) or not stat.S_ISREG(source_metadata.st_mode):
            fail()
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        fail()

    digest = hashlib.sha256()
    destination_fd: int | None = None
    try:
        opened_metadata = os.fstat(source_fd)
        if (
            not stat.S_ISREG(opened_metadata.st_mode)
            or opened_metadata.st_dev != source_metadata.st_dev
            or opened_metadata.st_ino != source_metadata.st_ino
            or opened_metadata.st_size <= 0
            or opened_metadata.st_size > MAX_ARTIFACT_BYTES
        ):
            fail()
        destination_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        copied = 0
        while True:
            chunk = os.read(source_fd, COPY_CHUNK_BYTES)
            if not chunk:
                break
            copied += len(chunk)
            if copied > MAX_ARTIFACT_BYTES:
                fail()
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    fail()
                view = view[written:]
        if copied != opened_metadata.st_size:
            fail()
        os.fsync(destination_fd)
    except OSError:
        fail()
    finally:
        if destination_fd is not None:
            os.close(destination_fd)
        os.close(source_fd)
    return DIGEST_PREFIX + digest.hexdigest()


def atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def bind(family: str, output_dir: Path, metadata_path: Path) -> None:
    artifacts = family_artifacts(family)
    supplied = load_supplied(artifacts)
    try:
        output_dir.mkdir(mode=0o700)
    except OSError:
        fail()
    bound = []
    try:
        for artifact in artifacts:
            destination = output_dir / artifact.filename
            digest = copy_bound_artifact(Path(supplied[artifact.artifact_id]), destination)
            bound.append(
                {
                    "id": artifact.artifact_id,
                    "digest": digest,
                    "file": str(destination.absolute()),
                }
            )
        atomic_json(metadata_path, {"schema_version": 1, "family": family, "artifacts": bound})
    except (OSError, ReceiptError):
        fail()


def digest_regular_file(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        fail()
    try:
        size = path.stat().st_size
        if size <= 0 or size > MAX_ARTIFACT_BYTES:
            fail()
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(COPY_CHUNK_BYTES):
                digest.update(chunk)
    except OSError:
        fail()
    return DIGEST_PREFIX + digest.hexdigest()


def load_metadata(family: str, metadata_path: Path) -> list[dict[str, str]]:
    artifacts = family_artifacts(family)
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail()
    entries = payload.get("artifacts") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or set(payload) != {"schema_version", "family", "artifacts"}
        or payload.get("schema_version") != 1
        or payload.get("family") != family
        or not isinstance(entries, list)
        or len(entries) != len(artifacts)
    ):
        fail()
    validated = []
    for expected, entry in zip(artifacts, entries, strict=True):
        if (
            not isinstance(entry, dict)
            or set(entry) != {"id", "digest", "file"}
            or entry.get("id") != expected.artifact_id
            or not isinstance(entry.get("digest"), str)
            or not isinstance(entry.get("file"), str)
            or not Path(entry["file"]).is_absolute()
            or digest_regular_file(Path(entry["file"])) != entry["digest"]
        ):
            fail()
        validated.append(entry)
    return validated


def attest(family: str, metadata_path: Path) -> None:
    entries = load_metadata(family, metadata_path)
    payload = {
        "schema_version": 1,
        "status": "passed",
        "artifacts": [
            {"id": entry["id"], "digest": entry["digest"]} for entry in entries
        ],
    }
    print(json.dumps(payload, separators=(",", ":")))


def member_path(output_dir: Path, raw_name: str) -> Path:
    path = PurePosixPath(raw_name)
    if not raw_name or "\\" in raw_name or path.is_absolute() or ".." in path.parts:
        fail()
    return output_dir.joinpath(*path.parts)


def write_member(destination: Path, source: object, size: int) -> None:
    if size < 0 or size > MAX_EXTRACTED_BYTES:
        fail()
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        with os.fdopen(descriptor, "wb") as output:
            copied = 0
            while True:
                chunk = source.read(COPY_CHUNK_BYTES)  # type: ignore[attr-defined]
                if not chunk:
                    break
                copied += len(chunk)
                if copied > size or copied > MAX_EXTRACTED_BYTES:
                    fail()
                output.write(chunk)
            if copied != size:
                fail()
    except OSError:
        fail()


def extract_tar(archive_path: Path, output_dir: Path) -> None:
    total = 0
    try:
        with tarfile.open(archive_path, mode="r:*") as archive:
            members = archive.getmembers()
            if not members or len(members) > MAX_ARCHIVE_ENTRIES:
                fail()
            for member in members:
                destination = member_path(output_dir, member.name)
                if member.isdir():
                    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    fail()
                total += member.size
                if total > MAX_EXTRACTED_BYTES:
                    fail()
                source = archive.extractfile(member)
                if source is None:
                    fail()
                with source:
                    write_member(destination, source, member.size)
    except (OSError, tarfile.TarError):
        fail()


def extract_zip(archive_path: Path, output_dir: Path) -> None:
    total = 0
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if not members or len(members) > MAX_ARCHIVE_ENTRIES:
                fail()
            for member in members:
                destination = member_path(output_dir, member.filename)
                unix_mode = member.external_attr >> 16
                if unix_mode and stat.S_ISLNK(unix_mode):
                    fail()
                if member.is_dir():
                    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                total += member.file_size
                if total > MAX_EXTRACTED_BYTES:
                    fail()
                with archive.open(member, "r") as source:
                    write_member(destination, source, member.file_size)
    except (OSError, zipfile.BadZipFile):
        fail()


def extract(family: str, metadata_path: Path, index: int, output_dir: Path) -> None:
    entries = load_metadata(family, metadata_path)
    if index < 0 or index >= len(entries):
        fail()
    try:
        output_dir.mkdir(mode=0o700)
    except OSError:
        fail()
    archive_path = Path(entries[index]["file"])
    if zipfile.is_zipfile(archive_path):
        extract_zip(archive_path, output_dir)
    else:
        extract_tar(archive_path, output_dir)


def parser() -> argparse.ArgumentParser:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    commands = argument_parser.add_subparsers(dest="command", required=True)
    ids = commands.add_parser("ids")
    ids.add_argument("--family", choices=sorted(FAMILIES), required=True)
    binder = commands.add_parser("bind")
    binder.add_argument("--family", choices=sorted(FAMILIES), required=True)
    binder.add_argument("--output-dir", type=Path, required=True)
    binder.add_argument("--metadata", type=Path, required=True)
    attester = commands.add_parser("attest")
    attester.add_argument("--family", choices=sorted(FAMILIES), required=True)
    attester.add_argument("--metadata", type=Path, required=True)
    extractor = commands.add_parser("extract")
    extractor.add_argument("--family", choices=sorted(FAMILIES), required=True)
    extractor.add_argument("--metadata", type=Path, required=True)
    extractor.add_argument("--index", type=int, required=True)
    extractor.add_argument("--output-dir", type=Path, required=True)
    return argument_parser


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "ids":
            for artifact in family_artifacts(args.family):
                print(artifact.artifact_id)
        elif args.command == "bind":
            bind(args.family, args.output_dir, args.metadata)
        elif args.command == "attest":
            attest(args.family, args.metadata)
        else:
            extract(args.family, args.metadata, args.index, args.output_dir)
    except ReceiptError:
        print("release artifact binding failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
