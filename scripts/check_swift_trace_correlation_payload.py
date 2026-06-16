#!/usr/bin/env python3
"""Validate the packaged Swift trace-correlation example payload."""

from __future__ import annotations

import json
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_swift_trace_correlation_payload.py <payload.json>")

    payload_text = Path(sys.argv[1]).read_text(encoding="utf-8")
    payload = json.loads(payload_text)
    events = payload.get("events")
    if not isinstance(events, list) or len(events) != 8:
        raise SystemExit(f"expected 8 events, got {len(events) if isinstance(events, list) else 'non-list'}")

    by_id = {event.get("id"): event for event in events if isinstance(event, dict)}
    required_ids = [
        "evt_release_001",
        "evt_environment_001",
        "evt_issue_001",
        "ios_log_1",
        "evt_action_001",
        "evt_network_milestone_001",
        "evt_metric_001",
        "evt_span_001",
    ]
    missing = [event_id for event_id in required_ids if event_id not in by_id]
    if missing:
        raise SystemExit(f"missing expected event ids: {', '.join(missing)}")

    span_attributes = require_dict(by_id["evt_span_001"].get("attributes"), "span attributes")
    span_id = span_attributes.get("spanId")
    if span_attributes.get("traceId") != TRACE_ID:
        raise SystemExit("span did not continue the incoming trace id")
    if span_attributes.get("parentSpanId") != PARENT_SPAN_ID:
        raise SystemExit("span did not keep the incoming parent span id")
    if not isinstance(span_id, str) or len(span_id) != 16 or span_id == PARENT_SPAN_ID:
        raise SystemExit(f"span used invalid local span id: {span_id!r}")
    if span_attributes.get("name") != "POST /api/checkout":
        raise SystemExit("span used unexpected name")

    for event_id in ["evt_issue_001", "ios_log_1", "evt_action_001", "evt_network_milestone_001", "evt_metric_001"]:
        attributes = require_dict(by_id[event_id].get("attributes"), f"{event_id} attributes")
        metadata = require_dict(attributes.get("metadata"), f"{event_id} metadata")
        assert_trace_metadata(event_id, metadata, span_id)

    network_metadata = require_dict(by_id["evt_network_milestone_001"]["attributes"]["metadata"], "network metadata")
    if network_metadata.get("routeTemplate") != "/api/checkout":
        raise SystemExit("network route template was not sanitized")
    if network_metadata.get("method") != "POST":
        raise SystemExit("network method was not normalized")
    if network_metadata.get("statusCode") != 503:
        raise SystemExit("network status code was not preserved")
    if by_id["evt_network_milestone_001"]["attributes"].get("status") != "failure":
        raise SystemExit("network status was not mapped to failure")

    if "cart_id" in payload_text or "#pay" in payload_text:
        raise SystemExit("payload leaked URL query or fragment")
    if '"traceparent"' in payload_text:
        raise SystemExit("payload leaked raw propagation header")

    print("swift trace correlation payload checks passed")
    return 0


def require_dict(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise SystemExit(f"expected {label} to be an object")
    return value


def assert_trace_metadata(event_id: str, metadata: dict[str, object], span_id: str) -> None:
    if metadata.get("traceId") != TRACE_ID:
        raise SystemExit(f"{event_id} missing trace id metadata")
    if metadata.get("spanId") != span_id:
        raise SystemExit(f"{event_id} missing local span id metadata")
    if metadata.get("parentSpanId") != PARENT_SPAN_ID:
        raise SystemExit(f"{event_id} missing parent span id metadata")
    if metadata.get("traceFlags") != "01":
        raise SystemExit(f"{event_id} missing trace flags metadata")
    if metadata.get("traceSampled") is not True:
        raise SystemExit(f"{event_id} missing sampled metadata")


if __name__ == "__main__":
    raise SystemExit(main())
