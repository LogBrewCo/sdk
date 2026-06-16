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
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_unity_lifecycle_payload.py <stdout.json>")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("payload must be an object")
    events = payload.get("events")
    if not isinstance(events, list):
        raise SystemExit("payload events must be a list")
    serialized = json.dumps(payload, sort_keys=True)
    for forbidden in ("traceparent", "4BF92F", "spoofed_trace"):
        if forbidden in serialized:
            raise SystemExit(f"forbidden value leaked into payload: {forbidden}")

    active_to_paused = require_span(events, "evt_unity_lifecycle_active_paused_001")
    paused_to_active = require_span(events, "evt_unity_lifecycle_paused_active_001")
    span_id = require_lifecycle_span(active_to_paused, "active", "paused", 1532.25)
    if require_lifecycle_span(paused_to_active, "paused", "active", 422.5) != span_id:
        raise SystemExit("lifecycle spans should reuse the active local span id")
    metadata = paused_to_active.get("metadata")
    if not isinstance(metadata, dict) or metadata.get("frame") != 128:
        raise SystemExit("missing Unity frame metadata")


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


def require_lifecycle_span(
    attributes: dict[str, object],
    previous_state: str,
    current_state: str,
    duration_ms: float,
) -> str:
    expected = {
        "name": f"unity.lifecycle:{previous_state}->{current_state}",
        "traceId": TRACE_ID,
        "parentSpanId": PARENT_SPAN_ID,
        "status": "ok",
        "durationMs": duration_ms,
    }
    for key, value in expected.items():
        if attributes.get(key) != value:
            raise SystemExit(f"unexpected lifecycle {key}: {attributes.get(key)!r}")
    span_id = attributes.get("spanId")
    if not isinstance(span_id, str) or not HEX16.match(span_id) or span_id == PARENT_SPAN_ID or span_id == "0" * 16:
        raise SystemExit(f"unexpected lifecycle span id: {span_id!r}")
    metadata = attributes.get("metadata")
    if not isinstance(metadata, dict):
        raise SystemExit("missing lifecycle metadata")
    for key, value in {
        "previousState": previous_state,
        "currentState": current_state,
        "durationSource": "previous_state",
        "platform": "ios",
        "sceneName": "Checkout",
        "sessionId": "session_123",
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": PARENT_SPAN_ID,
        "traceFlags": "01",
        "traceSampled": True,
    }.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected lifecycle metadata {key}: {metadata.get(key)!r}")
    return span_id


if __name__ == "__main__":
    main()
