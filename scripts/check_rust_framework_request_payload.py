#!/usr/bin/env python3
"""Shared validator for Rust framework request telemetry examples."""

from __future__ import annotations

import json
import math
from pathlib import Path


def load_json(path: str) -> object:
    return json.loads(Path(path).read_text())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def validate_payload(
    stdout_json: str, stderr_json: str, *, framework: str, route_template: str
) -> None:
    payload = load_json(stdout_json)
    stderr = load_json(stderr_json)
    require(isinstance(payload, dict), "stdout payload must be an object")
    events = payload.get("events")
    require(isinstance(events, list), "stdout events must be a list")
    require([event.get("type") for event in events] == ["span", "metric"], "unexpected events")

    span = events[0]["attributes"]
    metric = events[1]["attributes"]
    require(span["name"] == f"POST {route_template}", "unexpected span name")
    require(span["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736", "bad trace id")
    require(span["spanId"] == "b7ad6b7169203331", "bad span id")
    require(span["parentSpanId"] == "00f067aa0ba902b7", "bad parent span id")
    require(span["status"] == "ok", "unexpected span status")
    require(isinstance(span["durationMs"], (int, float)), "span duration must be numeric")
    require(math.isfinite(span["durationMs"]), "span duration must be finite")
    require(span["durationMs"] >= 0, "span duration must be non-negative")

    metadata = span["metadata"]
    require(metadata["source"] == "rust_http_server", "bad metadata source")
    require(metadata["framework"] == framework, "missing framework metadata")
    require(metadata["service"] == "checkout-service", "missing service metadata")
    require(metadata["routeTemplate"] == route_template, "route was not templated")
    require(metadata["method"] == "POST", "method was not normalized")
    require(metadata["statusCode"] == 202, "bad status code")
    require(metadata["statusCodeClass"] == "2xx", "bad status code class")

    require(metric["name"] == "http.server.duration", "bad metric name")
    require(metric["kind"] == "histogram", "bad metric kind")
    require(metric["value"] == span["durationMs"], "metric/span duration should match")
    require(metric["unit"] == "ms", "bad metric unit")
    require(metric["temporality"] == "delta", "bad metric temporality")
    require(metric["metadata"] == metadata, "metric/span metadata should match")

    text = Path(stdout_json).read_text().lower()
    for forbidden in ["coupon=sample", "cart_123", "authorization", "headers", "payload"]:
        require(forbidden not in text, f"unsafe text leaked: {forbidden}")

    require(stderr["ok"] is True, "stderr ok must be true")
    require(stderr["status"] == 202, "transport status must be 202")
    require(stderr["attempts"] == 1, "transport attempts must be 1")
    require(stderr["events"] == 2, "stderr event count must be 2")
    require(
        stderr["responseTraceparent"]
        == "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
        "bad response traceparent",
    )
