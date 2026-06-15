#!/usr/bin/env python3
"""Validate the Rust HTTP server request helper preview payload."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load_json(path: str) -> object:
    return json.loads(Path(path).read_text())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: check_rust_http_server_payload.py STDOUT_JSON STDERR_JSON"
        )

    payload = load_json(sys.argv[1])
    stderr = load_json(sys.argv[2])
    require(isinstance(payload, dict), "stdout payload must be an object")
    events = payload.get("events")
    require(isinstance(events, list), "stdout events must be a list")
    require([event.get("type") for event in events] == ["span", "metric"], "unexpected events")

    span = events[0]["attributes"]
    metric = events[1]["attributes"]
    require(span["name"] == "POST /checkout/:cart_id", "unexpected span name")
    require(span["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736", "bad trace id")
    require(span["spanId"] == "b7ad6b7169203331", "bad span id")
    require(span["parentSpanId"] == "00f067aa0ba902b7", "bad parent span id")
    require(span["status"] == "ok", "unexpected span status")
    require(span["durationMs"] == 183.4, "unexpected span duration")
    metadata = span["metadata"]
    require(metadata["source"] == "rust_http_server", "bad metadata source")
    require(metadata["framework"] == "axum", "missing framework metadata")
    require(metadata["routeTemplate"] == "/checkout/:cart_id", "route was not sanitized")
    require(metadata["method"] == "POST", "method was not normalized")
    require(metadata["statusCode"] == 202, "bad status code")
    require(metadata["statusCodeClass"] == "2xx", "bad status code class")

    require(metric["name"] == "http.server.duration", "bad metric name")
    require(metric["kind"] == "histogram", "bad metric kind")
    require(metric["value"] == 183.4, "bad metric value")
    require(metric["unit"] == "ms", "bad metric unit")
    require(metric["temporality"] == "delta", "bad metric temporality")
    require(metric["metadata"] == metadata, "metric/span metadata should match")

    text = Path(sys.argv[1]).read_text()
    for forbidden in ["coupon=sample", "#review", "authorization", "headers", "payload"]:
        require(forbidden not in text.lower(), f"unsafe text leaked: {forbidden}")

    require(stderr["ok"] is True, "stderr ok must be true")
    require(stderr["status"] == 202, "transport status must be 202")
    require(stderr["attempts"] == 1, "transport attempts must be 1")
    require(stderr["events"] == 2, "stderr event count must be 2")
    require(
        stderr["outgoingTraceparent"]
        == "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
        "bad outgoing traceparent",
    )
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
