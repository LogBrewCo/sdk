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
        "sampled": True,
        "traceFlags": "01",
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected metadata {key}: {metadata.get(key)!r}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_c_trace_correlation_payload.py <stdout.json> <stderr.json>")
    payload = load_json(sys.argv[1])
    stderr_payload = load_json(sys.argv[2])
    if not isinstance(payload, dict):
        raise SystemExit("payload must be an object")
    events = payload.get("events")
    if not isinstance(events, list):
        raise SystemExit("payload events must be a list")
    serialized = json.dumps(payload, sort_keys=True)
    for forbidden in ("traceparent", "card=redacted", "#pay", "4BF92F"):
        if forbidden in serialized:
            raise SystemExit(f"forbidden value leaked into payload: {forbidden}")

    outgoing = stderr_payload.get("traceparent") if isinstance(stderr_payload, dict) else None
    outbound = stderr_payload.get("outboundTraceparent") if isinstance(stderr_payload, dict) else None
    if not isinstance(outgoing, str):
        raise SystemExit("missing outgoing traceparent")
    parts = outgoing.split("-")
    if len(parts) != 4 or parts[0] != "00" or parts[1] != TRACE_ID or parts[3] != "01":
        raise SystemExit(f"unexpected outgoing traceparent: {outgoing}")
    span_id = parts[2]
    if not HEX16.match(span_id) or span_id == PARENT_SPAN_ID or span_id == "0" * 16:
        raise SystemExit(f"unexpected local span id: {span_id}")
    if not isinstance(outbound, str):
        raise SystemExit("missing outbound traceparent")
    outbound_parts = outbound.split("-")
    if len(outbound_parts) != 4 or outbound_parts[0] != "00" or outbound_parts[1] != TRACE_ID or outbound_parts[3] != "01":
        raise SystemExit(f"unexpected outbound traceparent: {outbound}")
    outbound_span_id = outbound_parts[2]
    if not HEX16.match(outbound_span_id) or outbound_span_id in {PARENT_SPAN_ID, span_id, "0" * 16}:
        raise SystemExit(f"unexpected outbound span id: {outbound_span_id}")

    issue = event_by_id(events, "evt_c_trace_issue_001")
    log = event_by_id(events, "evt_c_trace_log_001")
    action = event_by_id(events, "evt_c_trace_action_001")
    span = event_by_id(events, "evt_c_trace_span_001")
    outbound_span = event_by_id(events, "evt_c_trace_http_client_span_001")
    metric = event_by_id(events, "evt_c_trace_metric_001")
    product_action = event_by_id(events, "evt_c_trace_product_action_001")
    network = event_by_id(events, "evt_c_trace_network_001")

    for event in (issue, log, action):
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

    outbound_attributes = outbound_span.get("attributes")
    if not isinstance(outbound_attributes, dict):
        raise SystemExit("outbound span attributes must be an object")
    for key, value in {
        "name": "POST /v1/payments/{payment_id}",
        "traceId": TRACE_ID,
        "spanId": outbound_span_id,
        "parentSpanId": span_id,
        "status": "error",
        "durationMs": 42.75,
    }.items():
        if outbound_attributes.get(key) != value:
            raise SystemExit(f"unexpected outbound span {key}: {outbound_attributes.get(key)!r}")

    metric_attributes = metric.get("attributes")
    if not isinstance(metric_attributes, dict):
        raise SystemExit("metric attributes must be an object")
    require_trace_metadata(metric_attributes, span_id)

    product_metadata = product_action.get("attributes", {}).get("metadata")  # type: ignore[union-attr]
    network_metadata = network.get("attributes", {}).get("metadata")  # type: ignore[union-attr]
    if not isinstance(product_metadata, dict) or product_metadata.get("traceId") != TRACE_ID:
        raise SystemExit("missing product trace metadata")
    if not isinstance(network_metadata, dict) or network_metadata.get("traceId") != TRACE_ID:
        raise SystemExit("missing network trace metadata")
    if network.get("attributes", {}).get("name") != "POST /api/checkout":  # type: ignore[union-attr]
        raise SystemExit("network route was not sanitized")
    for key, value in {
        "requestQueuedMs": 1.25,
        "requestNameLookupMs": 2.5,
        "requestConnectMs": 4.0,
        "requestTlsMs": 8.5,
        "requestSendMs": 3.25,
        "requestWaitMs": 12.75,
        "requestReceiveMs": 5.25,
        "responseBodyBytes": 2048,
    }.items():
        if network_metadata.get(key) != value:
            raise SystemExit(f"unexpected network timing {key}: {network_metadata.get(key)!r}")


if __name__ == "__main__":
    main()
