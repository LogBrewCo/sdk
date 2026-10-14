# Copyright (c) 2026 LogBrew
"""Connect local database, cache, and queue work to one Flask request."""

from __future__ import annotations

import sqlite3
from typing import cast

from logbrew_sdk import (
    cache_operation_with_logbrew_span,
    database_operation_with_logbrew_span,
    queue_operation_with_logbrew_span,
)

from logbrew_flask import get_active_logbrew_trace
from logbrew_flask.examples._support import example_app, named_spans, recorded_events, write_result

app, client, transport = example_app(__name__)

database = sqlite3.connect(":memory:", check_same_thread=False)
database.execute("CREATE TABLE inventory (sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL)")
database.execute("INSERT INTO inventory (sku, quantity) VALUES (?, ?)", ("sku_123", 4))
database.commit()
cache: dict[str, int] = {"sku_123": 4}
queue: list[str] = []


def select_inventory() -> tuple[int] | None:
    """Read the local example inventory.

    Returns:
        The stock count row, or None when the SKU is absent.

    """
    return cast(
        "tuple[int] | None",
        database.execute("SELECT quantity FROM inventory WHERE sku = ?", ("sku_123",)).fetchone(),
    )


def publish_checkout_event() -> int:
    """Append a synthetic checkout event to the local queue.

    Returns:
        The queue length after publication.

    """
    queue.append("checkout.completed")
    return len(queue)


@app.post("/checkout/<order_id>")
def checkout(order_id: str) -> dict[str, object]:
    """Run local dependency operations under the active request trace.

    Returns:
        The inventory result and request correlation IDs.

    """
    trace = get_active_logbrew_trace()
    inventory_row = database_operation_with_logbrew_span(
        "SELECT inventory",
        client=client,
        event_id="evt_flask_dependency_database",
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
        event_id="evt_flask_dependency_cache",
        operation=lambda: cache["sku_123"],
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
        event_id="evt_flask_dependency_queue",
        operation=publish_checkout_event,
        system="memory-queue",
        operation_kind="publish",
        queue_name="checkout-events",
        task_name="checkout.completed",
        message_count=1,
        metadata={"dependency": "checkout-events"},
        span_id_factory=lambda: "e0ad6b7169203334",
    )
    return {
        "ok": inventory_count == cached_count and published_count == 1,
        "orderId": order_id,
        "traceId": trace.trace_id if trace else None,
        "spanId": trace.span_id if trace else None,
    }


http = app.test_client()
try:
    checkout_response = http.post(
        "/checkout/order_123?debug=true",
        headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
    )
finally:
    database.close()

events = recorded_events(transport)
spans = named_spans(events)
request_span = spans["POST /checkout/<order_id>"]
database_span = spans["sqlite SELECT inventory"]
cache_span = spans["memory-cache GET inventory"]
queue_span = spans["memory-queue PUBLISH checkout.completed"]

write_result(
    client,
    events,
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
)
