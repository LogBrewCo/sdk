#!/usr/bin/env python3
"""Validate the Objective-C installed trace-correlation example payload."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
RAW_TRACEPARENT = f"00-{TRACE_ID}-{PARENT_SPAN_ID}-01"


def fail(message: str) -> None:
    raise SystemExit(message)


def load_json(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def event_by_id(payload: dict, event_id: str) -> dict:
    for event in payload.get("events", []):
        if event.get("id") == event_id:
            return event
    fail(f"missing event {event_id}")


def metadata_for(payload: dict, event_id: str) -> dict:
    metadata = event_by_id(payload, event_id).get("attributes", {}).get("metadata")
    if not isinstance(metadata, dict):
        fail(f"missing metadata for {event_id}")
    return metadata


def assert_trace_metadata(metadata: dict, local_span_id: str) -> None:
    if metadata.get("traceId") != TRACE_ID:
        fail(f"unexpected traceId metadata: {metadata.get('traceId')}")
    if metadata.get("spanId") != local_span_id:
        fail(f"unexpected spanId metadata: {metadata.get('spanId')}")
    if metadata.get("parentSpanId") != PARENT_SPAN_ID:
        fail(f"unexpected parentSpanId metadata: {metadata.get('parentSpanId')}")
    if metadata.get("traceFlags") != "01":
        fail(f"unexpected traceFlags metadata: {metadata.get('traceFlags')}")
    if metadata.get("traceSampled") is not True:
        fail(f"unexpected traceSampled metadata: {metadata.get('traceSampled')}")


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: check_objc_trace_correlation_payload.py PAYLOAD_JSON STDERR_JSON")

    payload_path, stderr_path = sys.argv[1:]
    payload = load_json(payload_path)
    stderr_payload = load_json(stderr_path)
    raw_payload = Path(payload_path).read_text(encoding="utf-8")

    outgoing = stderr_payload.get("traceparent")
    match = re.fullmatch(rf"00-{TRACE_ID}-([0-9a-f]{{16}})-01", outgoing or "")
    if match is None:
        fail(f"unexpected outgoing traceparent: {outgoing}")
    local_span_id = match.group(1)
    if local_span_id == PARENT_SPAN_ID:
        fail("outgoing traceparent reused the incoming parent span id")

    for event_id in (
        "evt_trace_issue_001",
        "evt_trace_log_001",
        "evt_trace_action_001",
        "evt_trace_network_001",
        "evt_trace_metric_001",
    ):
        assert_trace_metadata(metadata_for(payload, event_id), local_span_id)

    issue_metadata = metadata_for(payload, "evt_trace_issue_001")
    if issue_metadata.get("traceId") == "caller_supplied_trace":
        fail("caller-supplied traceId overrode active trace metadata")
    if issue_metadata.get("component") != "checkout":
        fail("issue metadata did not preserve primitive app metadata")

    network_metadata = metadata_for(payload, "evt_trace_network_001")
    if network_metadata.get("routeTemplate") != "/api/checkout":
        fail(f"network routeTemplate leaked raw URL data: {network_metadata.get('routeTemplate')}")
    if network_metadata.get("method") != "POST" or network_metadata.get("statusCode") != 503:
        fail("network metadata did not preserve method/status")
    if "card=redacted" in raw_payload or "#pay" in raw_payload:
        fail("network milestone leaked query or fragment text")
    if RAW_TRACEPARENT in raw_payload:
        fail("raw incoming traceparent leaked into telemetry payload")

    span = event_by_id(payload, "evt_trace_span_001").get("attributes", {})
    if span.get("traceId") != TRACE_ID:
        fail("span traceId did not continue incoming trace")
    if span.get("spanId") != local_span_id:
        fail("span did not reuse the active local span id")
    if span.get("parentSpanId") != PARENT_SPAN_ID:
        fail("span did not link to incoming parent span")
    if span.get("status") != "error":
        fail("span status was not preserved")

    url_span = event_by_id(payload, "evt_trace_urlsession_001").get("attributes", {})
    url_span_id = url_span.get("spanId")
    if url_span.get("traceId") != TRACE_ID:
        fail("URLSession span did not continue incoming trace")
    if not re.fullmatch(r"[0-9a-f]{16}", url_span_id or ""):
        fail(f"URLSession span id was invalid: {url_span_id}")
    if url_span_id == local_span_id:
        fail("URLSession child span reused active span id")
    if url_span.get("parentSpanId") != local_span_id:
        fail("URLSession span did not link to active local span")
    if url_span.get("name") != "POST /api/checkout" or url_span.get("status") != "error":
        fail("URLSession span name/status was not preserved")
    url_metadata = url_span.get("metadata", {})
    if url_metadata.get("source") != "objc.urlsession":
        fail("URLSession span source metadata missing")
    if url_metadata.get("traceId") != TRACE_ID or url_metadata.get("spanId") != url_span_id:
        fail("URLSession metadata did not use child trace context")
    if url_metadata.get("parentSpanId") != local_span_id:
        fail("URLSession metadata did not link to active local span")
    if url_metadata.get("routeTemplate") != "/api/checkout" or url_metadata.get("method") != "POST":
        fail("URLSession metadata did not preserve sanitized method/route")
    if url_metadata.get("statusCode") != 503 or url_metadata.get("component") != "pay-api":
        fail("URLSession metadata did not preserve status/app metadata")
    expected_timings = {
        "requestFetchMs": 188.5,
        "requestRedirectMs": 3.25,
        "requestNameLookupMs": 2.5,
        "requestConnectMs": 10,
        "requestTlsMs": 6.5,
        "requestSendMs": 4,
        "requestWaitMs": 120.25,
        "requestReceiveMs": 25,
        "requestBodyBytes": 512,
        "responseBodyBytes": 4096,
    }
    for key, expected in expected_timings.items():
        if url_metadata.get(key) != expected:
            fail(f"URLSession timing metadata {key} was not preserved: {url_metadata.get(key)}")
    for forbidden in ("cart=123", "#pay", "app-owned-header-value", "traceparent"):
        if forbidden in raw_payload:
            fail(f"URLSession span leaked forbidden text: {forbidden}")

    lifecycle_span = event_by_id(payload, "evt_trace_lifecycle_001").get("attributes", {})
    lifecycle_span_id = lifecycle_span.get("spanId")
    if lifecycle_span.get("traceId") != TRACE_ID:
        fail("lifecycle span did not continue incoming trace")
    if not re.fullmatch(r"[0-9a-f]{16}", lifecycle_span_id or ""):
        fail(f"lifecycle span id was invalid: {lifecycle_span_id}")
    if lifecycle_span_id == local_span_id:
        fail("lifecycle child span reused active span id")
    if lifecycle_span.get("parentSpanId") != local_span_id:
        fail("lifecycle span did not link to active local span")
    if lifecycle_span.get("name") != "objc.lifecycle:active->background" or lifecycle_span.get("status") != "ok":
        fail("lifecycle span name/status was not preserved")
    if lifecycle_span.get("durationMs") != 1532.25:
        fail("lifecycle duration was not preserved")
    lifecycle_metadata = lifecycle_span.get("metadata", {})
    if lifecycle_metadata.get("source") != "objc.lifecycle":
        fail("lifecycle span source metadata missing")
    if lifecycle_metadata.get("traceId") != TRACE_ID or lifecycle_metadata.get("spanId") != lifecycle_span_id:
        fail("lifecycle metadata did not use child trace context")
    if lifecycle_metadata.get("parentSpanId") != local_span_id:
        fail("lifecycle metadata did not link to active local span")
    if lifecycle_metadata.get("previousState") != "active" or lifecycle_metadata.get("currentState") != "background":
        fail("lifecycle states were not preserved")
    if lifecycle_metadata.get("durationSource") != "previous_state":
        fail("lifecycle duration source was not preserved")
    if lifecycle_metadata.get("screen") != "Checkout" or lifecycle_metadata.get("component") != "app-delegate":
        fail("lifecycle app metadata was not preserved")
    if lifecycle_metadata.get("traceId") == "spoofed_trace":
        fail("caller-supplied lifecycle traceId overrode child trace metadata")

    print("objc trace correlation payload passed")


if __name__ == "__main__":
    main()
