#!/usr/bin/env python3
"""Validate local Markdown links in the public SDK repository."""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import unquote


IGNORED_PARTS = {
    ".git",
    ".gradle",
    ".pytest_cache",
    ".ruff_cache",
    "bin",
    "build",
    "dist",
    "node_modules",
    "obj",
    "target",
    "vendor",
}
LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


def github_anchor(text: str) -> str:
    lowered = text.strip().lower()
    lowered = re.sub(r"<[^>]+>", "", lowered)
    lowered = re.sub(r"`([^`]*)`", r"\1", lowered)
    lowered = re.sub(r"[^\w\s-]", "", lowered, flags=re.UNICODE)
    lowered = re.sub(r"\s+", "-", lowered.strip())
    return lowered


def anchors_for(path: Path) -> set[str]:
    counts: Counter[str] = Counter()
    anchors: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        match = HEADING_RE.match(line)
        if not match:
            continue
        base = github_anchor(match.group(2))
        if not base:
            continue
        suffix = counts[base]
        counts[base] += 1
        anchors.add(base if suffix == 0 else f"{base}-{suffix}")
    return anchors


def iter_markdown_files(root: Path) -> list[Path]:
    markdown_files: list[Path] = []
    for path in root.rglob("*.md"):
        if any(part in IGNORED_PARTS for part in path.relative_to(root).parts):
            continue
        markdown_files.append(path)
    return sorted(markdown_files)


def is_external(target: str) -> bool:
    lowered = target.lower()
    return (
        lowered.startswith("http://")
        or lowered.startswith("https://")
        or lowered.startswith("mailto:")
        or lowered.startswith("tel:")
    )


def split_target(target: str) -> tuple[str, str]:
    path_part, separator, anchor = target.partition("#")
    return unquote(path_part), unquote(anchor) if separator else ""


def validate(root: Path) -> list[str]:
    failures: list[str] = []
    anchor_cache: dict[Path, set[str]] = {}
    markdown_files = iter_markdown_files(root)
    if not markdown_files:
        return ["no Markdown files found"]

    for markdown_file in markdown_files:
        relative_markdown = markdown_file.relative_to(root)
        for line_number, line in enumerate(markdown_file.read_text(encoding="utf-8").splitlines(), 1):
            for match in LINK_RE.finditer(line):
                raw_target = match.group(1).strip()
                if not raw_target or is_external(raw_target):
                    continue
                path_text, anchor = split_target(raw_target)
                target_path = markdown_file if not path_text else (markdown_file.parent / path_text)
                resolved = target_path.resolve()
                if not resolved.is_relative_to(root.resolve()):
                    failures.append(f"{relative_markdown}:{line_number}: link leaves repository: {raw_target}")
                    continue
                if not target_path.exists():
                    failures.append(f"{relative_markdown}:{line_number}: missing link target: {raw_target}")
                    continue
                if anchor and target_path.is_file() and target_path.suffix.lower() == ".md":
                    if target_path not in anchor_cache:
                        anchor_cache[target_path] = anchors_for(target_path)
                    if anchor not in anchor_cache[target_path]:
                        failures.append(f"{relative_markdown}:{line_number}: missing heading anchor #{anchor} in {target_path.relative_to(root)}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate local Markdown links.")
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    failures = validate(root)
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print("markdown links ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
