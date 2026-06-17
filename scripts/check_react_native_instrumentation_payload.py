#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_react_native_instrumentation_payload.py <stdout-json> <stderr-json>")
    payload = json.loads(Path(sys.argv[1]).read_text())
    delivery = json.loads(Path(sys.argv[2]).read_text())
    events = payload["events"]
    if len(events) != 6:
        raise SystemExit(f"expected six instrumentation events, got {len(events)}")
    sources = [event["attributes"].get("metadata", {}).get("source") for event in events]
    for source in (
        "react-native.instrumentation",
        "react-native.lifecycle",
        "react-native.navigation",
        "react-native.resource",
    ):
        if source not in sources:
            raise SystemExit(f"missing instrumentation source {source}: {sources}")
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    span_id = "e2ad6b7169206664"
    for event in events:
        metadata = event["attributes"].get("metadata", {})
        if metadata.get("traceId") != trace_id or metadata.get("spanId") != span_id:
            raise SystemExit(f"event did not keep shared trace metadata: {event}")
        if "nested" in metadata:
            raise SystemExit(f"nested instrumentation metadata should be dropped: {metadata}")
    summary = {
        "ok": True,
        "events": 6,
        "calls": ["set", "set", "clear", "clear"],
        "propagatedTraceparent": f"00-{trace_id}-{span_id}-01",
    }
    for key, value in summary.items():
        if delivery.get(key) != value:
            raise SystemExit(f"unexpected {key}: {delivery}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
