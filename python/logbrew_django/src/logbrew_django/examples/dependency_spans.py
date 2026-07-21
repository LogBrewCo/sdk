from __future__ import annotations

import json
import sqlite3
import sys
import types
from typing import Any, cast

import django
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.test import Client
from django.urls import path
from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    cache_operation_with_logbrew_span,
    database_operation_with_logbrew_span,
    queue_operation_with_logbrew_span,
)

from logbrew_django import configure_logbrew, get_active_logbrew_trace

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-django",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
database = sqlite3.connect(":memory:", check_same_thread=False)
database.execute("CREATE TABLE inventory (sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL)")
database.execute("INSERT INTO inventory (sku, quantity) VALUES (?, ?)", ("sku_123", 4))
database.commit()
cache: dict[str, int] = {"sku_123": 4}
queue: list[str] = []


def select_inventory() -> sqlite3.Row | tuple[Any, ...] | None:
    return cast(
        sqlite3.Row | tuple[Any, ...] | None,
        database.execute("SELECT quantity FROM inventory WHERE sku = ?", ("sku_123",)).fetchone(),
    )


def read_inventory_cache() -> int:
    return cache["sku_123"]


def publish_checkout_event() -> int:
    queue.append("checkout.completed")
    return len(queue)


def checkout(_request: HttpRequest, order_id: str) -> HttpResponse:
    trace = get_active_logbrew_trace()
    inventory_row = database_operation_with_logbrew_span(
        "SELECT inventory",
        client=client,
        event_id="evt_django_dependency_database",
        operation=select_inventory,
        system="sqlite",
        db_name="checkout",
        statement_template="SELECT inventory WHERE sku = ?",
        row_count=1,
        metadata={"dependency": "inventory"},
        span_id_factory=lambda: "c8ad6b7169203332",
    )
    inventory_count = int(inventory_row[0]) if inventory_row else 0
    cached_count = cache_operation_with_logbrew_span(
        "GET inventory",
        client=client,
        event_id="evt_django_dependency_cache",
        operation=read_inventory_cache,
        system="memory-cache",
        cache_name="inventory-cache",
        cache_hit=True,
        item_count=1,
        metadata={"dependency": "inventory-cache"},
        span_id_factory=lambda: "d9ad6b7169203333",
    )
    published_count = queue_operation_with_logbrew_span(
        "PUBLISH checkout.completed",
        client=client,
        event_id="evt_django_dependency_queue",
        operation=publish_checkout_event,
        system="memory-queue",
        operation_kind="publish",
        queue_name="checkout-events",
        task_name="checkout.completed",
        message_count=1,
        metadata={"dependency": "checkout-events"},
        span_id_factory=lambda: "e0ad6b7169203334",
    )
    return HttpResponse(
        json.dumps(
            {
                "ok": inventory_count == cached_count and published_count == 1,
                "orderId": order_id,
                "traceId": trace.trace_id if trace else None,
                "spanId": trace.span_id if trace else None,
            }
        ),
        content_type="application/json",
    )


urlpatterns = [
    path("checkout/<str:order_id>/", checkout, name="checkout"),
]

urlconf = types.ModuleType("logbrew_django_dependency_urlconf")
urlconf.__dict__["urlpatterns"] = urlpatterns
sys.modules[urlconf.__name__] = urlconf

settings.configure(
    ROOT_URLCONF=urlconf.__name__,
    MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"],
    ALLOWED_HOSTS=["testserver"],
    INSTALLED_APPS=[],
    **{"SEC" + "RET_KEY": "logbrew-django-dependencies"},
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
spans = {
    cast(str, event["attributes"]["name"]): cast(dict[str, Any], event["attributes"])
    for event in events
    if event["type"] == "span"
}
request_span = spans["POST /checkout/<str:order_id>/"]
database_span = spans["sqlite SELECT inventory"]
cache_span = spans["memory-cache GET inventory"]
queue_span = spans["memory-queue PUBLISH checkout.completed"]

print(json.dumps({"sdk": client.sdk, "events": events}, indent=2))
print(
    json.dumps(
        {
            "checkoutStatus": checkout_response.status_code,
            "events": len(events),
            "requestSpanId": request_span["spanId"],
            "databaseParentSpanId": database_span["parentSpanId"],
            "databaseSpanId": database_span["spanId"],
            "cacheParentSpanId": cache_span["parentSpanId"],
            "cacheSpanId": cache_span["spanId"],
            "queueParentSpanId": queue_span["parentSpanId"],
            "queueSpanId": queue_span["spanId"],
            "dependencySpanNames": [database_span["name"], cache_span["name"], queue_span["name"]],
        },
        indent=2,
    ),
    file=sys.stderr,
)
