#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
HEX16 = re.compile(r"^[0-9a-f]{16}$")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_unity_request_tracker_payload.py <stdout.json> <stderr.json>")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    stderr_payload = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("payload must be an object")
    events = payload.get("events")
    if not isinstance(events, list):
        raise SystemExit("payload events must be a list")
    serialized = json.dumps(payload, sort_keys=True)
    for forbidden in (
        "traceparent",
        "4BF92F",
        "spoofed_trace",
        "spoofed_traceparent",
        "api.example.test",
        "cache=1",
        "#poll",
    ):
        if forbidden in serialized:
            raise SystemExit(f"forbidden value leaked into payload: {forbidden}")

    active = stderr_payload.get("activeTraceparent") if isinstance(stderr_payload, dict) else None
    if not isinstance(active, str):
        raise SystemExit("missing active traceparent")
    active_parts = active.split("-")
    if len(active_parts) != 4 or active_parts[0] != "00" or active_parts[1] != TRACE_ID or active_parts[3] != "01":
        raise SystemExit(f"unexpected active traceparent: {active}")
    active_span_id = active_parts[2]
    if not HEX16.match(active_span_id) or active_span_id == PARENT_SPAN_ID or active_span_id == "0" * 16:
        raise SystemExit(f"unexpected active span id: {active_span_id}")

    outgoing = stderr_payload.get("requestTraceparent") if isinstance(stderr_payload, dict) else None
    if not isinstance(outgoing, str):
        raise SystemExit("missing outgoing request traceparent")
    parts = outgoing.split("-")
    if len(parts) != 4 or parts[0] != "00" or parts[1] != TRACE_ID or parts[3] != "01":
        raise SystemExit(f"unexpected outgoing request traceparent: {outgoing}")
    request_span_id = parts[2]
    if not HEX16.match(request_span_id) or request_span_id in {active_span_id, PARENT_SPAN_ID, "0" * 16}:
        raise SystemExit(f"unexpected request span id: {request_span_id}")

    request = require_span(events, "evt_unity_request_tracker_001")
    for key, value in {
        "name": "POST /api/checkout",
        "traceId": TRACE_ID,
        "spanId": request_span_id,
        "parentSpanId": active_span_id,
        "status": "error",
        "durationMs": 184.5,
    }.items():
        if request.get(key) != value:
            raise SystemExit(f"unexpected request span {key}: {request.get(key)!r}")

    metadata = request.get("metadata")
    if not isinstance(metadata, dict):
        raise SystemExit("missing request metadata")
    for key, value in {
        "source": "unity.request",
        "method": "POST",
        "routeTemplate": "/api/checkout",
        "statusCode": 503,
        "errorType": "UnityWebRequestError",
        "requestQueuedMs": 4.25,
        "requestSendMs": 12.5,
        "requestWaitMs": 80,
        "requestReceiveMs": 87.75,
        "responseBodyBytes": 2048,
        "platform": "ios",
        "sceneName": "Checkout",
        "sessionId": "session_123",
        "frame": 128,
        "traceId": TRACE_ID,
        "spanId": request_span_id,
        "parentSpanId": active_span_id,
        "traceFlags": "01",
        "traceSampled": True,
    }.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected request metadata {key}: {metadata.get(key)!r}")


def require_span(events: list[object], event_id: str) -> dict[str, object]:
    for event in events:
        if isinstance(event, dict) and event.get("id") == event_id:
            if event.get("type") != "span":
                raise SystemExit(f"{event_id} is not a span")
            attributes = event.get("attributes")
            if not isinstance(attributes, dict):
                raise SystemExit(f"{event_id} attributes must be an object")
            return attributes
    raise SystemExit(f"missing event id {event_id}")


if __name__ == "__main__":
    main()
