#!/usr/bin/env python3
"""Print release notes for one package from the commits that touched its directory."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

SECTIONS = (("feat", "Added"), ("fix", "Fixed"), ("perf", "Faster"))
SUBJECT = re.compile(r"^(?P<type>[a-z]+)(?:\([^)]*\))?!?: (?P<text>.+)$")


def commit_subjects(path: str, since: str, until: str) -> list[str]:
    result = subprocess.run(
        ["git", "log", "--no-merges", "--reverse", "--format=%s", f"{since}..{until}", "--", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.splitlines()


def release_notes(path: str, since: str, until: str) -> str:
    grouped: dict[str, list[str]] = {kind: [] for kind, _ in SECTIONS}
    for subject in commit_subjects(path, since, until):
        match = SUBJECT.match(subject)
        if match and match["type"] in grouped:
            grouped[match["type"]].append(match["text"])
    lines: list[str] = []
    for kind, heading in SECTIONS:
        if grouped[kind]:
            lines += [f"### {heading}", *(f"- {text}" for text in grouped[kind]), ""]
    return "\n".join(lines) if lines else "Maintenance release with no behavior changes.\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="package directory, such as go/logbrew")
    parser.add_argument("--since", required=True, help="previous release tag or commit")
    parser.add_argument("--until", default="HEAD", help="release commit (default: HEAD)")
    args = parser.parse_args()
    sys.stdout.write(release_notes(args.path, args.since, args.until))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
