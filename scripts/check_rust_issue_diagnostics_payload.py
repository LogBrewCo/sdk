#!/usr/bin/env python3
"""Validate the deterministic Rust typed issue diagnostics example."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_rust_issue_diagnostics_payload.py <payload.json>")

    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    require(payload.get("sdk", {}).get("name") == "diagnostics-example", "unexpected SDK name")
    events = payload.get("events")
    require(isinstance(events, list) and len(events) == 2, "expected exactly two issues")
    require(all(event.get("type") == "issue" for event in events), "expected issue events")

    handled = events[0]
    require(handled.get("id") == "evt_rust_error", "unexpected handled issue ID")
    attributes = handled.get("attributes", {})
    exception_type = attributes.get("exception", {}).get("type")
    require(
        isinstance(exception_type, str) and exception_type.endswith("CheckoutFailure"),
        "expected concrete Rust error type",
    )
    require(attributes.get("title") == exception_type, "expected type-based issue title")
    require(attributes.get("level") == "error", "expected error severity")
    require("message" not in attributes, "automatic error text must remain absent")
    mechanism = attributes.get("exception", {}).get("mechanism", {})
    require(mechanism == {"type": "rust.example", "handled": True}, "unexpected mechanism")

    frames = attributes.get("stackFrames")
    require(isinstance(frames, list) and len(frames) == 1, "expected one caller frame")
    frame = frames[0]
    require(frame.get("filename") == "issue_diagnostics.rs", "expected basename-only frame")
    require(isinstance(frame.get("line"), int) and frame["line"] > 0, "expected frame line")
    require(isinstance(frame.get("column"), int) and frame["column"] > 0, "expected frame column")
    require(frame.get("function") == "checkout::submit", "unexpected frame function")
    require(frame.get("module") == "issue_diagnostics", "unexpected frame module")
    require(frame.get("inApp") is True, "expected in-app frame")

    breadcrumbs = attributes.get("breadcrumbs")
    require(isinstance(breadcrumbs, list) and len(breadcrumbs) == 2, "expected two breadcrumbs")
    require(
        [breadcrumb.get("category") for breadcrumb in breadcrumbs]
        == ["http.request", "database.query"],
        "breadcrumbs must remain oldest-to-newest",
    )
    require(
        breadcrumbs[0].get("data", {}).get("routeTemplate") == "/checkout/{cart_id}",
        "expected route template breadcrumb",
    )
    require(breadcrumbs[1].get("data", {}).get("attempt") == 2, "expected dependency attempt")
    metadata = attributes.get("metadata", {})
    require(metadata.get("traceId") == "4bf92f3577b34da6a3ce929d0e0e4736", "missing trace ID")
    require(metadata.get("spanId") == "b7ad6b7169203331", "missing span ID")

    panic = events[1]
    require(panic.get("id") == "evt_rust_panic", "unexpected panic issue ID")
    panic_attributes = panic.get("attributes", {})
    require(panic_attributes.get("title") == "panic", "expected panic title")
    require(panic_attributes.get("level") == "critical", "expected critical panic")
    require(panic_attributes.get("exception", {}).get("type") == "panic", "expected panic type")
    require(
        panic_attributes.get("exception", {}).get("mechanism")
        == {"type": "rust.panic", "handled": False},
        "unexpected panic mechanism",
    )
    require(panic_attributes.get("metadata", {}).get("panicType") == "String", "panic type missing")
    require("message" not in panic_attributes, "panic payload text must remain absent")

    serialized = json.dumps(payload, sort_keys=True).lower()
    for forbidden in (
        "private handled error text",
        "private panic payload text",
        "authorization",
        "payload body",
        "query string",
    ):
        require(forbidden not in serialized, f"forbidden value leaked: {forbidden}")

    print("rust issue diagnostics payload ok")


if __name__ == "__main__":
    main()
