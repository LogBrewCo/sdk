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
    if not isinstance(events, list) or len(events) != 10:
        raise SystemExit(f"expected 10 events, got {len(events) if isinstance(events, list) else 'non-list'}")

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
        "evt_urlsession_span_001",
        "evt_lifecycle_span_001",
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
    if "app-owned-header-value" in payload_text:
        raise SystemExit("payload leaked app-owned request header")
    if '"traceparent"' in payload_text:
        raise SystemExit("payload leaked raw propagation header")

    urlsession_span = require_dict(by_id["evt_urlsession_span_001"].get("attributes"), "URLSession span attributes")
    urlsession_span_id = urlsession_span.get("spanId")
    if urlsession_span.get("traceId") != TRACE_ID:
        raise SystemExit("URLSession span did not continue the active trace id")
    if urlsession_span.get("parentSpanId") != span_id:
        raise SystemExit("URLSession span did not use the active span as parent")
    if not isinstance(urlsession_span_id, str) or len(urlsession_span_id) != 16 or urlsession_span_id == span_id:
        raise SystemExit(f"URLSession span used invalid child span id: {urlsession_span_id!r}")
    if urlsession_span.get("name") != "POST /api/checkout":
        raise SystemExit("URLSession span used unexpected name")
    if urlsession_span.get("status") != "error":
        raise SystemExit("URLSession span did not map 5xx status to error")
    urlsession_metadata = require_dict(urlsession_span.get("metadata"), "URLSession span metadata")
    if urlsession_metadata.get("source") != "swift.urlsession":
        raise SystemExit("URLSession span missing source metadata")
    if urlsession_metadata.get("routeTemplate") != "/api/checkout":
        raise SystemExit("URLSession span route template was not sanitized")
    if urlsession_metadata.get("method") != "POST":
        raise SystemExit("URLSession span method was not normalized")
    if urlsession_metadata.get("statusCode") != 503:
        raise SystemExit("URLSession span status code was not preserved")
    if urlsession_metadata.get("component") != "pay-api":
        raise SystemExit("URLSession span custom primitive metadata was not preserved")
    expected_urlsession_timings = {
        "requestFetchMs": 184.5,
        "requestNameLookupMs": 2.5,
        "requestConnectMs": 10,
        "requestTlsMs": 6.5,
        "requestSendMs": 4,
        "requestWaitMs": 120.25,
        "requestReceiveMs": 25,
        "requestBodyBytes": 512,
        "responseBodyBytes": 4096,
    }
    for key, expected in expected_urlsession_timings.items():
        if urlsession_metadata.get(key) != expected:
            raise SystemExit(f"URLSession span timing metadata {key} was not preserved")
    assert_trace_metadata(
        "evt_urlsession_span_001",
        urlsession_metadata,
        urlsession_span_id,
        parent_span_id=span_id,
    )

    lifecycle_span = require_dict(by_id["evt_lifecycle_span_001"].get("attributes"), "lifecycle span attributes")
    lifecycle_span_id = lifecycle_span.get("spanId")
    if lifecycle_span.get("traceId") != TRACE_ID:
        raise SystemExit("lifecycle span did not continue the active trace id")
    if lifecycle_span.get("parentSpanId") != span_id:
        raise SystemExit("lifecycle span did not use the active span as parent")
    if not isinstance(lifecycle_span_id, str) or len(lifecycle_span_id) != 16 or lifecycle_span_id == span_id:
        raise SystemExit(f"lifecycle span used invalid child span id: {lifecycle_span_id!r}")
    if lifecycle_span.get("name") != "swift.lifecycle:active->background":
        raise SystemExit("lifecycle span used unexpected name")
    if lifecycle_span.get("status") != "ok":
        raise SystemExit("lifecycle span did not use ok status")
    if lifecycle_span.get("durationMs") != 1532.25:
        raise SystemExit("lifecycle span duration was not preserved")
    lifecycle_metadata = require_dict(lifecycle_span.get("metadata"), "lifecycle span metadata")
    if lifecycle_metadata.get("source") != "swift.lifecycle":
        raise SystemExit("lifecycle span missing source metadata")
    if lifecycle_metadata.get("previousState") != "active":
        raise SystemExit("lifecycle span previous state was not normalized")
    if lifecycle_metadata.get("currentState") != "background":
        raise SystemExit("lifecycle span current state was not preserved")
    if lifecycle_metadata.get("durationSource") != "previous_state":
        raise SystemExit("lifecycle span missing duration source metadata")
    if lifecycle_metadata.get("screen") != "Checkout":
        raise SystemExit("lifecycle span context metadata was not preserved")
    if lifecycle_metadata.get("component") != "scene-delegate":
        raise SystemExit("lifecycle span custom primitive metadata was not preserved")
    assert_trace_metadata(
        "evt_lifecycle_span_001",
        lifecycle_metadata,
        lifecycle_span_id,
        parent_span_id=span_id,
    )
    if "spoofed_trace" in payload_text:
        raise SystemExit("lifecycle span allowed spoofed trace metadata")

    print("swift trace correlation payload checks passed")
    return 0


def require_dict(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise SystemExit(f"expected {label} to be an object")
    return value


def assert_trace_metadata(
    event_id: str,
    metadata: dict[str, object],
    span_id: str,
    parent_span_id: str = PARENT_SPAN_ID,
) -> None:
    if metadata.get("traceId") != TRACE_ID:
        raise SystemExit(f"{event_id} missing trace id metadata")
    if metadata.get("spanId") != span_id:
        raise SystemExit(f"{event_id} missing local span id metadata")
    if metadata.get("parentSpanId") != parent_span_id:
        raise SystemExit(f"{event_id} missing parent span id metadata")
    if metadata.get("traceFlags") != "01":
        raise SystemExit(f"{event_id} missing trace flags metadata")
    if metadata.get("traceSampled") is not True:
        raise SystemExit(f"{event_id} missing sampled metadata")


if __name__ == "__main__":
    raise SystemExit(main())
