#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
HEX_16 = re.compile(r"^[0-9a-f]{16}$")


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def metadata(event):
    value = event.get("attributes", {}).get("metadata", {})
    require(isinstance(value, dict), f"metadata is not an object for {event.get('id')}")
    return value


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_activity_source_listener_payload.py stdout.json stderr.json")

    payload_text = Path(sys.argv[1]).read_text()
    summary = json.loads(Path(sys.argv[2]).read_text())
    payload = json.loads(payload_text)
    events = payload.get("events", [])

    require(summary.get("ok") is True, "summary ok flag missing")
    require(summary.get("events") == 1, "summary event count mismatch")
    require(summary.get("status") == 202, "summary status mismatch")
    require(summary.get("attempts") == 1, "summary attempts mismatch")
    require(HEX_16.match(summary.get("activitySpanId", "")), "invalid Activity span id")
    require(len(events) == 1, f"expected 1 event, got {len(events)}")

    for blocked in ("Ignored", "shop.example", "card=sample", "https://", "request.body", "ignoredObject"):
        require(blocked not in payload_text, f"unsafe or ignored ActivitySource data leaked: {blocked}")

    event = events[0]
    require(event.get("id") == f"dotnet_activity_source_listener_span_{summary['activitySpanId']}", "ActivitySource event id mismatch")
    attrs = event.get("attributes", {})
    meta = metadata(event)

    require(attrs.get("traceId") == TRACE_ID, "trace id mismatch")
    require(attrs.get("spanId") == summary["activitySpanId"], "span id mismatch")
    require(attrs.get("parentSpanId") == PARENT_SPAN_ID, "parent span id mismatch")
    require(attrs.get("name") == "POST /checkout/:cart_id", "safe Activity name mismatch")
    require(attrs.get("status") == "ok", "span status mismatch")
    require(attrs.get("durationMs") >= 0, "duration must be non-negative")
    require(meta.get("source") == "dotnet.activity", "Activity source marker missing")
    require(meta.get("activityName") == "POST /checkout/:cart_id", "Activity metadata name mismatch")
    require(meta.get("activityKind") == "client", "Activity kind mismatch")
    require(meta.get("activitySourceName") == "System.Net.Http", "ActivitySource name mismatch")
    require(meta.get("activitySourceVersion") == "10.0.0", "ActivitySource version mismatch")
    require(meta.get("traceFlags") == "01", "trace flags mismatch")
    require(meta.get("traceSampled") is True, "sampled flag mismatch")
    require(meta.get("httpMethod") == "POST", "HTTP method mismatch")
    require(meta.get("httpRoute") == "/checkout/:cart_id", "HTTP route mismatch")
    require(meta.get("httpStatusCode") == 202, "HTTP status mismatch")
    require(meta.get("serviceName") == "checkout-dotnet-service", "service name mismatch")
    require(meta.get("serviceVersion") == "1.0.0", "service version mismatch")
    require(meta.get("deploymentEnvironment") == "production", "deployment environment mismatch")
    require(meta.get("component") == "checkout", "static metadata missing")
    require(meta.get("feature") == "payments", "dynamic metadata missing")
    require(meta.get("activitySource") == "System.Net.Http", "dynamic ActivitySource metadata missing")


if __name__ == "__main__":
    main()
