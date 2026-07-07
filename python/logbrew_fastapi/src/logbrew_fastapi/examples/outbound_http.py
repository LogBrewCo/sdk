from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, cast

from fastapi import FastAPI
from fastapi.testclient import TestClient
from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    requests_request_with_logbrew_span,
)

from logbrew_fastapi import add_logbrew_middleware, get_active_logbrew_trace


@dataclass(slots=True)
class FakePaymentResponse:
    status_code: int


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-fastapi",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
app = FastAPI()
add_logbrew_middleware(app, client=client, transport=transport, span_id_factory=lambda: "b7ad6b7169203331")
captured_outbound_headers: dict[str, str] = {}


def fake_payment_request(method: str, url: str, **kwargs: Any) -> FakePaymentResponse:
    """Caller-owned request seam used by the example instead of making a network call."""

    headers = kwargs.get("headers")
    if isinstance(headers, dict):
        captured_outbound_headers.update({str(name): str(value) for name, value in headers.items()})
    return FakePaymentResponse(status_code=202)


@app.post("/checkout/{order_id}")
def checkout(order_id: str) -> dict[str, object]:
    trace = get_active_logbrew_trace()
    response = requests_request_with_logbrew_span(
        "POST",
        "https://payments.example.test/payments/authorize?debug_marker=drop",
        client=client,
        event_id="evt_fastapi_outbound_payment",
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


with TestClient(app) as http:
    checkout_response = http.post(
        "/checkout/order_123?debug=true",
        headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
    )

events: list[dict[str, Any]] = []
for body in transport.sent_bodies:
    payload = cast(dict[str, Any], json.loads(body))
    events.extend(cast(list[dict[str, Any]], payload["events"]))
checkout_payload = cast(dict[str, Any], checkout_response.json())
spans = {
    cast(str, event["attributes"]["name"]): cast(dict[str, Any], event["attributes"])
    for event in events
    if event["type"] == "span"
}
request_span = spans["POST /checkout/{order_id}"]
outbound_span = spans["POST /payments/authorize"]
outbound_metadata = cast(dict[str, Any], outbound_span["metadata"])
outbound_traceparent = cast(str, checkout_payload["outboundTraceparent"])
outbound_traceparent_span_id = outbound_traceparent.split("-")[2]

print(json.dumps({"sdk": client.sdk, "events": events}, indent=2))
print(
    json.dumps(
        {
            "checkoutStatus": checkout_response.status_code,
            "events": len(events),
            "requestSpanId": request_span["spanId"],
            "outboundParentSpanId": outbound_span["parentSpanId"],
            "outboundSpanId": outbound_span["spanId"],
            "outboundTraceparent": outbound_traceparent,
            "traceparentMatchesSpan": outbound_traceparent_span_id == outbound_span["spanId"],
            "outboundRoute": outbound_metadata["routeTemplate"],
            "outboundSource": outbound_metadata["source"],
        },
        indent=2,
    ),
    file=sys.stderr,
)
