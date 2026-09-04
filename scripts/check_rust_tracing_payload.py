#!/usr/bin/env python3
"""Validate the Rust tracing bridge preview payload."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
UPSTREAM_SPAN_ID = "00f067aa0ba902b7"
TRACEPARENT = f"00-{TRACE_ID}-{UPSTREAM_SPAN_ID}-01"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def expect(value: Any, **fields: Any) -> None:
    for path, expected in fields.items():
        actual = value
        for part in path.split("__"):
            require(isinstance(actual, dict) and part in actual, f"missing {path}")
            actual = actual[part]
        require(actual == expected, f"unexpected {path}: {actual!r}")


def expect_trace(attributes: dict[str, Any], span_id: str, parent_id: str | None) -> None:
    flat = attributes if "traceId" in attributes else attributes["metadata"]
    expect(flat, traceId=TRACE_ID, spanId=span_id)
    expect(attributes, context__trace__traceId=TRACE_ID, context__trace__spanId=span_id)
    for value in (flat, attributes["context"]["trace"]):
        require(value.get("parentSpanId") == parent_id, "unexpected parent span")


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_rust_tracing_payload.py STDOUT_JSON STDERR_JSON")

    payload = json.loads(Path(sys.argv[1]).read_text())
    stderr = json.loads(Path(sys.argv[2]).read_text())
    require(isinstance(payload, dict), "stdout payload must be an object")
    events = payload.get("events")
    require(isinstance(events, list), "stdout events must be a list")
    require(
        [event.get("type") for event in events]
        == ["release", "environment", "log", "log", "issue", "span", "span"],
        "unexpected events",
    )

    log = events[2]["attributes"]
    expect(
        log,
        message="checkout tracing event accepted",
        level="info",
        logger="checkout",
        metadata__tracingTarget="checkout",
        metadata__tracingLevel="INFO",
        metadata__routeTemplate="/checkout/{cart_id}",
        metadata__statusCode=202,
        metadata__sampled=True,
        metadata__cartTier="gold",
        context__resource__service__name="checkout-service",
        context__resource__framework__name="tracing",
    )
    expect_trace(log, "0000000000000001", UPSTREAM_SPAN_ID)
    require("unsafeDebug" not in log["metadata"], "captured non-primitive debug field")

    error_log = events[3]["attributes"]
    expect(error_log, message="cart validation failed", level="error", metadata__sampled=True)
    expect_trace(error_log, "0000000000000002", "0000000000000001")

    issue = events[4]["attributes"]
    expect(
        issue,
        title="cart validation failed",
        message="cart validation failed",
        level="error",
        metadata__mechanism="tracing.event",
        metadata__handled=True,
        metadata__sourceFileName="main.rs",
        metadata__sourceModule="tracing_app",
        metadata__issueGroupingSource="tracing_callsite",
        metadata__issueEvidenceCompleteness="partial",
        metadata__issueMissingEvidence="exception,stackFrames",
        metadata__issueRedactedEvidence="unallowlistedEventFields",
    )
    expect_trace(issue, "0000000000000002", "0000000000000001")
    grouping_key = issue["metadata"]["issueGroupingKey"]
    require(grouping_key.startswith("rust.tracing.event:checkout:main.rs:"), "bad grouping key")
    require(isinstance(issue["metadata"].get("sourceLineNumber"), int), "missing source line")
    require("stackFrames" not in issue and "exception" not in issue, "invented issue evidence")

    child = events[5]["attributes"]
    expect(
        child,
        name="checkout.validate",
        status="error",
        metadata__sampled=True,
        metadata__tracingSpanEventCount=1,
        metadata__tracingSpanErrorEventCount=1,
        metadata__tracingLastErrorLevel="ERROR",
        metadata__tracingLastErrorTarget="checkout",
        context__resource__framework__name="tracing",
    )
    expect_trace(child, "0000000000000002", "0000000000000001")
    require(child["durationMs"] >= 0, "child span duration must be non-negative")
    require("cart validation failed" not in json.dumps(child["metadata"]), "message leaked to span")

    root = events[6]["attributes"]
    expect(
        root,
        name="checkout.request",
        status="ok",
        metadata__routeTemplate="/checkout/{cart_id}",
        metadata__cartTier="gold",
        metadata__sampled=True,
        metadata__tracingSpanEventCount=1,
    )
    expect_trace(root, "0000000000000001", UPSTREAM_SPAN_ID)
    require(root["durationMs"] >= 0, "root span duration must be non-negative")
    for key in ("tracingSpanErrorEventCount", "traceparent", "unsafeDebug", "authorization"):
        require(key not in root["metadata"], f"unsafe root metadata: {key}")

    text = Path(sys.argv[1]).read_text().lower()
    for forbidden in (
        "coupon=sample",
        "#review",
        "authorization",
        "bearer sample",
        "requestbody",
        "card=sample",
        "debug-value",
        TRACEPARENT,
        "traceparent",
    ):
        require(forbidden not in text, f"unsafe text leaked: {forbidden}")
    require(stderr == {"ok": True, "status": 202, "attempts": 1, "events": 7}, "bad receipt")
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
