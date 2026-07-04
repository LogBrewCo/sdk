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
    require(len(events) == 2, f"expected two OpenTelemetry spans, got {len(events)}")
    event = next(
        (
            item
            for item in events
            if isinstance(item, dict)
            and str(item.get("id", "")).startswith("checkout_otel_span_")
        ),
        None,
    )
    require(isinstance(event, dict), "expected processor OpenTelemetry span")
    require(event.get("type") == "span", "expected OpenTelemetry span event")
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
        "telemetrySdkName": "opentelemetry",
        "component": "checkout",
    }.items():
        require(metadata.get(key) == value, f"expected metadata {key}={value!r}")

    events_summary = attrs.get("events")
    require(isinstance(events_summary, list) and len(events_summary) == 1, "expected one span event summary")
    require(events_summary[0].get("name") == "cache.lookup", "expected event summary name")
    event_metadata = events_summary[0].get("metadata")
    require(isinstance(event_metadata, dict), "expected event summary metadata")
    require(event_metadata.get("messagingSystem") == "memory", "expected safe event metadata")

    exporter_event = next(
        (
            item
            for item in events
            if isinstance(item, dict)
            and str(item.get("id", "")).startswith("checkout_otel_exporter_span_")
        ),
        None,
    )
    require(isinstance(exporter_event, dict), "expected exporter OpenTelemetry span")
    require(exporter_event.get("type") == "span", "expected exporter span event")
    exporter_attrs = exporter_event.get("attributes")
    require(isinstance(exporter_attrs, dict), "expected exporter span attributes")
    require(exporter_attrs.get("name") == "POST /jobs/{id}", "expected exporter span name")
    require(exporter_attrs.get("status") == "error", "expected exporter span status")
    exporter_metadata = exporter_attrs.get("metadata")
    require(isinstance(exporter_metadata, dict), "expected exporter span metadata")
    for key, value in {
        "source": "dotnet.activity",
        "activityName": "POST /jobs/{id}",
        "activityKind": "producer",
        "activitySourceName": "Checkout.Exporter",
        "activitySourceVersion": "1.0.0",
        "messagingSystem": "memory",
        "messagingOperation": "publish",
        "serviceName": "checkout-worker",
        "serviceVersion": "1.0.0",
        "deploymentEnvironment": "staging",
        "otel.exception_event_count": 1,
        "otel.exception_escaped_count": 1,
        "otel.exception_types": "System.TimeoutException",
    }.items():
        require(exporter_metadata.get(key) == value, f"expected exporter metadata {key}={value!r}")
    exporter_events = exporter_attrs.get("events")
    require(isinstance(exporter_events, list) and len(exporter_events) == 1, "expected one exporter span event")
    require(exporter_events[0].get("name") == "exception", "expected exporter exception event")
    exporter_event_metadata = exporter_events[0].get("metadata")
    require(isinstance(exporter_event_metadata, dict), "expected exporter event metadata")
    require(exporter_event_metadata.get("exceptionType") == "System.TimeoutException", "expected exporter exception type")
    require(exporter_event_metadata.get("exceptionEscaped") is True, "expected exporter escaped exception flag")
    exporter_links = exporter_attrs.get("links")
    require(isinstance(exporter_links, list) and len(exporter_links) == 1, "expected one exporter span link")
    exporter_link_metadata = exporter_links[0].get("metadata")
    require(isinstance(exporter_link_metadata, dict), "expected exporter link metadata")
    require(exporter_link_metadata.get("messagingSystem") == "memory", "expected exporter link metadata")

    text = json.dumps(payload, sort_keys=True)
    for blocked in (
        "coupon=omitted",
        "example.test",
        "not captured",
        "message-id-omitted",
        "linked-message-id-omitted",
        "debug=omitted",
        "instance-opaque-marker",
        "service.instance.id",
        "url.full",
        "exception.message",
        "exception.stacktrace",
        "timeout opaque marker",
        "private stack",
    ):
        require(blocked not in text, f"expected OpenTelemetry payload to omit {blocked!r}")


if __name__ == "__main__":
    main()
