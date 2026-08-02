#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from pathlib import PurePath


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: check_dotnet_issue_diagnostics_payload.py <payload> <stderr>",
            file=sys.stderr,
        )
        return 2

    with open(sys.argv[1], encoding="utf-8") as payload_file:
        payload = json.load(payload_file)
    with open(sys.argv[2], encoding="utf-8") as stderr_file:
        stderr = stderr_file.read()

    events = payload.get("events")
    if not isinstance(events, list) or len(events) != 1:
        raise SystemExit("expected one issue event")
    event = events[0]
    if event.get("type") != "issue" or event.get("id") != "evt_issue_dotnet_diagnostics":
        raise SystemExit("unexpected issue identity")

    attributes = event.get("attributes")
    if not isinstance(attributes, dict):
        raise SystemExit("missing issue attributes")
    exception = attributes.get("exception")
    if exception != {
        "type": "System.InvalidOperationException",
        "mechanism": {"type": "dotnet.example", "handled": True},
    }:
        raise SystemExit("unexpected typed exception diagnostics")
    if "message" in attributes or "private runtime detail" in json.dumps(payload):
        raise SystemExit("automatic exception projection leaked its message")

    frames = attributes.get("stackFrames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= 32:
        raise SystemExit("expected 1-32 structured frames")
    for frame in frames:
        filename = frame.get("filename")
        if not isinstance(filename, str) or not filename:
            raise SystemExit("missing frame filename")
        if PurePath(filename).name != filename or any(mark in filename for mark in ("/", "\\", "?", "#")):
            raise SystemExit("frame filename must be basename-only")
        if not isinstance(frame.get("line"), int) or frame["line"] < 1:
            raise SystemExit("invalid frame line")
        if not isinstance(frame.get("column"), int) or frame["column"] < 1:
            raise SystemExit("invalid frame column")

    breadcrumbs = attributes.get("breadcrumbs")
    if not isinstance(breadcrumbs, list) or [item.get("category") for item in breadcrumbs] != [
        "checkout.request",
        "checkout.retry",
    ]:
        raise SystemExit("breadcrumbs must preserve oldest-to-newest order")
    if breadcrumbs[1].get("level") != "warning" or breadcrumbs[1].get("data") != {
        "attempt": 2,
        "retryable": True,
    }:
        raise SystemExit("unexpected breadcrumb normalization or data")
    if attributes.get("breadcrumbsTruncated") is not True:
        raise SystemExit("missing breadcrumb truncation marker")
    if '"ok":true' not in stderr or '"events":1' not in stderr:
        raise SystemExit("missing issue diagnostics delivery receipt")

    print("dotnet issue diagnostics payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
