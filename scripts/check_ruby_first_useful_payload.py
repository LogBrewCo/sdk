#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EXPECTED_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
EXPECTED_SESSION_ID = "sess_checkout_123"
EXPECTED_PARENT_SPAN_ID = "00f067aa0ba902b7"
EXPECTED_CHILD_SPAN_ID = "b7ad6b7169203331"
EXPECTED_OUTGOING_TRACEPARENT = f"00-{EXPECTED_TRACE_ID}-{EXPECTED_CHILD_SPAN_ID}-01"
FORBIDDEN_PAYLOAD_TEXT = (
    "coupon=sample",
    "card=sample",
    "authorization",
    "payload",
    "headers",
    "#review",
    "?",
)


def _load_payload(path: Path) -> dict[str, Any]:
    text = path.read_text().strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end < start:
            raise
        return json.loads(text[start : end + 1])


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def _context(event: dict[str, Any]) -> dict[str, Any]:
    context = event.get("attributes", {}).get("context")
    _require(isinstance(context, dict), f"ruby first-useful event is missing typed context: {event.get('id')}")
    return context


def check_payload(payload_path: Path, stderr_path: Path) -> None:
    payload_text = payload_path.read_text()
    for unsafe in FORBIDDEN_PAYLOAD_TEXT:
        _require(unsafe not in payload_text, f"ruby first-useful telemetry leaked unsafe value: {unsafe}")

    payload = _load_payload(payload_path)
    events = payload["events"]
    event_types = [event["type"] for event in events]
    _require(
        event_types == ["release", "environment", "log", "action", "action", "metric", "span"],
        f"unexpected ruby first-useful event order: {event_types!r}",
    )

    by_id = {event["id"]: event for event in events}
    for event in events:
        context = _context(event)
        _require(context.get("schemaVersion") == 1, "ruby first-useful context schema version is not 1")
        resource = context.get("resource", {})
        _require(
            resource.get("service") == {"name": "checkout-service", "version": "1.2.3"},
            f"unexpected ruby service context: {resource.get('service')!r}",
        )
        _require(
            resource.get("deployment") == {
                "environment": "production",
                "release": "checkout@1.2.3",
            },
            f"unexpected ruby deployment context: {resource.get('deployment')!r}",
        )
        _require(resource.get("framework", {}).get("name") == "rack", "ruby framework context is missing")
        _require(resource.get("runtime", {}).get("name") in {"ruby", "jruby", "truffleruby"}, "ruby runtime name is missing")
        _require(bool(resource.get("runtime", {}).get("version")), "ruby runtime version is missing")
        _require(bool(resource.get("operatingSystem", {}).get("name")), "ruby operating-system context is missing")
        _require(bool(resource.get("device", {}).get("architecture")), "ruby architecture context is missing")
        _require(context.get("tags", {}).get("region") == "global", "ruby service context tag is missing")

    request_event_ids = {
        "evt_log_checkout_started",
        "evt_action_checkout_submit",
        "evt_action_payment_api",
        "evt_metric_http_server_duration",
        "evt_span_checkout_request",
    }
    for event_id in request_event_ids:
        context = _context(by_id[event_id])
        _require(context.get("trace", {}).get("traceId") == EXPECTED_TRACE_ID, f"{event_id} is missing typed trace context")
        _require(context.get("trace", {}).get("spanId") == EXPECTED_CHILD_SPAN_ID, f"{event_id} is missing typed span context")
        _require(context.get("trace", {}).get("parentSpanId") == EXPECTED_PARENT_SPAN_ID, f"{event_id} is missing typed parent span")
        _require(context.get("session", {}).get("id") == EXPECTED_SESSION_ID, f"{event_id} is missing typed session context")
        _require(context.get("subject", {}).get("id") == "subject_checkout_123", f"{event_id} is missing opaque subject context")
        _require(context.get("subject", {}).get("kind") == "user", f"{event_id} has unexpected subject kind")
        _require(context.get("tags", {}).get("journey") == "checkout", f"{event_id} is missing journey tag")
        _require(context.get("tags", {}).get("surface") == "payment", f"{event_id} is missing surface tag")

    log = by_id["evt_log_checkout_started"]["attributes"]
    _require(log["metadata"].get("routeTemplate") == "/checkout/:cart_id", "ruby first-useful log is missing route template")

    product_metadata = by_id["evt_action_checkout_submit"]["attributes"]["metadata"]
    _require(
        product_metadata.get("source") == "product_timeline",
        "ruby first-useful product action is missing product_timeline source",
    )
    _require(
        product_metadata.get("routeTemplate") == "/checkout/:cart_id",
        f"unexpected ruby product route template: {product_metadata.get('routeTemplate')!r}",
    )

    network_metadata = by_id["evt_action_payment_api"]["attributes"]["metadata"]
    _require(
        network_metadata.get("source") == "network_timeline",
        "ruby first-useful network action is missing network_timeline source",
    )
    _require(
        network_metadata.get("routeTemplate") == "/payments/:payment_id",
        f"unexpected ruby network route template: {network_metadata.get('routeTemplate')!r}",
    )
    _require(
        network_metadata.get("method") == "POST" and network_metadata.get("statusCode") == 202,
        f"unexpected ruby network method/status metadata: {network_metadata!r}",
    )

    metric = by_id["evt_metric_http_server_duration"]["attributes"]
    _require(
        metric.get("name") == "http.server.duration" and metric.get("kind") == "histogram",
        f"unexpected ruby first-useful metric shape: {metric!r}",
    )
    _require(
        metric.get("description") == "Duration of one completed server request.",
        "ruby first-useful metric is missing its stable meaning",
    )
    _require(
        metric["metadata"].get("routeTemplate") == "/checkout/:cart_id",
        "ruby first-useful metric must use route-template metadata",
    )

    span = by_id["evt_span_checkout_request"]["attributes"]
    _require(span.get("traceId") == EXPECTED_TRACE_ID, "ruby first-useful span is missing trace id")
    _require(
        span.get("parentSpanId") == EXPECTED_PARENT_SPAN_ID,
        "ruby first-useful span is missing upstream parent span id",
    )
    _require(span.get("spanId") == EXPECTED_CHILD_SPAN_ID, "ruby first-useful span is missing fresh child span id")
    _require(span["metadata"].get("sampled") is True, "ruby first-useful span should expose sampled trace context")

    stderr = _load_payload(stderr_path)
    _require(
        stderr.get("events") == 7 and stderr.get("status") == 202 and bool(stderr.get("ok")),
        f"unexpected ruby first-useful stderr summary: {stderr!r}",
    )
    _require(
        stderr.get("outgoingTraceparent") == EXPECTED_OUTGOING_TRACEPARENT,
        f"unexpected ruby outgoing traceparent: {stderr.get('outgoingTraceparent')!r}",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the Ruby first-useful telemetry example output.")
    parser.add_argument("payload", type=Path)
    parser.add_argument("stderr", type=Path)
    args = parser.parse_args()
    check_payload(args.payload, args.stderr)
    print("ruby first-useful telemetry payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
