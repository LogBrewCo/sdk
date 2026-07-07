# logbrew-fastapi

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

FastAPI integration for capturing LogBrew request spans and exceptions with the public Python SDK.

## Install

```bash
python3 -m pip install logbrew-sdk logbrew-fastapi
```

The package is typed, ships `py.typed`, depends on the core `logbrew-sdk`, and keeps FastAPI as a normal framework dependency instead of bundling or monkeypatching the user's app.

## Example

```python
import logging

from fastapi import FastAPI
from logbrew_fastapi import add_logbrew_middleware, get_active_logbrew_trace
from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-fastapi",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
logger = logging.getLogger("checkout-api")
logger.addHandler(LogBrewLoggingHandler(client, metadata={"service": "checkout-api"}))
app = FastAPI()
add_logbrew_middleware(
    app,
    client=client,
    transport=transport,
    span_id_factory=lambda: "b7ad6b7169203331",
)


@app.get("/health")
def health() -> dict[str, bool]:
    trace = get_active_logbrew_trace()
    logger.info("health request", extra={"traceId": trace.trace_id if trace else None})
    return {"ok": True}
```

`add_logbrew_middleware()` records successful requests as span events, records unhandled handler exceptions as issue plus error-span events, and flushes through the provided transport after each response. If no transport is provided, events stay queued on the core client so the app can flush them itself.

When an incoming request has a valid W3C `traceparent` header, request capture continues that trace by using the incoming `traceId` and parent span id while creating a fresh child span id. The same request-local trace is available from `get_active_logbrew_trace()` while your handler runs, and `LogBrewLoggingHandler` automatically adds `traceId`, `spanId`, `parentSpanId`, and `sampled` metadata to standard-library logs emitted inside that context. Missing or malformed `traceparent` headers start a fresh W3C-shaped local trace so bad client headers do not break the app.

Request spans use the FastAPI route template, such as `GET /orders/{order_id}`, for low-noise grouping. Span metadata includes `routeTemplate`; concrete dynamic paths are not emitted when a route template is available. The trace helper never exposes the raw header, request headers, body, cookies, query strings, or response body.

## Outbound HTTP child spans

Handlers can wrap a caller-owned HTTP request seam with `requests_request_with_logbrew_span(...)` to create an outbound child span under the active FastAPI request trace and inject a normalized W3C `traceparent` header:

```python
from logbrew_sdk import requests_request_with_logbrew_span


@app.post("/checkout/{order_id}")
def checkout(order_id: str) -> dict[str, object]:
    response = requests_request_with_logbrew_span(
        "POST",
        "https://payments.example.com/payments/authorize",
        client=client,
        event_id="evt_fastapi_outbound_payment",
        request=fake_payment_request,
        route_template="/payments/authorize",
        metadata={"dependency": "payments", "operation": "authorize"},
    )
    return {"ok": response.status_code == 202, "orderId": order_id}
```

Run `python -m logbrew_fastapi.examples outbound-http` to see the same local flow from an installed package. The example shows the outgoing `traceparent` span id matching the emitted outbound span id, and the outbound span's parent is the active FastAPI request span. LogBrew does not globally patch `requests`, create sessions, capture request or response bodies, serialize headers, store full URLs, or keep query strings.

## Database, cache, and queue child spans

FastAPI handlers can also wrap app-owned dependency work with the core Python helpers. The active FastAPI request trace becomes the parent for each dependency span:

```python
from logbrew_sdk import (
    cache_operation_with_logbrew_span,
    database_operation_with_logbrew_span,
    queue_operation_with_logbrew_span,
)


@app.post("/checkout/{order_id}")
def checkout(order_id: str) -> dict[str, object]:
    inventory = database_operation_with_logbrew_span(
        "SELECT inventory",
        client=client,
        event_id="evt_fastapi_dependency_database",
        operation=select_inventory,
        system="sqlite",
        db_name="checkout",
        statement_template="SELECT inventory WHERE sku = ?",
        row_count=1,
    )
    cached_count = cache_operation_with_logbrew_span(
        "GET inventory",
        client=client,
        event_id="evt_fastapi_dependency_cache",
        operation=read_inventory_cache,
        system="memory-cache",
        cache_name="inventory-cache",
        cache_hit=True,
    )
    queue_operation_with_logbrew_span(
        "PUBLISH checkout.completed",
        client=client,
        event_id="evt_fastapi_dependency_queue",
        operation=publish_checkout_event,
        system="memory-queue",
        operation_kind="publish",
        queue_name="checkout-events",
        task_name="checkout.completed",
        message_count=1,
    )
    return {"ok": inventory is not None and cached_count >= 0, "orderId": order_id}
```

Run `python -m logbrew_fastapi.examples dependency-spans` to see a local request span parenting SQLite, cache, and queue child spans from an installed package. LogBrew does not patch database drivers, cache clients, queue frameworks, or broker metadata globally, and the helpers avoid SQL values, cache keys/values, queue bodies, headers, baggage, and tracestate.

Request duration metrics are opt-in. Set `capture_request_metrics=True` to emit an explicit `http.server.duration` histogram for completed requests:

```python
add_logbrew_middleware(
    app,
    client=client,
    transport=transport,
    capture_request_metrics=True,
)
```

The metric includes primitive, low-cardinality metadata: `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Query strings and URL hashes are omitted. Set `capture_successful_requests=False` with `capture_request_metrics=True` when you only want duration metrics and not successful request spans. Avoid user IDs, request payloads, headers, or free-form text in custom metric metadata.

By default, transport failures do not break the FastAPI response path. Set `raise_flush_errors=True` only when your app wants delivery failures to surface as request errors.

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples.
