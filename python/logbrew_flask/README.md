# logbrew-flask

Flask integration for capturing LogBrew request spans and exceptions with the public Python SDK.

```bash
python3 -m pip install logbrew-sdk logbrew-flask
```

`logbrew-flask` requires Python 3.10 or newer.

The package is typed, ships `py.typed`, depends on the core `logbrew-sdk`, and keeps Flask as a normal framework dependency instead of monkeypatching Flask globally.

Use a project-scoped server ingest key in `LOGBREW_SERVER_API_KEY`. The
framework initializer also reads `LOGBREW_SERVICE_NAME`,
`LOGBREW_ENVIRONMENT`, and `LOGBREW_RELEASE` when they are present.

```python
from flask import Flask
from logbrew_flask import init_logbrew

app = Flask(__name__)
logbrew = init_logbrew(app)
client = logbrew.client


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
```

The initializer owns an HTTP transport and sends on a background worker, so a
telemetry request does not block the Flask response. The first accepted event
wakes delivery immediately. Call `logbrew.client.shutdown()` from the normal
graceful worker-shutdown hook to flush any retained tail. Repeated
`init_logbrew(app)` calls return the same app extension and do not install
duplicate hooks.

Use `add_logbrew_middleware()` when the application already owns a
`LogBrewClient`. Pass a transport for response-path flushing, or give the
client an owned transport and set `flush_on_response=False` for automatic
background delivery.

## What It Captures

The middleware records one request span for each captured response. It can also record request duration metrics and exception issues.

Request spans use the Flask route template, such as `GET /orders/<int:order_id>`, for low-noise grouping. Span metadata includes `routeTemplate`. Concrete request paths are not emitted, and unmatched routes use the fixed `<unmatched>` label. Valid inbound W3C `traceparent` headers are continued with a fresh child span id.

Handlers can call `get_active_logbrew_trace()` or use `LogBrewLoggingHandler`; logs emitted during the request share the active request trace and span.

```python
from logbrew_flask import get_active_logbrew_trace


@app.get("/orders/<int:order_id>")
def order_detail(order_id: int) -> dict[str, str | None]:
    trace = get_active_logbrew_trace()
    return {"traceId": trace.trace_id if trace else None}
```

Set `capture_request_metrics=True` to emit an explicit `http.server.duration` histogram for each request. Each generated metric carries the stable description `Duration of one completed server request.` so its purpose remains clear in investigations. Apps can pass `span_id_factory` when deterministic child span ids are useful for controlled diagnostics; production apps usually let LogBrew generate span ids.

## Outbound HTTP Child Spans

When a handler calls another service, use the core Python HTTP helpers inside the Flask request. They automatically reuse the active Flask request trace, create a child span, and inject one W3C `traceparent` header whose span id matches the emitted outbound span.

```python
from logbrew_sdk import requests_request_with_logbrew_span


@app.post("/checkout/<order_id>")
def checkout(order_id: str) -> dict[str, bool]:
    response = requests_request_with_logbrew_span(
        "POST",
        "https://payments.example.com/payments/authorize",
        client=client,
        event_id="evt_checkout_payment",
        route_template="/payments/authorize",
    )
    return {"accepted": response.status_code == 202}
```

The helper does not patch `requests` globally. It records method, low-cardinality route template, status code, trace id, span id, and parent span id. It does not capture full URLs, query strings, request bodies, response bodies, arbitrary headers, cookies, baggage, or tracestate.

## Database, Cache, And Queue Child Spans

Use the core dependency helpers inside a Flask handler to connect database, cache, and queue work to the active request trace.

```python
from logbrew_sdk import (
    cache_operation_with_logbrew_span,
    database_operation_with_logbrew_span,
    queue_operation_with_logbrew_span,
)


@app.post("/checkout/<order_id>")
def checkout(order_id: str) -> dict[str, bool]:
    inventory = database_operation_with_logbrew_span(
        "SELECT inventory",
        client=client,
        operation=lambda: database.execute("SELECT quantity FROM inventory WHERE sku = ?", ("sku_123",)).fetchone(),
        system="sqlite",
        statement_template="SELECT inventory WHERE sku = ?",
    )
    cached_inventory = cache_operation_with_logbrew_span(
        "GET inventory",
        client=client,
        operation=lambda: cache["sku_123"],
        system="memory-cache",
        cache_name="inventory-cache",
        cache_hit=True,
    )
    published = queue_operation_with_logbrew_span(
        "PUBLISH checkout.completed",
        client=client,
        operation=lambda: queue.append("checkout.completed") or len(queue),
        system="memory-queue",
        operation_kind="publish",
        queue_name="checkout-events",
        task_name="checkout.completed",
    )
    return {"ok": inventory is not None and cached_inventory > 0 and published == 1}
```

Run `python -m logbrew_flask.examples dependency-spans` to see a request span with database, cache, and queue child spans under the same trace. These helpers record operation names, systems, status, trace ids, span ids, parent span ids, and primitive metadata. They do not capture SQL bind values, result payloads, queue message payloads, cache values, arbitrary headers, baggage, or tracestate.

## Privacy Defaults

LogBrew does not capture concrete request paths, request bodies, response bodies, cookies, arbitrary headers, query strings, raw `traceparent` values, baggage, or tracestate. Exception issues include first-class exception type, `flask.middleware` mechanism, unhandled state, and up to 32 sanitized newest-first traceback frames. The frame projection contains basename and bounded code identity only; it omits raw traceback text, source code, local variables, and absolute paths. Exception messages keep the integration's existing `str(error)` behavior, so applications should avoid sensitive values in exception text.

## Delivery Failures

By default, transport failures do not break the Flask response path. Set `raise_flush_errors=True` only when your app wants delivery failures to surface as request errors in controlled diagnostics.

## Tradeoff

Sentry, Datadog, and OpenTelemetry provide broader automatic Flask, outbound HTTP, and dependency instrumentation, including global patching and deeper view/template/client hooks. LogBrew starts with explicit app-owned Flask and dependency helpers because that keeps setup reversible, simple to reason about, and safer for privacy-sensitive services.
