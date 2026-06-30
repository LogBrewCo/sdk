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
    if len(events) != 8:
        raise SystemExit(f"expected eight instrumentation events, got {len(events)}")
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
    resource_names = [
        event["attributes"]["name"]
        for event in events
        if event["attributes"].get("metadata", {}).get("source") == "react-native.resource"
    ]
    for resource_name in ("POST /api/checkout", "GET /api/global", "PUT /api/xhr"):
        if resource_name not in resource_names:
            raise SystemExit(f"missing resource span {resource_name}: {resource_names}")
    resource = next((event["attributes"] for event in events if event["attributes"].get("name") == "POST /api/checkout"), None)
    if resource is None:
        raise SystemExit("missing explicit resource fetch span")
    resource_metadata = resource.get("metadata", {})
    if resource_metadata.get("responseStartDurationMs") != 135:
        raise SystemExit(f"unexpected resource fetch response-start timing: {resource_metadata}")
    global_fetch = next((event["attributes"] for event in events if event["attributes"].get("name") == "GET /api/global"), None)
    if global_fetch is None:
        raise SystemExit("missing global fetch resource span")
    global_fetch_metadata = global_fetch.get("metadata", {})
    if global_fetch_metadata.get("responseStartDurationMs") != 20:
        raise SystemExit(f"unexpected global fetch response-start timing: {global_fetch_metadata}")
    xhr = next((event["attributes"] for event in events if event["attributes"].get("name") == "PUT /api/xhr"), None)
    if xhr is None:
        raise SystemExit("missing XHR resource span")
    xhr_metadata = xhr.get("metadata", {})
    if xhr_metadata.get("transport") != "xhr":
        raise SystemExit(f"expected XHR transport metadata: {xhr_metadata}")
    if xhr_metadata.get("responseStartDurationMs") != 15:
        raise SystemExit(f"unexpected XHR response-start timing: {xhr_metadata}")
    if "body" in xhr_metadata:
        raise SystemExit(f"XHR body must not be captured: {xhr_metadata}")
    summary = {
        "ok": True,
        "events": 8,
        "calls": ["set", "set", "clear", "clear"],
        "globalFetchPutBack": True,
        "globalXMLHttpRequestPutBack": True,
        "propagatedTraceparent": f"00-{trace_id}-{span_id}-01",
    }
    for key, value in summary.items():
        if delivery.get(key) != value:
            raise SystemExit(f"unexpected {key}: {delivery}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
