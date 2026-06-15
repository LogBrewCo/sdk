#!/usr/bin/env python3
"""Validate the Rust tracing bridge preview payload."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load_json(path: str) -> object:
    return json.loads(Path(path).read_text())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_rust_tracing_payload.py STDOUT_JSON STDERR_JSON")

    payload = load_json(sys.argv[1])
    stderr = load_json(sys.argv[2])
    require(isinstance(payload, dict), "stdout payload must be an object")
    events = payload.get("events")
    require(isinstance(events, list), "stdout events must be a list")
    require([event.get("type") for event in events] == ["release", "environment", "log"], "unexpected events")

    log = events[2]["attributes"]
    require(log["message"] == "checkout tracing event accepted", "unexpected tracing log message")
    require(log["level"] == "info", "tracing info should normalize to canonical info")
    require(log["logger"] == "checkout", "tracing logger should use app-owned logger override")
    metadata = log["metadata"]
    require(metadata["tracingTarget"] == "checkout", "missing tracing target")
    require(metadata["tracingLevel"] == "INFO", "missing original tracing level")
    require(metadata["routeTemplate"] == "/checkout/{cart_id}", "routeTemplate was not sanitized")
    require(metadata["statusCode"] == 202, "missing status code")
    require(metadata["sampled"] is True, "missing sampled flag")
    require(metadata["cartTier"] == "gold", "missing allowed app field")
    require("unsafeDebug" not in metadata, "non-primitive debug field should not be captured")

    text = Path(sys.argv[1]).read_text().lower()
    for forbidden in [
        "coupon=sample",
        "#review",
        "authorization",
        "bearer sample",
        "requestbody",
        "card=sample",
        "debug-value",
    ]:
        require(forbidden not in text, f"unsafe text leaked: {forbidden}")

    require(stderr["ok"] is True, "stderr ok must be true")
    require(stderr["status"] == 202, "transport status must be 202")
    require(stderr["attempts"] == 1, "transport attempts must be 1")
    require(stderr["events"] == 3, "stderr event count must be 3")
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
