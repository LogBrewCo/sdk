# logbrew-flask

Flask integration for capturing LogBrew request spans and exceptions with the public Python SDK.

This package is source-only until its first PyPI release. The pip command below requires the package to be available on PyPI; use a local checkout or local wheel when evaluating it before release.

```bash
python3 -m pip install logbrew-sdk logbrew-flask
```

The package is typed, ships `py.typed`, depends on the core `logbrew-sdk`, and keeps Flask as a normal framework dependency instead of monkeypatching Flask globally.

Use a project-scoped server ingest key, for example `LOGBREW_SERVER_API_KEY`.

```python
import os

from flask import Flask
from logbrew_flask import add_logbrew_middleware
from logbrew_sdk import LogBrewClient

client = LogBrewClient.create(
    api_key=os.environ["LOGBREW_SERVER_API_KEY"],
    release=os.environ.get("LOGBREW_RELEASE"),
    environment=os.environ.get("LOGBREW_ENVIRONMENT"),
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

app = Flask(__name__)
add_logbrew_middleware(app, client=client)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
```

## What It Captures

The middleware records one request span for each captured response. It can also record request duration metrics and exception issues.

Request spans use the Flask route template, such as `GET /orders/<int:order_id>`, for low-noise grouping. Span metadata includes `routeTemplate`; concrete dynamic paths are not emitted when a route template is available. Valid inbound W3C `traceparent` headers are continued with a fresh child span id.

Handlers can call `get_active_logbrew_trace()` or use `LogBrewLoggingHandler`; logs emitted during the request share the active request trace and span.

```python
from logbrew_flask import get_active_logbrew_trace


@app.get("/orders/<int:order_id>")
def order_detail(order_id: int) -> dict[str, str | None]:
    trace = get_active_logbrew_trace()
    return {"traceId": trace.trace_id if trace else None}
```

Set `capture_request_metrics=True` to emit an explicit `http.server.duration` histogram for each request. Apps can pass `span_id_factory` when deterministic child span ids are useful for controlled diagnostics; production apps usually let LogBrew generate span ids.

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

## Privacy Defaults

LogBrew does not capture request bodies, response bodies, cookies, arbitrary headers, query strings, raw `traceparent` values, baggage, or tracestate. Exception issues include the exception type and message but not stack frames.

## Delivery Failures

By default, transport failures do not break the Flask response path. Set `raise_flush_errors=True` only when your app wants delivery failures to surface as request errors in controlled diagnostics.

## Tradeoff

Sentry, Datadog, and OpenTelemetry provide broader automatic Flask and outbound HTTP instrumentation, including global patching and deeper view/template/client hooks. LogBrew starts with explicit app-owned Flask and outbound HTTP helpers because that keeps setup reversible, simple to reason about, and safer for privacy-sensitive services.
