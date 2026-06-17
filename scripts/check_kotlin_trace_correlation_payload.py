#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
HEX16 = re.compile(r"^[0-9a-f]{16}$")


def load_json(path: str) -> object:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def event_by_id(events: list[dict[str, object]], event_id: str) -> dict[str, object]:
    for event in events:
        if event.get("id") == event_id:
            return event
    raise SystemExit(f"missing event id {event_id}")


def require_trace_metadata(attributes: dict[str, object], span_id: str) -> None:
    metadata = attributes.get("metadata")
    if not isinstance(metadata, dict):
        raise SystemExit("missing trace metadata")
    expected = {
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": PARENT_SPAN_ID,
        "traceFlags": "01",
        "traceSampled": True,
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected metadata {key}: {metadata.get(key)!r}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_kotlin_trace_correlation_payload.py <stdout.json> <stderr.json>")
    payload = load_json(sys.argv[1])
    stderr_payload = load_json(sys.argv[2])
    if not isinstance(payload, dict):
        raise SystemExit("payload must be an object")
    events = payload.get("events")
    if not isinstance(events, list):
        raise SystemExit("payload events must be a list")
    serialized = json.dumps(payload, sort_keys=True)
    for forbidden in ("traceparent", "card=redacted", "#pay", "4BF92F", "spoofed_trace", "spoofed_span", "spoofed_parent"):
        if forbidden in serialized:
            raise SystemExit(f"forbidden value leaked into payload: {forbidden}")

    active_outgoing = stderr_payload.get("activeTraceparent") if isinstance(stderr_payload, dict) else None
    request_outgoing = stderr_payload.get("requestTraceparent") if isinstance(stderr_payload, dict) else None
    if not isinstance(active_outgoing, str):
        raise SystemExit("missing active outgoing traceparent")
    if not isinstance(request_outgoing, str):
        raise SystemExit("missing request outgoing traceparent")
    parts = active_outgoing.split("-")
    if len(parts) != 4 or parts[0] != "00" or parts[1] != TRACE_ID or parts[3] != "01":
        raise SystemExit(f"unexpected active outgoing traceparent: {active_outgoing}")
    span_id = parts[2]
    if not HEX16.match(span_id) or span_id == PARENT_SPAN_ID or span_id == "0" * 16:
        raise SystemExit(f"unexpected local span id: {span_id}")
    request_parts = request_outgoing.split("-")
    if len(request_parts) != 4 or request_parts[0] != "00" or request_parts[1] != TRACE_ID or request_parts[3] != "01":
        raise SystemExit(f"unexpected request outgoing traceparent: {request_outgoing}")
    request_span_id = request_parts[2]
    if not HEX16.match(request_span_id) or request_span_id in {PARENT_SPAN_ID, span_id, "0" * 16}:
        raise SystemExit(f"unexpected request span id: {request_span_id}")

    issue = event_by_id(events, "evt_kotlin_trace_issue_001")
    log = event_by_id(events, "evt_kotlin_trace_log_001")
    action = event_by_id(events, "evt_kotlin_trace_action_001")
    span = event_by_id(events, "evt_kotlin_trace_span_001")
    metric = event_by_id(events, "evt_kotlin_trace_metric_001")
    product_action = event_by_id(events, "evt_kotlin_trace_product_action_001")
    network = event_by_id(events, "evt_kotlin_trace_network_001")
    request = event_by_id(events, "evt_kotlin_trace_request_001")

    for event in (issue, log, action, metric, product_action, network):
        attributes = event.get("attributes")
        if not isinstance(attributes, dict):
            raise SystemExit("event attributes must be objects")
        require_trace_metadata(attributes, span_id)

    span_attributes = span.get("attributes")
    if not isinstance(span_attributes, dict):
        raise SystemExit("span attributes must be an object")
    for key, value in {
        "name": "POST /checkout/{cart_id}",
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": PARENT_SPAN_ID,
        "status": "error",
        "durationMs": 37.5,
    }.items():
        if span_attributes.get(key) != value:
            raise SystemExit(f"unexpected span {key}: {span_attributes.get(key)!r}")

    network_attributes = network.get("attributes")
    if not isinstance(network_attributes, dict):
        raise SystemExit("network attributes must be an object")
    if network_attributes.get("name") != "POST /api/checkout":
        raise SystemExit("network route was not sanitized")

    request_attributes = request.get("attributes")
    if not isinstance(request_attributes, dict):
        raise SystemExit("request span attributes must be an object")
    for key, value in {
        "name": "POST /api/checkout",
        "traceId": TRACE_ID,
        "spanId": request_span_id,
        "parentSpanId": span_id,
        "status": "error",
        "durationMs": 38.5,
    }.items():
        if request_attributes.get(key) != value:
            raise SystemExit(f"unexpected request span {key}: {request_attributes.get(key)!r}")
    request_metadata = request_attributes.get("metadata")
    if not isinstance(request_metadata, dict):
        raise SystemExit("request span metadata must be an object")
    for key, value in {
        "source": "android.request",
        "method": "POST",
        "routeTemplate": "/api/checkout",
        "statusCode": 503,
        "errorType": "IllegalStateException",
        "errorMessage": "retry budget reached",
        "phase": "payment",
        "traceId": TRACE_ID,
        "spanId": request_span_id,
        "parentSpanId": span_id,
        "traceFlags": "01",
        "traceSampled": True,
    }.items():
        if request_metadata.get(key) != value:
            raise SystemExit(f"unexpected request metadata {key}: {request_metadata.get(key)!r}")


if __name__ == "__main__":
    main()
