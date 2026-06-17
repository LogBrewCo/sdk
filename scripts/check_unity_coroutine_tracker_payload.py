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
        raise SystemExit("usage: check_unity_coroutine_tracker_payload.py <stdout.json> <stderr.json>")
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

    log = require_event(events, "evt_unity_coroutine_log_001", "log")
    action = require_event(events, "evt_unity_coroutine_action_001", "action")
    span = require_event(events, "evt_unity_coroutine_tracker_001", "span")
    span_id = require_coroutine_span(span["attributes"], active_span_id)
    require_trace_metadata(log["attributes"], span_id, active_span_id)
    require_trace_metadata(action["attributes"], span_id, active_span_id)

    action_metadata = action["attributes"].get("metadata")
    if not isinstance(action_metadata, dict):
        raise SystemExit("missing action metadata")
    for key, value in {
        "source": "unity.coroutine",
        "phase": "resume",
        "sceneName": "Checkout",
    }.items():
        if action_metadata.get(key) != value:
            raise SystemExit(f"unexpected action metadata {key}: {action_metadata.get(key)!r}")


def require_event(events: list[object], event_id: str, event_type: str) -> dict[str, object]:
    for event in events:
        if isinstance(event, dict) and event.get("id") == event_id:
            if event.get("type") != event_type:
                raise SystemExit(f"{event_id} is not a {event_type} event")
            attributes = event.get("attributes")
            if not isinstance(attributes, dict):
                raise SystemExit(f"{event_id} attributes must be an object")
            return {"attributes": attributes}
    raise SystemExit(f"missing event id {event_id}")


def require_coroutine_span(attributes: dict[str, object], active_span_id: str) -> str:
    for key, value in {
        "name": "unity.coroutine:checkout.upload",
        "traceId": TRACE_ID,
        "parentSpanId": active_span_id,
        "status": "ok",
        "durationMs": 345.25,
    }.items():
        if attributes.get(key) != value:
            raise SystemExit(f"unexpected coroutine span {key}: {attributes.get(key)!r}")
    span_id = attributes.get("spanId")
    if not isinstance(span_id, str) or not HEX16.match(span_id) or span_id in {active_span_id, PARENT_SPAN_ID, "0" * 16}:
        raise SystemExit(f"unexpected coroutine span id: {span_id!r}")
    metadata = attributes.get("metadata")
    if not isinstance(metadata, dict):
        raise SystemExit("missing coroutine span metadata")
    for key, value in {
        "source": "unity.coroutine",
        "coroutineName": "checkout.upload",
        "outcome": "completed",
        "platform": "ios",
        "sceneName": "Checkout",
        "sessionId": "session_123",
        "frame": 128,
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": active_span_id,
        "traceFlags": "01",
        "traceSampled": True,
    }.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected coroutine metadata {key}: {metadata.get(key)!r}")
    return span_id


def require_trace_metadata(attributes: dict[str, object], span_id: str, parent_span_id: str) -> None:
    metadata = attributes.get("metadata")
    if not isinstance(metadata, dict):
        raise SystemExit("missing trace metadata")
    for key, value in {
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": parent_span_id,
        "traceFlags": "01",
        "traceSampled": True,
    }.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected trace metadata {key}: {metadata.get(key)!r}")


if __name__ == "__main__":
    main()
