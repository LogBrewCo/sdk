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


def require_trace_metadata(
    attributes: dict[str, object],
    span_id: str,
    parent_span_id: str = PARENT_SPAN_ID,
) -> None:
    metadata = attributes.get("metadata")
    if not isinstance(metadata, dict):
        raise SystemExit("missing trace metadata")
    expected = {
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": parent_span_id,
        "traceFlags": "01",
        "traceSampled": True,
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected metadata {key}: {metadata.get(key)!r}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_unity_trace_correlation_payload.py <stdout.json> <stderr.json>")
    payload = load_json(sys.argv[1])
    stderr_payload = load_json(sys.argv[2])
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
        "spoofed_span",
        "spoofed_parent",
        "api.example.test",
        "cache=1",
        "#poll",
    ):
        if forbidden in serialized:
            raise SystemExit(f"forbidden value leaked into payload: {forbidden}")

    outgoing = stderr_payload.get("traceparent") if isinstance(stderr_payload, dict) else None
    if not isinstance(outgoing, str):
        raise SystemExit("missing outgoing traceparent")
    parts = outgoing.split("-")
    if len(parts) != 4 or parts[0] != "00" or parts[1] != TRACE_ID or parts[3] != "01":
        raise SystemExit(f"unexpected outgoing traceparent: {outgoing}")
    span_id = parts[2]
    if not HEX16.match(span_id) or span_id == PARENT_SPAN_ID or span_id == "0" * 16:
        raise SystemExit(f"unexpected local span id: {span_id}")
    request_traceparent = stderr_payload.get("requestTraceparent") if isinstance(stderr_payload, dict) else None
    if not isinstance(request_traceparent, str):
        raise SystemExit("missing request traceparent")
    request_parts = request_traceparent.split("-")
    if len(request_parts) != 4 or request_parts[0] != "00" or request_parts[1] != TRACE_ID or request_parts[3] != "01":
        raise SystemExit(f"unexpected request traceparent: {request_traceparent}")
    request_span_id = request_parts[2]
    if not HEX16.match(request_span_id) or request_span_id in {span_id, PARENT_SPAN_ID, "0" * 16}:
        raise SystemExit(f"unexpected request span id: {request_span_id}")

    issue = event_by_id(events, "evt_unity_trace_issue_001")
    log = event_by_id(events, "evt_unity_trace_log_001")
    action = event_by_id(events, "evt_unity_trace_action_001")
    span = event_by_id(events, "evt_unity_trace_span_001")
    scene = event_by_id(events, "evt_unity_trace_scene_001")
    helper_log = event_by_id(events, "evt_unity_trace_helper_log_001")
    exception = event_by_id(events, "evt_unity_trace_exception_001")
    request = event_by_id(events, "evt_unity_trace_request_001")
    coroutine = event_by_id(events, "evt_unity_trace_coroutine_001")

    for event in (issue, log, action, scene, helper_log, exception, coroutine):
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

    scene_attributes = scene.get("attributes")
    if not isinstance(scene_attributes, dict) or scene_attributes.get("name") != "scene_loaded":
        raise SystemExit("missing scene-loaded action")
    helper_log_attributes = helper_log.get("attributes")
    if not isinstance(helper_log_attributes, dict) or helper_log_attributes.get("logger") != "unity":
        raise SystemExit("missing Unity logger helper event")
    exception_attributes = exception.get("attributes")
    if not isinstance(exception_attributes, dict) or exception_attributes.get("level") != "error":
        raise SystemExit("missing Unity exception issue")
    coroutine_attributes = coroutine.get("attributes")
    if not isinstance(coroutine_attributes, dict) or coroutine_attributes.get("name") != "unity.coroutine.resume":
        raise SystemExit("missing Unity coroutine action")
    coroutine_metadata = coroutine_attributes.get("metadata")
    if not isinstance(coroutine_metadata, dict):
        raise SystemExit("missing coroutine metadata")
    for key, value in {
        "source": "unity.coroutine",
        "phase": "resume",
        "sceneName": "Checkout",
    }.items():
        if coroutine_metadata.get(key) != value:
            raise SystemExit(f"unexpected coroutine metadata {key}: {coroutine_metadata.get(key)!r}")

    request_attributes = request.get("attributes")
    if not isinstance(request_attributes, dict):
        raise SystemExit("request span attributes must be an object")
    for key, value in {
        "name": "GET /api/checkout/status",
        "traceId": TRACE_ID,
        "spanId": request_span_id,
        "parentSpanId": span_id,
        "status": "error",
        "durationMs": 184.5,
    }.items():
        if request_attributes.get(key) != value:
            raise SystemExit(f"unexpected request span {key}: {request_attributes.get(key)!r}")
    request_metadata = request_attributes.get("metadata")
    if not isinstance(request_metadata, dict):
        raise SystemExit("missing request span metadata")
    for key, value in {
        "source": "unity.request",
        "method": "GET",
        "routeTemplate": "/api/checkout/status",
        "statusCode": 503,
        "errorType": "UnityWebRequestError",
        "sceneName": "Checkout",
    }.items():
        if request_metadata.get(key) != value:
            raise SystemExit(f"unexpected request metadata {key}: {request_metadata.get(key)!r}")
    require_trace_metadata(request_attributes, request_span_id, span_id)


if __name__ == "__main__":
    main()
