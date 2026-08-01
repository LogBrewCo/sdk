from __future__ import annotations

import json
import re
import sys
from pathlib import Path


SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
CARET_RE = re.compile(r"^\^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


def parse_version(value: str, pattern: re.Pattern[str]) -> tuple[int, int, int] | None:
    match = pattern.fullmatch(value)
    if match is None:
        return None
    return tuple(int(part) for part in match.groups())


def caret_range_allows(range_text: str, version_text: str) -> bool:
    lower = parse_version(range_text, CARET_RE)
    version = parse_version(version_text, SEMVER_RE)
    if lower is None or version is None:
        return False
    major, minor, patch = lower
    if major > 0:
        upper = (major + 1, 0, 0)
    elif minor > 0:
        upper = (0, minor + 1, 0)
    else:
        upper = (0, 0, patch + 1)
    return lower <= version < upper


def validate(manifest_path: Path, expected_versions: dict[str, str]) -> list[str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    peers = manifest.get("peerDependencies", {})
    failures: list[str] = []
    for package_name, version in expected_versions.items():
        range_text = peers.get(package_name)
        if not isinstance(range_text, str) or not caret_range_allows(range_text, version):
            failures.append(
                f"{manifest_path}: peer {package_name} range {range_text!r} does not include {version}"
            )
    return failures


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(
            "usage: check_npm_peer_compatibility.py MANIFEST PACKAGE=VERSION [...]",
            file=sys.stderr,
        )
        return 2
    expected_versions: dict[str, str] = {}
    for requirement in argv[2:]:
        if "=" not in requirement:
            print(f"invalid package requirement: {requirement!r}", file=sys.stderr)
            return 2
        package_name, version = requirement.rsplit("=", 1)
        if not package_name or parse_version(version, SEMVER_RE) is None:
            print(f"invalid package requirement: {requirement!r}", file=sys.stderr)
            return 2
        expected_versions[package_name] = version

    failures = validate(Path(argv[1]), expected_versions)
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("npm peer compatibility ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
