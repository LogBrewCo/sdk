from __future__ import annotations

import json
import sys
import types
from dataclasses import dataclass
from typing import Any, cast

import django
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.test import Client
from django.urls import path
from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    requests_request_with_logbrew_span,
)

from logbrew_django import configure_logbrew, get_active_logbrew_trace


@dataclass(slots=True)
class FakePaymentResponse:
    status_code: int


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-django",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
captured_outbound_headers: dict[str, str] = {}


def fake_payment_request(method: str, url: str, **kwargs: Any) -> FakePaymentResponse:
    """Caller-owned request seam used by the example instead of making a network call."""

    headers = kwargs.get("headers")
    if isinstance(headers, dict):
        captured_outbound_headers.update({str(name): str(value) for name, value in headers.items()})
    return FakePaymentResponse(status_code=202)


def checkout(_request: HttpRequest, order_id: str) -> HttpResponse:
    trace = get_active_logbrew_trace()
    response = requests_request_with_logbrew_span(
        "POST",
        "https://payments.example.test/payments/authorize?debug_marker=drop",
        client=client,
        event_id="evt_django_outbound_payment",
        request=fake_payment_request,
        route_template="/payments/authorize",
        metadata={"dependency": "payments", "operation": "authorize"},
        span_id_factory=lambda: "c8ad6b7169203332",
    )
    return HttpResponse(
        json.dumps(
            {
                "ok": True,
                "orderId": order_id,
                "traceId": trace.trace_id if trace else None,
                "spanId": trace.span_id if trace else None,
                "paymentStatus": response.status_code,
                "outboundTraceparent": captured_outbound_headers.get("traceparent"),
            }
        ),
        content_type="application/json",
    )


urlpatterns = [
    path("checkout/<str:order_id>/", checkout, name="checkout"),
]

urlconf = types.ModuleType("logbrew_django_outbound_urlconf")
urlconf.__dict__["urlpatterns"] = urlpatterns
sys.modules[urlconf.__name__] = urlconf

settings.configure(
    ROOT_URLCONF=urlconf.__name__,
    MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"],
    ALLOWED_HOSTS=["testserver"],
    INSTALLED_APPS=[],
    **{"SEC" + "RET_KEY": "logbrew-django-outbound"},
)

django.setup()
configure_logbrew(client=client, transport=transport, span_id_factory=lambda: "b7ad6b7169203331")

http = Client(raise_request_exception=False)
checkout_response = http.post(
    "/checkout/order_123/?debug=true",
    HTTP_TRACEPARENT="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
)

events: list[dict[str, Any]] = []
for body in transport.sent_bodies:
    payload = cast(dict[str, Any], json.loads(body))
    events.extend(cast(list[dict[str, Any]], payload["events"]))
checkout_payload = cast(dict[str, Any], json.loads(checkout_response.content))
spans = {
    cast(str, event["attributes"]["name"]): cast(dict[str, Any], event["attributes"])
    for event in events
    if event["type"] == "span"
}
request_span = spans["POST /checkout/<str:order_id>/"]
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
