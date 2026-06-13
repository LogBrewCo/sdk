#!/usr/bin/env python3
"""Validate backend contract reports created from SDK findings."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REPORT_DIR = Path("docs/backend-contracts")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
PRIORITY_RE = re.compile(r"\bP[0-3]\b")
HANDOFF_RE = re.compile(
    r"\b(backend handoff is pending|sent to backend|backend automation/thread)\b",
    re.IGNORECASE,
)

REQUIRED_SECTIONS = (
    "Status",
    "Priority",
    "User Impact",
    "Expected Backend Capability",
    "SDK Gap Observed",
    "Verification Needed",
)


def markdown_sections(text: str) -> dict[str, str]:
    matches = list(HEADING_RE.finditer(text))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        level, title = match.groups()
        if level != "##":
            continue
        start = match.end()
        end = len(text)
        for candidate in matches[index + 1 :]:
            if len(candidate.group(1)) <= len(level):
                end = candidate.start()
                break
        sections[title.strip()] = text[start:end].strip()
    return sections


def validate_report(path: Path, root: Path) -> list[str]:
    relative = path.relative_to(root)
    text = path.read_text(encoding="utf-8")
    failures: list[str] = []

    if not text.startswith("# Backend Contract Report:"):
        failures.append(f"{relative}: title must start with '# Backend Contract Report:'")

    sections = markdown_sections(text)
    for section in REQUIRED_SECTIONS:
        if section not in sections:
            failures.append(f"{relative}: missing required '## {section}' section")
        elif not sections[section]:
            failures.append(f"{relative}: '## {section}' section must not be empty")

    status = sections.get("Status", "")
    if status and HANDOFF_RE.search(status) is None:
        failures.append(
            f"{relative}: Status must state backend handoff is pending or sent to backend automation/thread"
        )

    priority = sections.get("Priority", "")
    if priority and PRIORITY_RE.search(priority) is None:
        failures.append(f"{relative}: Priority must include P0, P1, P2, or P3")

    expected = sections.get("Expected Backend Capability", "")
    expected_markers = ("Suggested APIs", "Suggested API", "event", "fields", "Runtime telemetry")
    if expected and not any(marker in expected for marker in expected_markers):
        failures.append(
            f"{relative}: Expected Backend Capability must include suggested APIs, event fields, or runtime matching fields"
        )

    verification = sections.get("Verification Needed", "")
    if verification and not re.search(r"\b(tests?|verifiers?|proof|smoke)\b", verification, re.IGNORECASE):
        failures.append(
            f"{relative}: Verification Needed must include concrete test, verifier, proof, or smoke expectations"
        )

    return failures


def validate(root: Path) -> list[str]:
    report_dir = root / REPORT_DIR
    if not report_dir.exists():
        return [f"missing backend contract report directory: {REPORT_DIR}"]

    reports = sorted(report_dir.glob("*.md"))
    if not reports:
        return [f"no backend contract reports found in {REPORT_DIR}"]

    failures: list[str] = []
    for report in reports:
        failures.extend(validate_report(report, root))
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate SDK-originated backend contract reports.")
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args()

    failures = validate(args.root.resolve())
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print("backend contract reports ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
