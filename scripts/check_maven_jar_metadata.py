#!/usr/bin/env python3
"""Validate the exact public Maven coordinates embedded in a release JAR."""

from __future__ import annotations

import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import NoReturn


GROUP_ID = "co.logbrew"
ARTIFACT_ID = "logbrew-sdk"
POM_NAMESPACE = "http://maven.apache.org/POM/4.0.0"
POM_PATH = f"META-INF/maven/{GROUP_ID}/{ARTIFACT_ID}/pom.xml"
MAX_ARCHIVE_ENTRIES = 20_000
MAX_POM_BYTES = 256 * 1024
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?")


class MetadataError(ValueError):
    """Raised when embedded Maven coordinates are not exact."""


def fail() -> NoReturn:
    raise MetadataError


def coordinate(project: ET.Element, name: str) -> str:
    expected_tag = f"{{{POM_NAMESPACE}}}{name}"
    matches = [
        child
        for child in project
        if child.tag.rsplit("}", 1)[-1] == name
    ]
    if len(matches) != 1 or matches[0].tag != expected_tag or list(matches[0]):
        fail()
    value = (matches[0].text or "").strip()
    if not value:
        fail()
    return value


def validate(jar_path: Path, expected_version: str) -> None:
    if VERSION.fullmatch(expected_version) is None or jar_path.is_symlink() or not jar_path.is_file():
        fail()
    with zipfile.ZipFile(jar_path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES:
            fail()
        pom_entries = [
            entry
            for entry in entries
            if entry.filename.startswith("META-INF/maven/")
            and entry.filename.endswith("/pom.xml")
            and not entry.is_dir()
        ]
        if len(pom_entries) != 1 or pom_entries[0].filename != POM_PATH:
            fail()
        if not 0 < pom_entries[0].file_size <= MAX_POM_BYTES:
            fail()
        with archive.open(pom_entries[0]) as pom:
            document = pom.read(MAX_POM_BYTES + 1)
        if len(document) > MAX_POM_BYTES:
            fail()

    try:
        pom_text = document.decode("utf-8-sig")
    except UnicodeDecodeError:
        fail()
    if "<!DOCTYPE" in pom_text or "<!ENTITY" in pom_text:
        fail()

    project = ET.fromstring(pom_text)
    if project.tag != f"{{{POM_NAMESPACE}}}project":
        fail()
    if coordinate(project, "groupId") != GROUP_ID:
        fail()
    if coordinate(project, "artifactId") != ARTIFACT_ID:
        fail()
    if coordinate(project, "version") != expected_version:
        fail()


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("Maven JAR metadata validation failed", file=sys.stderr)
        return 1
    try:
        validate(Path(argv[1]), argv[2])
    except (
        MetadataError,
        OSError,
        RuntimeError,
        NotImplementedError,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        ET.ParseError,
    ):
        print("Maven JAR metadata validation failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
