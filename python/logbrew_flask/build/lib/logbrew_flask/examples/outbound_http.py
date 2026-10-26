# Copyright (c) 2026 LogBrew
"""Continue a Flask request trace through a caller-owned HTTP client."""

from __future__ import annotations

from dataclasses import dataclass

from logbrew_sdk import (
    requests_request_with_logbrew_span,
)

from logbrew_flask import get_active_logbrew_trace
from logbrew_flask.examples._support import example_app, named_spans, recorded_events, write_result


@dataclass(slots=True)
class FakePaymentResponse:
    """Return only the status needed by the local payment example."""

    status_code: int


app, client, transport = example_app(__name__)
captured_outbound_headers: dict[str, str] = {}


def fake_payment_request(_method: str, _url: str, **kwargs: object) -> FakePaymentResponse:
    """Record outbound headers without making a network call.

    Returns:
        A synthetic accepted payment response.

    """
    headers = kwargs.get("headers")
    if isinstance(headers, dict):
        captured_outbound_headers.update({str(name): str(value) for name, value in headers.items()})
    return FakePaymentResponse(status_code=202)


@app.post("/checkout/<order_id>")
def checkout(order_id: str) -> dict[str, object]:
    """Issue a synthetic payment request under the active Flask trace.

    Returns:
        The payment status and inbound and outbound correlation IDs.

    """
    trace = get_active_logbrew_trace()
    response = requests_request_with_logbrew_span(
        "POST",
        "https://payments.example.test/payments/authorize?debug_marker=drop",
        client=client,
        event_id="evt_flask_outbound_payment",
        request=fake_payment_request,
        route_template="/payments/authorize",
        metadata={"dependency": "payments", "operation": "authorize"},
        span_id_factory=lambda: "c8ad6b7169203332",
    )
    return {
        "ok": True,
        "orderId": order_id,
        "traceId": trace.trace_id if trace else None,
        "spanId": trace.span_id if trace else None,
        "paymentStatus": response.status_code,
        "outboundTraceparent": captured_outbound_headers.get("traceparent"),
    }


http = app.test_client()
checkout_response = http.post(
    "/checkout/order_123?debug=true",
    headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
)

events = recorded_events(transport)
spans = named_spans(events)
request_span = spans["POST /checkout/<order_id>"]
outbound_span = spans["POST /payments/authorize"]
outbound_metadata = outbound_span["metadata"]

write_result(
    client,
    events,
    {
        "checkoutStatus": checkout_response.status_code,
        "events": len(events),
        "requestSpanId": request_span["spanId"],
        "outboundParentSpanId": outbound_span["parentSpanId"],
        "outboundSpanId": outbound_span["spanId"],
        "outboundTraceparent": checkout_response.get_json()["outboundTraceparent"],
        "outboundRoute": outbound_metadata["routeTemplate"],
        "outboundSource": outbound_metadata["source"],
    },
)
