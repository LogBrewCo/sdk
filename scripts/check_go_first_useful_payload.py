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
EXPECTED_OUTGOING_TRACEPARENT = (
    f"00-{EXPECTED_TRACE_ID}-{EXPECTED_CHILD_SPAN_ID}-01"
)
FORBIDDEN_PAYLOAD_TEXT = (
    "coupon=private",
    "card=private",
    "authorization",
    "payload",
    "headers",
    "#authorize",
    "?",
)


def _load_payload(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def check_payload(payload_path: Path, stderr_path: Path) -> None:
    payload_text = payload_path.read_text()
    for unsafe in FORBIDDEN_PAYLOAD_TEXT:
        _require(
            unsafe not in payload_text,
            f"first-useful telemetry leaked unsafe value: {unsafe}",
        )

    payload = json.loads(payload_text)
    events = payload["events"]
    event_types = [event["type"] for event in events]
    _require(
        event_types == ["release", "environment", "log", "action", "action", "metric", "span"],
        f"unexpected first-useful event order: {event_types!r}",
    )

    by_id = {event["id"]: event for event in events}
    log = by_id["evt_log_checkout_started"]["attributes"]
    _require(
        log["metadata"].get("traceId") == EXPECTED_TRACE_ID,
        "first-useful log is missing trace correlation",
    )
    _require(
        log["metadata"].get("sessionId") == EXPECTED_SESSION_ID,
        "first-useful log is missing session correlation",
    )

    product_metadata = by_id["evt_action_checkout_submit"]["attributes"]["metadata"]
    _require(
        product_metadata.get("source") == "product.action",
        "first-useful product action is missing product.action source",
    )
    _require(
        product_metadata.get("routeTemplate") == "/checkout/:cart_id",
        f"unexpected product route template: {product_metadata.get('routeTemplate')!r}",
    )

    network_metadata = by_id["evt_action_payment_api"]["attributes"]["metadata"]
    _require(
        network_metadata.get("source") == "network.milestone",
        "first-useful network action is missing network.milestone source",
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
        metric["metadata"].get("routeTemplate") == "/checkout/:cart_id",
        "first-useful metric must use route-template metadata",
    )
    _require(
        metric["metadata"].get("traceId") == EXPECTED_TRACE_ID,
        "first-useful metric is missing trace correlation",
    )

    span = by_id["evt_span_checkout_request"]["attributes"]
    _require(span.get("traceId") == EXPECTED_TRACE_ID, "first-useful span is missing trace id")
    _require(
        span.get("parentSpanId") == EXPECTED_PARENT_SPAN_ID,
        "first-useful span is missing upstream parent span id",
    )
    _require(
        span.get("spanId") == EXPECTED_CHILD_SPAN_ID,
        "first-useful span is missing fresh child span id",
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
    parser = argparse.ArgumentParser(description="Validate the Go first-useful telemetry example output.")
    parser.add_argument("payload", type=Path)
    parser.add_argument("stderr", type=Path)
    args = parser.parse_args()
    check_payload(args.payload, args.stderr)
    print("go first-useful telemetry payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
