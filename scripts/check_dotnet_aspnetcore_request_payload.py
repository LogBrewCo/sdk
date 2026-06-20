#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
FORBIDDEN_TEXT = (
    "coupon=dropme",
    "authorization",
    "cookie",
    "traceparent",
    "http://127.0.0.1",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def event_by_type(events: list[dict[str, Any]], event_type: str) -> dict[str, Any]:
    matches = [event for event in events if event.get("type") == event_type]
    require(len(matches) == 1, f"expected one {event_type} event, got {len(matches)}")
    return matches[0]


def metadata(event: dict[str, Any]) -> dict[str, Any]:
    value = event.get("attributes", {}).get("metadata", {})
    require(isinstance(value, dict), "metadata must be an object")
    return value


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_aspnetcore_request_payload.py preview.json response.json")

    payload_text = Path(sys.argv[1]).read_text()
    response = json.loads(Path(sys.argv[2]).read_text())
    require(response == {"ok": True, "cartId": "cart_123"}, f"unexpected ASP.NET response: {response!r}")
    for unsafe in FORBIDDEN_TEXT:
        require(unsafe not in payload_text, f"ASP.NET request telemetry leaked unsafe text: {unsafe}")

    payload = json.loads(payload_text)
    events = payload.get("events", [])
    require([event.get("type") for event in events] == ["log", "span", "metric"], f"unexpected events: {events!r}")

    log = event_by_type(events, "log")
    span = event_by_type(events, "span")
    metric = event_by_type(events, "metric")
    span_attributes = span["attributes"]
    span_id = span_attributes["spanId"]
    require(log["id"] == "aspnetcore_log_1", f"unexpected log id: {log['id']!r}")
    require(span["id"].startswith("aspnetcore_request_span_"), "span event id must use request prefix")
    require(metric["id"].startswith("aspnetcore_request_metric_"), "metric event id must use request prefix")
    require(span["id"].endswith(span_id), "span event id must include span id")
    require(metric["id"].endswith(span_id), "metric event id must include span id")

    require(span_attributes["name"] == "GET /checkout/{cartId}", "span name must use route template")
    require(span_attributes["status"] == "ok", "successful request span should be ok")
    require(span_attributes["traceId"] == TRACE_ID, "span trace id mismatch")
    require(span_attributes["parentSpanId"] == PARENT_SPAN_ID, "span parent span mismatch")
    require(span_attributes["durationMs"] >= 0, "span duration must be non-negative")
    require(metric["attributes"]["name"] == "http.server.duration", "metric name mismatch")

    for event, label in ((log, "log"), (span, "span"), (metric, "metric")):
        meta = metadata(event)
        require(meta.get("traceId") == TRACE_ID, f"{label} trace id mismatch")
        require(meta.get("spanId") == span_id, f"{label} span id mismatch")
        require(meta.get("parentSpanId") == PARENT_SPAN_ID, f"{label} parent span mismatch")
        require(meta.get("traceFlags") == "01", f"{label} trace flags mismatch")
        require(meta.get("traceSampled") is True, f"{label} sampled flag mismatch")

    span_meta = metadata(span)
    metric_meta = metadata(metric)
    require(span_meta.get("source") == "aspnetcore.request", "span source metadata mismatch")
    require(span_meta.get("framework") == "aspnetcore", "framework metadata missing")
    require(span_meta.get("component") == "checkout-api", "component metadata missing")
    require(span_meta.get("method") == "GET", "method metadata missing")
    require(span_meta.get("routeTemplate") == "/checkout/{cartId}", "route template metadata mismatch")
    require(span_meta.get("statusCode") == 200, "status metadata missing")
    require(metric_meta.get("routeTemplate") == "/checkout/{cartId}", "metric route metadata mismatch")
    require(metadata(log).get("dotnetCategory") == "Program", "logger category mismatch")
    print("dotnet ASP.NET Core request telemetry payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
