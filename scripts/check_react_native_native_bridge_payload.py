#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_react_native_native_bridge_payload.py <stdout-json> <stderr-json>")
    payload = json.loads(Path(sys.argv[1]).read_text())
    delivery = json.loads(Path(sys.argv[2]).read_text())
    events = payload["events"]
    if len(events) != 1:
        raise SystemExit(f"expected one native bridge event, got {len(events)}")
    metadata = events[0]["attributes"].get("metadata", {})
    expected = {
        "source": "react-native.native_bridge",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "spanId": "d2ad6b7169205553",
        "parentSpanId": "00f067aa0ba902b7",
        "routeTemplate": "/native/checkout",
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise SystemExit(f"unexpected {key}: {metadata}")
    if "nested" in metadata:
        raise SystemExit(f"nested bridge metadata should be dropped: {metadata}")
    if delivery.get("ok") is not True or delivery.get("events") != 1 or delivery.get("calls") != ["set", "set", "clear"]:
        raise SystemExit(f"unexpected native bridge delivery summary: {delivery}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
