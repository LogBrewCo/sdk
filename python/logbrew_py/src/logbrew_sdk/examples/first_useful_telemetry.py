"""Packaged first-useful telemetry example for installed Python users."""

from __future__ import annotations

import json
import logging
import sys

from logbrew_sdk import (
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    create_network_milestone_attributes,
    create_product_action_attributes,
    create_traceparent_headers,
    parse_traceparent,
    span_attributes_from_traceparent,
)


def main() -> int:
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    inbound_headers = create_traceparent_headers(
        trace_id=trace_id,
        span_id="00f067aa0ba902b7",
    )
    route_template = "/checkout/:cart_id"
    client = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="checkout-api",
        sdk_version="1.4.0",
    )

    client.release(
        "evt_release_checkout_api",
        "2026-06-15T08:00:00Z",
        {
            "version": "1.4.0",
            "commit": "abc123def456",
            "metadata": {"service": "checkout-api"},
        },
    )
    client.environment(
        "evt_environment_checkout_api",
        "2026-06-15T08:00:01Z",
        {"name": "production", "region": "us-east-1"},
    )

    logger = logging.getLogger("checkout-api")
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.addHandler(
        LogBrewLoggingHandler(
            client,
            metadata={"service": "checkout-api"},
        )
    )

    handle_checkout_request(
        client,
        logger,
        traceparent=inbound_headers["traceparent"],
        route_template=route_template,
    )

    payload = json.loads(client.preview_json())
    assert_first_useful_payload(payload, trace_id=trace_id)

    print(json.dumps(payload, indent=2))
    response = client.shutdown(RecordingTransport.always_accept())
    print(
        json.dumps(
            {
                "ok": True,
                "status": response.status_code,
                "attempts": response.attempts,
                "events": len(payload["events"]),
                "requestSpan": "evt_span_checkout_request",
                "traceId": trace_id,
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )
    return 0


def handle_checkout_request(
    client: LogBrewClient,
    logger: logging.Logger,
    *,
    traceparent: str,
    route_template: str,
) -> None:
    trace_context = parse_traceparent(traceparent)

    logger.info(
        "checkout request accepted",
        extra={
            "method": "POST",
            "routeTemplate": route_template,
            "traceId": trace_context.trace_id,
        },
    )
    client.action(
        "evt_action_checkout_started",
        "2026-06-15T08:00:03Z",
        create_product_action_attributes(
            {
                "name": "checkout started",
                "status": "running",
                "sessionId": "sess_checkout_123",
                "traceId": trace_context.trace_id,
                "routeTemplate": f"{route_template}?coupon=private#payment",
                "funnel": "checkout",
                "step": "payment",
                "metadata": {"service": "checkout-api", "payload": {"card": "redacted"}},
            }
        ),
    )
    client.action(
        "evt_network_payment_authorized",
        "2026-06-15T08:00:04Z",
        create_network_milestone_attributes(
            {
                "routeTemplate": "https://api.example.test/payments/:payment_id?card=private#receipt",
                "method": "post",
                "statusCode": 202,
                "durationMs": 43,
                "sessionId": "sess_checkout_123",
                "traceId": trace_context.trace_id,
                "metadata": {"service": "checkout-api", "headers": {"authorization": "redacted"}},
            }
        ),
    )
    client.metric(
        "evt_metric_checkout_duration",
        "2026-06-15T08:00:05Z",
        {
            "name": "checkout.duration",
            "kind": "histogram",
            "value": 128,
            "unit": "ms",
            "temporality": "delta",
            "metadata": {
                "routeTemplate": route_template,
                "traceId": trace_context.trace_id,
            },
        },
    )
    client.span(
        "evt_span_checkout_request",
        "2026-06-15T08:00:06Z",
        span_attributes_from_traceparent(
            traceparent,
            name="POST /checkout/:cart_id",
            span_id="b7ad6b7169203331",
            status="ok",
            duration_ms=17,
            metadata={
                "method": "POST",
                "routeTemplate": route_template,
                "service": "checkout-api",
            },
        ),
    )


def assert_first_useful_payload(payload: dict[str, object], *, trace_id: str) -> None:
    events = payload.get("events")
    if not isinstance(events, list):
        raise RuntimeError(f"missing events: {payload}")
    event_ids = [event.get("id") for event in events if isinstance(event, dict)]
    if len(event_ids) != 7 or event_ids[:2] != [
        "evt_release_checkout_api",
        "evt_environment_checkout_api",
    ] or event_ids[3:] != [
        "evt_action_checkout_started",
        "evt_network_payment_authorized",
        "evt_metric_checkout_duration",
        "evt_span_checkout_request",
    ]:
        raise RuntimeError(f"unexpected event order: {event_ids}")
    log_event = events[2]
    if (
        not isinstance(log_event, dict)
        or log_event.get("type") != "log"
        or not str(log_event.get("id", "")).startswith("evt_log_checkout_api_")
    ):
        raise RuntimeError(f"unexpected log event: {log_event}")

    output = json.dumps(payload)
    for forbidden in ("coupon=private", "card=private", "authorization", "redacted"):
        if forbidden in output:
            raise RuntimeError(f"first useful telemetry leaked private data: {forbidden}")

    request_span = find_event(events, "evt_span_checkout_request")
    request_attributes = require_attributes(request_span)
    if request_attributes["traceId"] != trace_id:
        raise RuntimeError(f"unexpected request span trace: {request_span}")
    if request_attributes["parentSpanId"] != "00f067aa0ba902b7":
        raise RuntimeError(f"unexpected request span parent: {request_span}")

    network_event = find_event(events, "evt_network_payment_authorized")
    network_attributes = require_attributes(network_event)
    network_metadata = network_attributes.get("metadata")
    if not isinstance(network_metadata, dict) or network_metadata.get("routeTemplate") != "/payments/:payment_id":
        raise RuntimeError(f"unexpected network route template: {network_event}")


def find_event(events: list[object], event_id: str) -> dict[str, object]:
    for event in events:
        if isinstance(event, dict) and event.get("id") == event_id:
            return event
    raise RuntimeError(f"missing event: {event_id}")


def require_attributes(event: dict[str, object]) -> dict[str, object]:
    attributes = event.get("attributes")
    if not isinstance(attributes, dict):
        raise RuntimeError(f"missing attributes: {event}")
    return attributes


if __name__ == "__main__":
    raise SystemExit(main())
