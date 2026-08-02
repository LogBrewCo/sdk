#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


FORBIDDEN_TEXT = (
    "sensitive provider response fixture",
    "exceptionBacktrace",
)


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text().strip())
    if not isinstance(value, dict):
        raise SystemExit(f"expected a JSON object in {path}")
    return value


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def check_payload(payload_path: Path, stderr_path: Path) -> None:
    payload_text = payload_path.read_text()
    for unsafe in FORBIDDEN_TEXT:
        _require(unsafe not in payload_text, f"Ruby issue diagnostics leaked unsafe text: {unsafe}")

    payload = _load_json(payload_path)
    events = payload.get("events")
    _require(isinstance(events, list) and len(events) == 1, "expected one Ruby issue event")
    event = events[0]
    _require(isinstance(event, dict) and event.get("type") == "issue", "expected a Ruby issue event")
    attributes = event.get("attributes")
    _require(isinstance(attributes, dict), "expected Ruby issue attributes")
    _require(attributes.get("title") == "RuntimeError", "expected Ruby exception title")
    _require(attributes.get("message") == "Checkout could not be completed.", "expected explicit safe issue message")
    _require(
        attributes.get("exception")
        == {
            "type": "RuntimeError",
            "mechanism": {"type": "ruby.exception", "handled": True},
        },
        "expected typed Ruby exception mechanism",
    )

    frames = attributes.get("stackFrames")
    _require(isinstance(frames, list) and 1 <= len(frames) <= 32, "expected bounded Ruby stack frames")
    for frame in frames:
        _require(isinstance(frame, dict), "expected Ruby stack frame object")
        filename = frame.get("filename")
        _require(
            isinstance(filename, str) and "/" not in filename and "\\" not in filename,
            "expected every Ruby stack frame filename to be basename-only",
        )
    first_frame = frames[0]
    _require(first_frame.get("filename") == "issue_diagnostics.rb", "expected basename-only Ruby throw frame")
    _require(first_frame.get("function") == "fail_checkout", "expected Ruby throw function")
    _require(
        isinstance(first_frame.get("line"), int)
        and first_frame["line"] > 0
        and first_frame.get("column") == 1,
        "expected positive Ruby frame coordinates",
    )

    breadcrumbs = attributes.get("breadcrumbs")
    _require(isinstance(breadcrumbs, list) and len(breadcrumbs) == 2, "expected Ruby breadcrumbs")
    _require(
        breadcrumbs[0].get("category") == "checkout.navigation"
        and breadcrumbs[1].get("category") == "checkout.request",
        "expected oldest-first Ruby breadcrumbs",
    )
    _require(breadcrumbs[1].get("level") == "warning", "expected normalized Ruby breadcrumb level")
    _require(
        attributes.get("metadata", {}).get("routeTemplate") == "/checkout/:cart_id",
        "expected stable Ruby issue metadata",
    )

    summary = _load_json(stderr_path)
    _require(
        summary.get("ok") is True and summary.get("status") == 202 and summary.get("events") == 1,
        f"unexpected Ruby issue diagnostics summary: {summary!r}",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the Ruby issue diagnostics example output.")
    parser.add_argument("payload", type=Path)
    parser.add_argument("stderr", type=Path)
    args = parser.parse_args()
    check_payload(args.payload, args.stderr)
    print("ruby issue diagnostics payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
