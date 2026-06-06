from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


MAVEN_NS = {"m": "http://maven.apache.org/POM/4.0.0"}


def child_text(root: ET.Element, path: str) -> str:
    node = root.find(path, MAVEN_NS)
    return "" if node is None or node.text is None else node.text.strip()


def require_text(root: ET.Element, path: str, label: str, failures: list[str]) -> None:
    if not child_text(root, path):
        failures.append(label)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate the Maven Central metadata that users see before install."
    )
    parser.add_argument("pom", type=Path)
    parser.add_argument("--group-id", required=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()

    root = ET.parse(args.pom).getroot()
    failures: list[str] = []

    expected_coordinates = {
        "m:groupId": args.group_id,
        "m:artifactId": args.artifact_id,
        "m:version": args.version,
    }
    for path, expected in expected_coordinates.items():
        actual = child_text(root, path)
        if actual != expected:
            failures.append(f"{path}={actual!r}, expected {expected!r}")

    for path, label in (
        ("m:name", "project name"),
        ("m:description", "project description"),
        ("m:url", "project url"),
        ("m:licenses/m:license/m:name", "license name"),
        ("m:licenses/m:license/m:url", "license url"),
        ("m:developers/m:developer/m:name", "developer name"),
        ("m:scm/m:url", "scm url"),
    ):
        require_text(root, path, label, failures)

    if failures:
        print("missing or invalid Maven Central POM metadata:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("maven pom metadata checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
