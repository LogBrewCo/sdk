#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_opentelemetry_payload.py <stdout-json> <stderr-json>")

    payload = load(sys.argv[1])
    stderr = Path(sys.argv[2]).read_text(encoding="utf-8")
    require(stderr == "", "expected OpenTelemetry example stderr to be empty")
    events = payload.get("events")
    require(isinstance(events, list), "expected events list")
    require(len(events) == 1, f"expected one OpenTelemetry span, got {len(events)}")
    event = events[0]
    require(event.get("type") == "span", "expected OpenTelemetry span event")
    require(str(event.get("id", "")).startswith("checkout_otel_span_"), "expected OpenTelemetry event id prefix")
    attrs = event.get("attributes")
    require(isinstance(attrs, dict), "expected span attributes")
    require(attrs.get("name") == "GET /checkout/{id}", "expected sanitized span name")
    require(attrs.get("status") == "ok", "expected span status")
    require(isinstance(attrs.get("traceId"), str) and len(attrs["traceId"]) == 32, "expected trace id")
    require(isinstance(attrs.get("spanId"), str) and len(attrs["spanId"]) == 16, "expected span id")

    metadata = attrs.get("metadata")
    require(isinstance(metadata, dict), "expected span metadata")
    for key, value in {
        "source": "dotnet.activity",
        "activityName": "GET /checkout/{id}",
        "activityKind": "server",
        "activitySourceName": "Checkout.Api",
        "activitySourceVersion": "1.0.0",
        "traceFlags": "01",
        "traceSampled": True,
        "httpMethod": "GET",
        "httpRoute": "/checkout/{id}",
        "httpStatusCode": 200,
        "serviceName": "checkout-api",
        "serviceVersion": "1.0.0",
        "deploymentEnvironment": "production",
        "component": "checkout",
    }.items():
        require(metadata.get(key) == value, f"expected metadata {key}={value!r}")

    events_summary = attrs.get("events")
    require(isinstance(events_summary, list) and len(events_summary) == 1, "expected one span event summary")
    require(events_summary[0].get("name") == "cache.lookup", "expected event summary name")
    event_metadata = events_summary[0].get("metadata")
    require(isinstance(event_metadata, dict), "expected event summary metadata")
    require(event_metadata.get("messagingSystem") == "memory", "expected safe event metadata")

    text = json.dumps(payload, sort_keys=True)
    for blocked in (
        "coupon=omitted",
        "example.test",
        "not captured",
        "url.full",
        "exception.message",
    ):
        require(blocked not in text, f"expected OpenTelemetry payload to omit {blocked!r}")


if __name__ == "__main__":
    main()
