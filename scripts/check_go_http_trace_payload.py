#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EXPECTED_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
EXPECTED_PARENT_SPAN_ID = "00f067aa0ba902b7"
EXPECTED_CHILD_SPAN_ID = "b7ad6b7169203331"
EXPECTED_OUTGOING_TRACEPARENT = f"00-{EXPECTED_TRACE_ID}-{EXPECTED_CHILD_SPAN_ID}-01"
FORBIDDEN_PAYLOAD_TEXT = (
    "coupon=sale",
    "card",
    "payload",
    "#confirm",
    "?",
)


def _load_payload(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def _metadata(event: dict[str, Any]) -> dict[str, Any]:
    return event["attributes"].get("metadata", {})


def _require_trace_metadata(name: str, metadata: dict[str, Any]) -> None:
    _require(metadata.get("traceId") == EXPECTED_TRACE_ID, f"{name} missing trace id")
    _require(metadata.get("spanId") == EXPECTED_CHILD_SPAN_ID, f"{name} missing span id")
    _require(
        metadata.get("parentSpanId") == EXPECTED_PARENT_SPAN_ID,
        f"{name} missing parent span id",
    )
    _require(metadata.get("sampled") is True, f"{name} missing sampled flag")


def check_payload(payload_path: Path, stderr_path: Path) -> None:
    payload_text = payload_path.read_text()
    for unsafe in FORBIDDEN_PAYLOAD_TEXT:
        _require(unsafe not in payload_text, f"Go HTTP trace payload leaked unsafe value: {unsafe}")

    payload = json.loads(payload_text)
    events = payload["events"]
    event_types = [event["type"] for event in events]
    _require(
        event_types == ["release", "environment", "log", "issue", "span", "metric"],
        f"unexpected Go HTTP trace event order: {event_types!r}",
    )
    by_type = {event["type"]: event for event in events}

    log = by_type["log"]["attributes"]
    log_metadata = _metadata(by_type["log"])
    _require(log.get("level") == "info", f"unexpected slog level: {log!r}")
    _require(log_metadata.get("source") == "slog", "slog event missing source metadata")
    _require(log_metadata.get("cartTier") == "standard", "slog event missing primitive app metadata")
    _require("payload" not in log_metadata, "slog event leaked non-primitive payload metadata")
    _require_trace_metadata("slog event", log_metadata)

    issue = by_type["issue"]["attributes"]
    _require(issue.get("level") == "error", f"unexpected issue level: {issue!r}")
    _require_trace_metadata("issue event", _metadata(by_type["issue"]))

    span = by_type["span"]["attributes"]
    _require(span.get("traceId") == EXPECTED_TRACE_ID, "request span missing trace id")
    _require(span.get("spanId") == EXPECTED_CHILD_SPAN_ID, "request span missing child span id")
    _require(
        span.get("parentSpanId") == EXPECTED_PARENT_SPAN_ID,
        "request span missing upstream parent span id",
    )
    _require(span.get("status") == "error", f"unexpected request span status: {span!r}")
    span_metadata = _metadata(by_type["span"])
    _require(
        span_metadata.get("routeTemplate") == "/checkout/:cart_id",
        f"unexpected request route metadata: {span_metadata!r}",
    )
    _require(span_metadata.get("statusCode") == 502, f"unexpected request status metadata: {span_metadata!r}")

    metric = by_type["metric"]["attributes"]
    _require(
        metric.get("name") == "http.server.duration" and metric.get("kind") == "histogram",
        f"unexpected request metric shape: {metric!r}",
    )
    _require(metric.get("unit") == "ms", f"unexpected request metric unit: {metric!r}")
    metric_metadata = _metadata(by_type["metric"])
    _require(
        metric_metadata.get("routeTemplate") == "/checkout/:cart_id",
        f"unexpected metric route metadata: {metric_metadata!r}",
    )
    _require_trace_metadata("request metric", metric_metadata)

    stderr = _load_payload(stderr_path)
    _require(
        stderr.get("events") == 6
        and stderr.get("status") == 202
        and stderr.get("requestStatus") == 502
        and bool(stderr.get("ok")),
        f"unexpected Go HTTP trace stderr summary: {stderr!r}",
    )
    _require(stderr.get("appLogHasTrace") is True, "wrapped slog output is missing trace fields")
    _require(
        stderr.get("outgoingTraceparent") == EXPECTED_OUTGOING_TRACEPARENT,
        f"unexpected outgoing traceparent: {stderr.get('outgoingTraceparent')!r}",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the Go HTTP trace correlation example output.")
    parser.add_argument("payload", type=Path)
    parser.add_argument("stderr", type=Path)
    args = parser.parse_args()
    check_payload(args.payload, args.stderr)
    print("go HTTP trace correlation payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
