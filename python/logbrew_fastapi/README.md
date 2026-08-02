# logbrew-fastapi

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

FastAPI integration for capturing LogBrew request spans and exceptions with the public Python SDK.

## Install

```bash
python3 -m pip install logbrew-fastapi
```

`logbrew-fastapi` requires Python 3.10 or newer.

The package is typed, ships `py.typed`, and installs the compatible core `logbrew-sdk`. It supports FastAPI 0.111.1 and later. It does not install or replace application-owned HTTP clients such as `httpx` or `httpx2`. Keep the real project key in application configuration rather than source control.

## Production setup

```python
import logging
import os

from fastapi import FastAPI
from logbrew_fastapi import init_logbrew

app = FastAPI()
logbrew = init_logbrew(
    app,
    api_key=os.environ["LOGBREW_API_KEY"],
    service_name="checkout-api",
)
client = logbrew.client
logger = logging.getLogger("checkout-api")
logger.addHandler(logbrew.logging_handler)


@app.get("/health")
def health() -> dict[str, bool]:
    logger.info("health request")
    return {"ok": True}
```

`init_logbrew()` records successful requests as spans and unhandled handler exceptions as issues plus error spans. Exception issues include first-class exception type, `fastapi.middleware` mechanism, unhandled state, and up to 32 sanitized newest-first traceback frames. The frame projection contains basename and bounded code identity only; it omits raw traceback text, source code, local variables, and absolute paths. Exception messages keep the integration's existing `str(error)` behavior, so applications should avoid sensitive values in exception text. It owns a real `HttpTransport`, uses the core SDK's bounded background delivery, and performs a final exact flush after the app's own default or custom FastAPI lifespan teardown. Network delivery never blocks the request path.

The returned runtime exposes content-free delivery diagnostics:

```python
health = logbrew.delivery_health()
print(
    {
        "state": health.lifecycle,
        "pending": health.pending_events,
        "dropped": health.dropped_events,
        "pauseReason": health.pause_reason,
    }
)
```

Final delivery failures surface during lifespan shutdown by default, after requests have stopped serving. Set `raise_shutdown_errors=False` only when the application must preserve shutdown despite a telemetry failure; `logbrew.shutdown_error_code` and `delivery_health()` remain available without event content, API keys, endpoint configuration, or exception text.

The logging handler is returned but never attached globally. Add it only to the logger whose records you intend to capture. It automatically correlates logs emitted during a request with that request's `traceId`, `spanId`, `parentSpanId`, and sampled state.

When an incoming request has a valid W3C `traceparent` header, request capture continues that trace by using the incoming trace ID and parent span ID while creating a fresh child span ID. The same request-local trace is available from `get_active_logbrew_trace()` while a handler runs. Missing or malformed headers start a fresh W3C-shaped local trace so bad client headers do not break the app.

Request spans use the FastAPI route template, such as `GET /orders/{order_id}`, for low-noise grouping. Span metadata includes `routeTemplate`; concrete dynamic paths are not emitted when a route template is available. The trace helper never exposes the raw header, request headers, body, cookies, query strings, or response body.

## Caller-owned delivery

Use `add_logbrew_middleware()` when the application already owns its `LogBrewClient` and transport lifecycle, or when a deterministic local preview needs `RecordingTransport`. This low-level API accepts any object implementing the public `Transport` protocol:

```python
from logbrew_fastapi import add_logbrew_middleware
from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
transport = RecordingTransport.always_accept()
add_logbrew_middleware(
    app,
    client=client,
    transport=transport,
    span_id_factory=lambda: "b7ad6b7169203331",
)
```

The low-level middleware flushes through the provided transport after each response by default. If no transport is provided, events remain queued for the application to flush. Transport failures do not break the request path unless `raise_flush_errors=True`.

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

## Celery background jobs

Install the optional Celery path when a FastAPI service publishes or processes Celery jobs:

```bash
python3 -m pip install "logbrew-fastapi[celery]"
```

The base FastAPI install stays Celery-free. The extra installs the compatible core Celery integration, which you attach only to the Celery app your service owns:

```python
from celery import Celery
from logbrew_sdk import instrument_celery_app_with_logbrew_spans

celery_app = Celery("checkout")
celery_telemetry = instrument_celery_app_with_logbrew_spans(
    celery_app,
    client=client,
    metadata={"service": "checkout-worker"},
)
```

Producer and worker spans share W3C trace context. An unexpected final task failure emits one trace-correlated issue with task name and exception type only; retries and exception types declared through `task.throws` stay span-only. Task IDs, arguments, results, headers, exception messages, and stack traces are excluded. Uninstall direct instrumentation after tasks drain and before shutting down its client. Separate prefork workers need child-owned clients; follow the [core Celery lifecycle and encrypted persistence setup](https://github.com/LogBrewCo/sdk/tree/main/python/logbrew_py#automatic-celery-spans) instead of sharing the FastAPI process client across forks.

Request duration metrics are opt-in. Set `capture_request_metrics=True` to emit an explicit `http.server.duration` histogram for completed requests:

```python
logbrew = init_logbrew(
    app,
    api_key=os.environ["LOGBREW_API_KEY"],
    service_name="checkout-api",
    capture_request_metrics=True,
)
```

The metric includes primitive, low-cardinality metadata: `service`, `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Query strings and URL hashes are omitted. Set `capture_successful_requests=False` with `capture_request_metrics=True` when you only want duration metrics and not successful request spans. Avoid user IDs, request payloads, headers, or free-form text in custom metric metadata.

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples.
