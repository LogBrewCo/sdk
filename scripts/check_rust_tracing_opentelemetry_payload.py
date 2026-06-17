#!/usr/bin/env python3
"""Validate the Rust tracing-opentelemetry bridge preview payload."""

from __future__ import annotations

import json
import sys
from pathlib import Path

UPSTREAM_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
UPSTREAM_PARENT_SPAN_ID = "00f067aa0ba902b7"
CHILD_SPAN_ID = "1111111111111111"
OUTGOING_TRACEPARENT = f"00-{UPSTREAM_TRACE_ID}-{CHILD_SPAN_ID}-01"


def load_json(path: str) -> object:
    return json.loads(Path(path).read_text())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: check_rust_tracing_opentelemetry_payload.py STDOUT_JSON STDERR_JSON"
        )

    payload = load_json(sys.argv[1])
    stderr = load_json(sys.argv[2])
    require(isinstance(payload, dict), "stdout payload must be an object")
    events = payload.get("events")
    require(isinstance(events, list), "stdout events must be a list")
    require(
        [event.get("type") for event in events] == ["release", "environment", "span"],
        "unexpected events",
    )

    span = events[2]["attributes"]
    require(span["name"] == "checkout.otel.child", "unexpected span name")
    require(span["traceId"] == UPSTREAM_TRACE_ID, "unexpected trace id")
    require(span["spanId"] == CHILD_SPAN_ID, "unexpected child span id")
    require(span["parentSpanId"] == UPSTREAM_PARENT_SPAN_ID, "unexpected OTel parent span id")
    require(span["status"] == "ok", "unexpected span status")
    metadata = span["metadata"]
    require(metadata["bridge"] == "tracing-opentelemetry", "missing bridge marker")
    require(metadata["sampled"] is True, "missing sampled flag")
    require(metadata["outgoingTraceHeaderCount"] == 1, "unexpected header count")

    text = Path(sys.argv[1]).read_text().lower()
    for forbidden in [
        OUTGOING_TRACEPARENT,
        "traceparent",
        "tracestate",
        "baggage",
        "authorization",
        "bearer",
        "requestbody",
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
