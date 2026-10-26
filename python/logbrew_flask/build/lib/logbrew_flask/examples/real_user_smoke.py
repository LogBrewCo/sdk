# Copyright (c) 2026 LogBrew
"""Capture a healthy logged request and a redacted unhandled exception."""

from __future__ import annotations

import logging

from logbrew_sdk import LogBrewLoggingHandler

from logbrew_flask import get_active_logbrew_trace
from logbrew_flask.examples._support import example_app, named_spans, recorded_events, write_result

app, client, transport = example_app(__name__)
# This example must not change an embedding application's registered logger.
# Reviewed 2026-09-05; the package test checks its handlers, level, propagation.
logger = logging.Logger("flask.checkout.example", logging.INFO)  # noqa: LOG001
logger.addHandler(LogBrewLoggingHandler(client, metadata={"service": "checkout"}))


@app.get("/health")
def health() -> dict[str, object]:
    """Log one operation inside the healthy request.

    Returns:
        The health result and active request correlation IDs.

    """
    trace = get_active_logbrew_trace()
    logger.info("health request", extra={"route_template": "/health"})
    return {
        "ok": True,
        "traceId": trace.trace_id if trace else None,
        "spanId": trace.span_id if trace else None,
    }


@app.get("/boom")
def boom() -> dict[str, bool]:
    """Raise the synthetic application failure.

    Raises:
        RuntimeError: Always, to demonstrate unhandled exception capture.

    """
    message = "broken handler"
    raise RuntimeError(message)


http = app.test_client()
health_response = http.get(
    "/health?debug=true",
    headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
)
boom_response = http.get("/boom", buffered=True)

events = recorded_events(transport)
first_span_attributes = named_spans(events)["GET /health"]

write_result(
    client,
    events,
    {
        "healthStatus": health_response.status_code,
        "boomStatus": boom_response.status_code,
        "events": len(events),
        "traceId": health_response.get_json()["traceId"],
        "spanId": health_response.get_json()["spanId"],
        "parentSpanId": first_span_attributes["parentSpanId"],
        "routeTemplate": first_span_attributes["metadata"]["routeTemplate"],
    },
)
