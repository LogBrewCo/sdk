#!/usr/bin/env python3
"""Validate the Rust tracing bridge preview payload."""

from __future__ import annotations

import json
import sys
from pathlib import Path

UPSTREAM_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
UPSTREAM_PARENT_SPAN_ID = "00f067aa0ba902b7"
INCOMING_TRACEPARENT = (
    f"00-{UPSTREAM_TRACE_ID}-{UPSTREAM_PARENT_SPAN_ID}-01"
)


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
    require(
        [event.get("type") for event in events]
        == ["release", "environment", "log", "log", "span", "span"],
        "unexpected events",
    )

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
    require(metadata["traceId"] == UPSTREAM_TRACE_ID, "missing log trace correlation")
    require(metadata["spanId"] == "0000000000000001", "missing log span correlation")
    require(
        metadata["parentSpanId"] == UPSTREAM_PARENT_SPAN_ID,
        "missing upstream parent span correlation",
    )
    require("unsafeDebug" not in metadata, "non-primitive debug field should not be captured")

    error_log = events[3]["attributes"]
    require(error_log["message"] == "cart validation failed", "unexpected tracing error message")
    require(error_log["level"] == "error", "tracing error should stay canonical error")
    require(error_log["metadata"]["traceId"] == UPSTREAM_TRACE_ID, "missing error trace correlation")
    require(error_log["metadata"]["spanId"] == "0000000000000002", "missing error span correlation")
    require(error_log["metadata"]["parentSpanId"] == "0000000000000001", "missing error parent span correlation")
    require(error_log["metadata"]["sampled"] is True, "missing inherited sampled flag")

    child_span = events[4]["attributes"]
    require(child_span["name"] == "checkout.validate", "unexpected child span name")
    require(child_span["traceId"] == UPSTREAM_TRACE_ID, "unexpected child trace id")
    require(child_span["spanId"] == "0000000000000002", "unexpected child span id")
    require(child_span["parentSpanId"] == "0000000000000001", "unexpected child parent span id")
    require(child_span["status"] == "error", "error event should mark current child span")
    require(child_span["durationMs"] >= 0, "child span duration should be non-negative")
    require(child_span["metadata"]["sampled"] is True, "missing child sampled metadata")
    require(child_span["metadata"]["tracingSpanEventCount"] == 1, "missing child span event count")
    require(child_span["metadata"]["tracingSpanErrorEventCount"] == 1, "missing child span error count")
    require(child_span["metadata"]["tracingLastErrorLevel"] == "ERROR", "missing child last error level")
    require(child_span["metadata"]["tracingLastErrorTarget"] == "checkout", "missing child last error target")
    require(
        "cart validation failed" not in json.dumps(child_span["metadata"]),
        "span metadata should not duplicate error messages",
    )

    root_span = events[5]["attributes"]
    require(root_span["name"] == "checkout.request", "unexpected root span name")
    require(root_span["traceId"] == UPSTREAM_TRACE_ID, "unexpected root trace id")
    require(root_span["spanId"] == "0000000000000001", "unexpected root span id")
    require(
        root_span["parentSpanId"] == UPSTREAM_PARENT_SPAN_ID,
        "unexpected root upstream parent span id",
    )
    require(root_span["status"] == "ok", "root span should not inherit child error status")
    require(root_span["durationMs"] >= 0, "root span duration should be non-negative")
    span_metadata = root_span["metadata"]
    require(span_metadata["routeTemplate"] == "/checkout/{cart_id}", "span routeTemplate was not sanitized")
    require(span_metadata["cartTier"] == "gold", "missing span app field")
    require(span_metadata["sampled"] is True, "missing root sampled metadata")
    require(span_metadata["tracingSpanEventCount"] == 1, "missing root span event count")
    require("tracingSpanErrorEventCount" not in span_metadata, "root span should not inherit child errors")
    require("traceparent" not in span_metadata, "raw traceparent should not be captured")
    require("unsafeDebug" not in span_metadata, "span non-primitive debug field should not be captured")
    blocked_header_field = "auth" + "orization"
    require(blocked_header_field not in span_metadata, "span should not capture unallowlisted sensitive fields")

    text = Path(sys.argv[1]).read_text().lower()
    for forbidden in [
        "coupon=sample",
        "#review",
        "authorization",
        "bearer sample",
        "requestbody",
        "card=sample",
        "debug-value",
        INCOMING_TRACEPARENT,
        "traceparent",
    ]:
        require(forbidden not in text, f"unsafe text leaked: {forbidden}")

    require(stderr["ok"] is True, "stderr ok must be true")
    require(stderr["status"] == 202, "transport status must be 202")
    require(stderr["attempts"] == 1, "transport attempts must be 1")
    require(stderr["events"] == 6, "stderr event count must be 6")
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
