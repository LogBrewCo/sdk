#!/usr/bin/env python3
"""Validate Java HTTP trace-correlation example output."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load_json(path: str) -> object:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def event_by_id(events: list[dict[str, object]], event_id: str) -> dict[str, object]:
    for event in events:
        if event.get("id") == event_id:
            return event
    raise AssertionError(f"missing event {event_id}")


def metadata(event: dict[str, object]) -> dict[str, object]:
    attributes = event.get("attributes")
    if not isinstance(attributes, dict):
        raise AssertionError(f"event {event.get('id')} attributes must be an object")
    value = attributes.get("metadata")
    if not isinstance(value, dict):
        raise AssertionError(f"event {event.get('id')} metadata must be an object")
    return value


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_java_http_trace_payload.py <stdout.json> <stderr.json>")

    payload = load_json(sys.argv[1])
    summary = load_json(sys.argv[2])
    if not isinstance(payload, dict):
        raise AssertionError("stdout payload must be an object")
    events = payload.get("events")
    if not isinstance(events, list):
        raise AssertionError("events must be a list")

    expected_trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    expected_span_id = "b7ad6b7169203331"
    expected_parent_span_id = "00f067aa0ba902b7"
    expected_traceparent = f"00-{expected_trace_id}-{expected_span_id}-01"

    if summary != {
        "ok": True,
        "status": 202,
        "attempts": 1,
        "events": 4,
        "outgoingTraceparent": expected_traceparent,
    }:
        raise AssertionError(f"unexpected stderr summary: {summary!r}")

    log = event_by_id(events, "jul_101")
    issue = event_by_id(events, "evt_issue_checkout_request")
    span = event_by_id(events, "evt_span_checkout_request")
    metric = event_by_id(events, "evt_metric_checkout_request_duration")

    for event in (log, issue, span, metric):
        attrs = event.get("attributes")
        if not isinstance(attrs, dict):
            raise AssertionError(f"{event.get('id')} attributes must be an object")
        meta = metadata(event)
        assert meta["traceId"] == expected_trace_id
        assert meta["spanId"] == expected_span_id
        assert meta["parentSpanId"] == expected_parent_span_id
        assert meta["traceFlags"] == "01"
        assert meta["traceSampled"] is True

    span_attrs = span["attributes"]
    metric_attrs = metric["attributes"]
    assert span_attrs["name"] == "POST /checkout/{cart_id}"
    assert span_attrs["traceId"] == expected_trace_id
    assert span_attrs["spanId"] == expected_span_id
    assert span_attrs["parentSpanId"] == expected_parent_span_id
    assert span_attrs["status"] == "error"
    assert span_attrs["durationMs"] == 183.4
    assert metric_attrs["name"] == "http.server.duration"
    assert metric_attrs["kind"] == "histogram"
    assert metric_attrs["value"] == 183.4
    assert metric_attrs["unit"] == "ms"

    serialized = json.dumps(payload, sort_keys=True)
    forbidden = ["cart=private", "#review", "traceparent", "00-4bf92f"]
    for value in forbidden:
        if value in serialized:
            raise AssertionError(f"payload leaked forbidden value {value!r}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
