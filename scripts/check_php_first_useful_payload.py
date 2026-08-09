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


def check_payload(payload_path: Path, stderr_path: Path) -> None:
    payload_text = payload_path.read_text()
    for unsafe in FORBIDDEN_PAYLOAD_TEXT:
        _require(unsafe not in payload_text, f"first-useful telemetry leaked unsafe value: {unsafe}")

    payload = _load_payload(payload_path)
    events = payload["events"]
    event_types = [event["type"] for event in events]
    _require(
        event_types == ["release", "environment", "log", "action", "action", "metric", "span"],
        f"unexpected first-useful event order: {event_types!r}",
    )

    by_id = {event["id"]: event for event in events}
    log = by_id["evt_log_checkout_started"]["attributes"]
    log_context = log["context"]
    _require(log_context.get("schemaVersion") == 1, "first-useful log is missing schema-v1 context")
    _require(
        log_context["resource"]["service"] == {"name": "checkout-service", "version": "1.2.3"},
        f"unexpected first-useful service context: {log_context['resource']['service']!r}",
    )
    _require(
        log_context["resource"]["deployment"]
        == {"environment": "production", "release": "checkout@1.2.3"},
        f"unexpected first-useful deployment context: {log_context['resource']['deployment']!r}",
    )
    _require(
        log_context["trace"].get("traceId") == EXPECTED_TRACE_ID,
        "first-useful log is missing typed trace correlation",
    )
    _require(
        log_context["session"].get("id") == EXPECTED_SESSION_ID,
        "first-useful log is missing typed session correlation",
    )
    _require(
        log_context["subject"] == {"id": "visitor_checkout_123", "kind": "anonymous"},
        f"unexpected first-useful subject context: {log_context['subject']!r}",
    )
    _require(
        log_context["tags"] == {"journey": "checkout", "region": "global"},
        f"unexpected first-useful tags: {log_context['tags']!r}",
    )

    product_metadata = by_id["evt_action_checkout_submit"]["attributes"]["metadata"]
    _require(
        product_metadata.get("source") == "product_timeline",
        "first-useful product action is missing product_timeline source",
    )
    _require(
        product_metadata.get("routeTemplate") == "/checkout/:cart_id",
        f"unexpected product route template: {product_metadata.get('routeTemplate')!r}",
    )

    network_metadata = by_id["evt_action_payment_api"]["attributes"]["metadata"]
    _require(
        network_metadata.get("source") == "network_timeline",
        "first-useful network action is missing network_timeline source",
    )
    _require(
        network_metadata.get("routeTemplate") == "/payments/:payment_id",
        f"unexpected network route template: {network_metadata.get('routeTemplate')!r}",
    )
    _require(
        network_metadata.get("method") == "POST" and network_metadata.get("statusCode") == 202,
        f"unexpected network method/status metadata: {network_metadata!r}",
    )

    metric = by_id["evt_metric_http_server_duration"]["attributes"]
    _require(
        metric.get("name") == "http.server.duration" and metric.get("kind") == "histogram",
        f"unexpected first-useful metric shape: {metric!r}",
    )
    _require(
        metric.get("description") == "Duration of one completed server request.",
        "first-useful metric is missing its stable meaning",
    )
    _require(
        metric["metadata"].get("routeTemplate") == "/checkout/:cart_id",
        "first-useful metric must use route-template metadata",
    )
    _require(
        metric["context"]["trace"].get("traceId") == EXPECTED_TRACE_ID,
        "first-useful metric is missing typed trace correlation",
    )

    span = by_id["evt_span_checkout_request"]["attributes"]
    _require(span.get("traceId") == EXPECTED_TRACE_ID, "first-useful span is missing trace id")
    _require(
        span.get("parentSpanId") == EXPECTED_PARENT_SPAN_ID,
        "first-useful span is missing upstream parent span id",
    )
    _require(span.get("spanId") == EXPECTED_CHILD_SPAN_ID, "first-useful span is missing fresh child span id")
    _require(
        span["context"]["trace"].get("sampled") is True,
        "first-useful span should expose sampled typed trace context",
    )
    _require(
        span["context"]["session"].get("id") == EXPECTED_SESSION_ID,
        "first-useful span is missing typed session correlation",
    )

    for event_id in (
        "evt_log_checkout_started",
        "evt_action_checkout_submit",
        "evt_action_payment_api",
        "evt_metric_http_server_duration",
        "evt_span_checkout_request",
    ):
        context = by_id[event_id]["attributes"]["context"]
        _require(
            context["trace"].get("traceId") == EXPECTED_TRACE_ID
            and context["session"].get("id") == EXPECTED_SESSION_ID,
            f"first-useful event {event_id!r} is not correlated through typed context",
        )

    stderr = _load_payload(stderr_path)
    _require(
        stderr.get("events") == 7 and stderr.get("status") == 202 and bool(stderr.get("ok")),
        f"unexpected first-useful stderr summary: {stderr!r}",
    )
    _require(
        stderr.get("outgoingTraceparent") == EXPECTED_OUTGOING_TRACEPARENT,
        f"unexpected outgoing traceparent: {stderr.get('outgoingTraceparent')!r}",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the PHP first-useful telemetry example output.")
    parser.add_argument("payload", type=Path)
    parser.add_argument("stderr", type=Path)
    args = parser.parse_args()
    check_payload(args.payload, args.stderr)
    print("php first-useful telemetry payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
