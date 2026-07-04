# logbrew-sdk

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Python SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
python3 -m pip install logbrew-sdk
```

The package includes `py.typed`, public type aliases such as `ReleaseAttributes`, `SpanAttributes`, `MetricAttributes`, and `TraceparentContext`, and copyable examples for wiring LogBrew into your Python service. Keep the real key in your app configuration and use `preview_json()` when you want to inspect queued JSON before sending.

## Example

```python
import json
import sys

from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-python",
    sdk_version="0.1.0",
)

client.release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    {
        "version": "1.2.3",
        "commit": "abc123def456",
        "notes": "Public release marker",
    },
)
client.environment(
    "evt_environment_001",
    "2026-06-02T10:00:01Z",
    {"name": "production", "region": "global"},
)
client.issue(
    "evt_issue_001",
    "2026-06-02T10:00:02Z",
    {
        "title": "Checkout timeout",
        "level": "error",
        "message": "Request timed out after retry budget",
    },
)
client.log(
    "evt_log_001",
    "2026-06-02T10:00:03Z",
    {"message": "worker started", "level": "info", "logger": "job-runner"},
)
client.span(
    "evt_span_001",
    "2026-06-02T10:00:04Z",
    {
        "name": "GET /health",
        "traceId": "trace_001",
        "spanId": "span_001",
        "status": "ok",
        "durationMs": 12.5,
    },
)
client.action(
    "evt_action_001",
    "2026-06-02T10:00:05Z",
    {"name": "deploy", "status": "success"},
)

print(client.preview_json())

transport = RecordingTransport.always_accept()
response = client.shutdown(transport)
print(
    json.dumps(
        {"ok": True, "status": response.status_code, "attempts": response.attempts, "events": 6}
    ),
    file=sys.stderr,
)
```

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush()` or `shutdown()` to send queued events through a transport, and use `preview_json()` when you want a stable local JSON preview before sending anything.

## Queue Pressure

`LogBrewClient` keeps a bounded in-memory queue so a transport outage or burst of logs cannot grow without limit. The default capacity is `10_000` events. Pass `max_queue_size` when a service needs a smaller or larger cap:

```python
client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.4.0",
    max_queue_size=1000,
)
```

When the queue is full, new events are dropped and existing queued context is preserved. Use `pending_events()` and `dropped_events()` for local diagnostics, then call `flush()` or `shutdown()` with your transport:

```python
if client.dropped_events() > 0:
    print({"pending": client.pending_events(), "dropped": client.dropped_events()})
```

This counter is local process state only. Usage, quota, and billing remain backend-owned and must not be inferred from queue size or drop counts.

## First Useful Telemetry

For a new Python service, capture a small set of signals that explain what changed, where the service ran, what the user or job attempted, which outbound dependency mattered, how long it took, and how the request links to a distributed trace:

```python
import logging

from logbrew_sdk import (
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    create_network_milestone_attributes,
    create_product_action_attributes,
    span_attributes_from_traceparent,
)

traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
route_template = "/checkout/:cart_id"

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.4.0",
)
client.release(
    "evt_release_checkout_api",
    "2026-06-15T08:00:00Z",
    {"version": "1.4.0", "commit": "abc123def456"},
)
client.environment(
    "evt_environment_checkout_api",
    "2026-06-15T08:00:01Z",
    {"name": "production", "region": "us-east-1"},
)

logger = logging.getLogger("checkout-api")
logger.addHandler(LogBrewLoggingHandler(client, metadata={"service": "checkout-api"}))
logger.setLevel(logging.INFO)
logger.info("checkout request accepted", extra={"routeTemplate": route_template, "traceId": trace_id})

client.action(
    "evt_action_checkout_started",
    "2026-06-15T08:00:03Z",
    create_product_action_attributes(
        {
            "name": "checkout started",
            "status": "running",
            "sessionId": "sess_checkout_123",
            "traceId": trace_id,
            "routeTemplate": route_template,
            "funnel": "checkout",
            "step": "payment",
        }
    ),
)
client.action(
    "evt_network_payment_authorized",
    "2026-06-15T08:00:04Z",
    create_network_milestone_attributes(
        {
            "routeTemplate": "/payments/:payment_id",
            "method": "POST",
            "statusCode": 202,
            "durationMs": 43,
            "sessionId": "sess_checkout_123",
            "traceId": trace_id,
        }
    ),
)
client.metric(
    "evt_metric_checkout_duration",
    "2026-06-15T08:00:05Z",
    {
        "name": "checkout.duration",
        "kind": "histogram",
        "value": 128,
        "unit": "ms",
        "temporality": "delta",
        "metadata": {"routeTemplate": route_template, "traceId": trace_id},
    },
)
client.span(
    "evt_span_checkout_request",
    "2026-06-15T08:00:06Z",
    span_attributes_from_traceparent(
        traceparent,
        name="POST /checkout/:cart_id",
        span_id="b7ad6b7169203331",
        status="ok",
        duration_ms=17,
        metadata={"routeTemplate": route_template, "service": "checkout-api"},
    ),
)
client.shutdown(RecordingTransport.always_accept())
```

The packaged example prints a local JSON preview of this flow:

```bash
python -m logbrew_sdk.examples first-useful-telemetry
```

This path is intentionally app-owned. It uses Python's standard logging module, explicit W3C `traceparent` continuation, and explicit product, network, and metric helpers. It does not patch global HTTP clients, does not collect request or response bodies, does not capture arbitrary headers, and timeline helpers strip query strings and hashes from route templates.

## Support Ticket Drafts

Use `create_support_ticket_draft()` when a user or agent explicitly asks to prepare a support ticket payload. The helper is local-only: it validates the planned public support-ticket fields, redacts diagnostics, and returns a dictionary. It does not send data, open a ticket, use account/session API credentials, or call backend support routes.

```python
from logbrew_sdk import create_support_ticket_draft

draft = create_support_ticket_draft(
    source="sdk",
    category="sdk_install_failure",
    title="Python import fails after install",
    description="Wheel installs, but the app cannot import logbrew_sdk.",
    environment="production",
    runtime="python 3.13",
    framework="fastapi",
    sdk_package="logbrew-sdk",
    sdk_version="0.1.2",
    release="checkout-api@1.4.0",
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    diagnostics={
        "install_command": "python3 -m pip install logbrew-sdk",
        "endpoint": "https://api.example.com/v1/events?debug=true",
        "authorization": "Bearer hidden",
        "local_path": "/Users/example/service/app.py",
        "error": RuntimeError("private failure message"),
    },
)
```

The returned draft keeps only structured JSON-like diagnostics. Auth-like keys, cookies, tokens, URL origins, local paths, unsupported objects, and exception messages/stacks are redacted or omitted before the dictionary is returned.

## Metrics

Use `metric()` for explicit, application-owned measurements. LogBrew validates the metric name, kind, value, unit, temporality, and optional metadata before queueing the event:

```python
from logbrew_sdk import LogBrewClient

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-python",
    sdk_version="0.1.0",
)

client.metric(
    "evt_metric_queue_depth",
    "2026-06-02T10:00:06Z",
    {
        "name": "queue.depth",
        "kind": "gauge",
        "value": 42,
        "unit": "{items}",
        "temporality": "instant",
        "metadata": {"service": "worker"},
    },
)
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms require `delta` or `cumulative` temporality and non-negative values; gauges require `instant` temporality and may be negative. Keep metadata low-cardinality and primitive. This SDK does not automatically collect runtime or framework metrics yet.

## Trace Context

Use the W3C helpers when a Python service needs to interoperate with distributed tracing headers:

```python
from logbrew_sdk import (
    create_logbrew_trace_context,
    create_traceparent_headers,
    parse_traceparent,
    span_attributes_from_trace_context,
    trace_metadata,
    use_logbrew_trace,
)

traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
context = parse_traceparent(traceparent)
trace = create_logbrew_trace_context(traceparent, span_id="b7ad6b7169203331")
attributes = span_attributes_from_trace_context(
    trace,
    name="GET /health",
    status="ok",
    duration_ms=12.5,
    metadata={"service": "checkout"},
)
headers = create_traceparent_headers(
    trace_id=attributes["traceId"],
    span_id=attributes["spanId"],
    trace_flags="01",
)
with use_logbrew_trace(trace):
    metadata = trace_metadata()
```

`parse_traceparent()` validates W3C shape, rejects all-zero trace/span IDs, normalizes IDs to lowercase, and exposes the sampled flag. `create_logbrew_trace_context()` creates the request-local `LogBrewTraceContext` used to correlate request spans, app-owned logs, issues, actions, metrics, and outgoing milestones with one safe set of IDs. `use_logbrew_trace()` makes that context available through `trace_metadata()` and `get_active_logbrew_trace()` during framework handler work, including async work that keeps Python `contextvars`. `create_traceparent_headers()` returns an explicit outbound carrier with only `traceparent` for app-owned HTTP clients. FastAPI and Django integrations use these helpers automatically for valid inbound `traceparent` headers and start a fresh W3C-shaped local trace when the header is missing or malformed. The helpers do not patch HTTP clients or capture request payloads, headers, cookies, query strings, or the raw `traceparent` value.

If your app already installs OpenTelemetry, copy the active OTel parent into a LogBrew child context without adding an SDK dependency on OTel:

```python
from logbrew_sdk import (
    logbrew_trace_context_from_current_open_telemetry_span,
    span_attributes_from_trace_context,
    use_logbrew_trace,
)

trace = logbrew_trace_context_from_current_open_telemetry_span()
if trace is not None:
    with use_logbrew_trace(trace):
        attributes = span_attributes_from_trace_context(
            trace,
            name="checkout.otel_child",
            status="ok",
            metadata={"service": "checkout"},
        )
```

`logbrew_trace_context_from_current_open_telemetry_span()` returns `None` when OpenTelemetry is not installed or no valid current OTel span exists. It copies only the validated trace ID, parent span ID, and sampled flag into a fresh LogBrew child context. It does not install OTel, own exporters or processors, read attributes/events/links, ingest baggage or tracestate, serialize raw propagation metadata, patch clients, or capture payloads, headers, cookies, full URLs, query strings, or fragments.

If your app already owns an OpenTelemetry `TracerProvider`, register a LogBrew processor to convert ended `ReadableSpan` objects into queued LogBrew spans:

```python
from logbrew_sdk import LogBrewClient, create_logbrew_open_telemetry_span_processor
from opentelemetry.sdk.trace import TracerProvider

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
provider = TracerProvider()
provider.add_span_processor(
    create_logbrew_open_telemetry_span_processor(
        client=client,
        include_trace_summary=True,
        link_attribute_keys=["messaging.operation.name"],
        metadata={"service": "checkout"},
    )
)
```

If a framework accepts only an OpenTelemetry `SpanExporter`, use the exporter-compatible helper with your app-owned OTel processor:

```python
from logbrew_sdk import LogBrewClient, create_logbrew_open_telemetry_span_exporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
exporter = create_logbrew_open_telemetry_span_exporter(
    client=client,
    include_trace_summary=True,
    link_attribute_keys=["messaging.operation.name"],
    metadata={"service": "checkout"},
)
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(exporter))
```

The processor and exporter follow normal sampled-span behavior by default and can emit one synthetic `opentelemetry.trace:<root-name>` summary span on `force_flush()` or `shutdown()`. Detail spans copy a small safe allowlist such as service, environment, route, method, status code, span kind, instrumentation scope, dropped-count metadata, type-only exception events, and up to eight span links. Trace summaries include bounded exception event counts and type names so failed OTel traces stay searchable without sending exception messages or stacks. Link summaries retain only normalized trace ID, span ID, sampled state, and explicitly allowlisted primitive link metadata such as `messaging.operation.name`; sensitive keys such as message IDs, full URLs, headers, query strings, payloads, cookies, private auth values, DB statements, exception messages, and stacks stay blocked. Additional OTel attributes require explicit allowlists. These helpers do not add an OTel dependency to default LogBrew installs, own your provider/exporter pipeline, serialize baggage or tracestate, patch clients, or capture request/response bodies.

Span payloads may include up to eight privacy-bounded event summaries through `events` or helper-level `span_events`, and up to eight privacy-bounded `links` for batch, fan-in, retry, or queue relationships. Each event summary has a required `name`, optional timezone-aware `timestamp`, and primitive-only `metadata`; each link summary has W3C-shaped `traceId` and `spanId`, optional `sampled`, and primitive-only `metadata`. LogBrew drops nested objects and helper deny-listed key names so milestones and related-span links can improve trace timelines without sending payloads, headers, query parameters, cache keys, queue messages, exception messages, stack traces, or raw propagation data. Dependency helpers add one automatic type-only `exception` event when the wrapped operation fails.

## Outbound HTTP Client Spans

Use `urlopen_with_logbrew_span()` when you want one dependency-free outbound HTTP client span around an app-owned `urllib.request` call:

```python
from urllib.request import Request

from logbrew_sdk import LogBrewClient, urlopen_with_logbrew_span

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

response = urlopen_with_logbrew_span(
    Request("https://api.example.com/payments/123?coupon=summer", method="GET"),
    client=client,
    event_id="evt_payment_lookup",
    timestamp="2026-06-19T08:00:00Z",
    route_template="/payments/:payment_id",
    metadata={"service": "checkout-api"},
)
```

The helper clones the caller request, writes exactly one normalized W3C `traceparent`, runs the opener under a child `LogBrewTraceContext`, queues one span with method, query-free route, status, duration, primitive metadata, and type-only failure metadata, then returns the original response or re-raises the original HTTP/network error. Telemetry capture failures are reportable through `on_capture_error` and do not replace the app-owned HTTP result. It does not patch `urllib`, does not capture request or response payloads, and does not store headers, cookies, query strings, fragments, exception messages, baggage, tracestate, or raw propagation values.

For apps that use `requests`, use `requests_request_with_logbrew_span()` with your own `requests.Session` or request callable. LogBrew does not add `requests` as a dependency and does not monkeypatch the library:

```python
import requests

from logbrew_sdk import LogBrewClient, requests_request_with_logbrew_span

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
session = requests.Session()

response = requests_request_with_logbrew_span(
    "POST",
    "https://api.example.com/payments/123?coupon=summer",
    client=client,
    event_id="evt_payment_submit",
    timestamp="2026-06-19T08:00:03Z",
    session=session,
    timeout=3.5,
    headers={"x-caller": "checkout-api"},
    json={"amount": 42},
    route_template="/payments/:payment_id",
    metadata={"service": "checkout-api"},
)
```

The `requests` helper clones caller headers, replaces any caller-supplied `traceparent` with one normalized child header, runs the request under that child trace context, queues one sanitized dependency span, and returns the original `requests.Response` or re-raises the original exception. It records method, route template, status code, duration, sampled flag, primitive metadata, and type-only failure metadata. It does not capture payloads, response bodies, headers, cookies, full URLs, query strings, fragments, exception messages, baggage, tracestate, or raw propagation values.

If most calls go through one app-owned `requests.Session`, install reversible per-session instrumentation once instead of wrapping every call:

```python
import requests

from logbrew_sdk import LogBrewClient, instrument_requests_session_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
session = requests.Session()
instrumentation = instrument_requests_session_with_logbrew_spans(
    session,
    client=client,
    route_template_resolver=lambda method, url: "/payments/:payment_id",
    metadata={"service": "checkout-api"},
)

response = session.post(
    "https://api.example.com/payments/123?coupon=summer",
    timeout=3.5,
    json={"amount": 42},
)
instrumentation.uninstall()
```

The session helper returns a `LogBrewRequestsSessionInstrumentation` handle. It wraps only the session instance you pass, returns the existing handle on duplicate install, restores the original `request` method with `uninstall()`, generates safe event IDs by default, and preserves the same traceparent injection, failure, and privacy behavior as `requests_request_with_logbrew_span()`. It does not patch the global `requests` module, create sessions, install dependencies, capture payloads, capture headers, capture full URLs or queries, or open support tickets.

For apps that use `httpx`, use `httpx_request_with_logbrew_span()` for sync calls or `async_httpx_request_with_logbrew_span()` for async calls. LogBrew does not add `httpx` as a dependency and does not patch `httpx.Client`, `httpx.AsyncClient`, or transports:

```python
import httpx

from logbrew_sdk import (
    LogBrewClient,
    async_httpx_request_with_logbrew_span,
    httpx_request_with_logbrew_span,
)

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

with httpx.Client() as session:
    response = httpx_request_with_logbrew_span(
        "POST",
        "https://api.example.com/payments/123?coupon=summer",
        client=client,
        event_id="evt_payment_submit",
        timestamp="2026-06-19T09:00:00Z",
        session=session,
        timeout=3.5,
        headers={"x-caller": "checkout-api"},
        json={"amount": 42},
        route_template="/payments/:payment_id",
        metadata={"service": "checkout-api"},
    )

async def submit_payment(async_session: httpx.AsyncClient) -> httpx.Response:
    return await async_httpx_request_with_logbrew_span(
        "POST",
        "https://api.example.com/payments/123?coupon=summer",
        client=client,
        event_id="evt_payment_submit_async",
        timestamp="2026-06-19T09:00:01Z",
        session=async_session,
        timeout=3.5,
        route_template="/payments/:payment_id",
        metadata={"service": "checkout-api"},
    )
```

The `httpx` helpers follow the same privacy and failure behavior as the `requests` helper: cloned caller headers, exactly one normalized child `traceparent`, active child trace context during the call or awaited call, sanitized dependency span capture, original response/error preservation, type-only failure metadata, and optional `on_capture_error` reporting for telemetry failures. They do not capture payloads, response bodies, headers, cookies, full URLs, query strings, fragments, exception messages, baggage, tracestate, or raw propagation values.

For shared app-owned `httpx.Client` or `httpx.AsyncClient` instances, use the reversible client instrumentation:

```python
import httpx

from logbrew_sdk import LogBrewClient, instrument_httpx_client_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

with httpx.Client() as session:
    instrumentation = instrument_httpx_client_with_logbrew_spans(
        session,
        client=client,
        route_template_resolver=lambda method, url: "/payments/:payment_id",
        metadata={"service": "checkout-api"},
    )
    response = session.post(
        "https://api.example.com/payments/123?coupon=summer",
        timeout=3.5,
        json={"amount": 42},
    )
    instrumentation.uninstall()
```

The `httpx` helper returns a `LogBrewHttpxClientInstrumentation` handle. It wraps only the provided sync or async client instance, puts the original `request` method back with `uninstall()`, and keeps the same type-only failure metadata and sanitized route/status/duration span behavior as the explicit helpers. It does not patch `httpx.Client`, `httpx.AsyncClient`, transports, request hooks, response hooks, payloads, headers, full URLs, query strings, baggage, tracestate, or raw propagation metadata.

## Database Operation Spans

Use `database_operation_with_logbrew_span()` for sync database calls and `async_database_operation_with_logbrew_span()` for async calls when you want one app-owned DB span without installing or patching a database driver:

```python
from logbrew_sdk import LogBrewClient, database_operation_with_logbrew_span

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

result = database_operation_with_logbrew_span(
    "SELECT checkout_order",
    client=client,
    event_id="evt_checkout_db_query",
    timestamp="2026-06-19T10:30:00Z",
    operation=lambda: session.execute("SELECT * FROM checkout_order WHERE id = ?", [cart_id]),
    system="postgresql",
    db_name="checkout",
    statement_template="SELECT * FROM checkout_order WHERE id = ?",
    row_count_from_result=lambda rows: rows.rowcount,
    metadata={"service": "checkout-api"},
    span_events=[
        {"name": "db.cursor.ready", "metadata": {"poolSlot": 2}},
    ],
)
```

The helper activates a child `LogBrewTraceContext` while your callable runs, queues one span named from the DB system and operation, preserves the original result or exception, and reports telemetry capture failures through `on_capture_error` without replacing the database result. Metadata is intentionally bounded to primitive caller metadata, `dbSystem`, `dbOperation`, optional `dbName`, optional `statementTemplate`, optional non-negative `rowCount`, sampled state, optional bounded span events, and exception type. It does not monkeypatch SQLAlchemy or DB-API drivers, does not open support tickets, and does not capture SQL parameters, result rows, connection strings, network addresses, sensitive configuration values, payloads, baggage, tracestate, stack traces, or exception messages.

### DB-API Connection Spans

Use `connect_dbapi_connection_with_logbrew_spans()` when your app controls a Python DB-API connect callable and you want one sanitized connect span plus cursor execution spans. If your app already has an open connection, use `instrument_dbapi_connection_with_logbrew_spans()` to wrap only that connection:

```python
import sqlite3

from logbrew_sdk import LogBrewClient, connect_dbapi_connection_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

db = connect_dbapi_connection_with_logbrew_spans(
    sqlite3.connect,
    connect_args=(":memory:",),
    client=client,
    system="sqlite",
    db_name="checkout",
    trace_fetch_methods=True,
    metadata={"service": "checkout-api"},
)

cursor = db.cursor()
cursor.execute("SELECT id FROM checkout_order WHERE id = ?", (order_id,))
rows = cursor.fetchall()

raw_connection = db.uninstall()
```

The helper traces the caller-supplied connect callable, then keeps connection ownership with your app, wraps cursors returned by `cursor()`, and supports `execute(...)`, `executemany(...)`, `callproc(...)`, transaction `commit()` and `rollback()`, plus common connection shortcut `execute(...)` and `executemany(...)` calls. Fetch spans for `fetchone()`, `fetchmany(...)`, and `fetchall()` are opt-in through `trace_fetch_methods=True` because high-volume row-reading loops can be noisy. The wrapper derives only the connect, SQL verb, fetch, transaction, or procedure label, records `framework=dbapi`, `dbMethod`, optional caller `dbName`, optional non-negative row count, active child trace IDs, sampled state, and type-only errors. It does not patch DB-API modules, driver classes, or connect functions, and does not capture connect arguments, SQL text, bind values, result rows, connection URLs, network addresses, user names, baggage, tracestate, stack traces, or exception messages. Call `uninstall()` to stop future spans and get the original connection back.

### SQLAlchemy Engine Spans

Use `instrument_sqlalchemy_engine_with_logbrew_spans()` when your app already uses SQLAlchemy and you want one safe span per cursor execution from a caller-owned engine:

```python
from sqlalchemy import create_engine, text

from logbrew_sdk import LogBrewClient, instrument_sqlalchemy_engine_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
engine = create_engine("sqlite:///:memory:")

instrumentation = instrument_sqlalchemy_engine_with_logbrew_spans(
    engine,
    client=client,
    db_name="checkout",
    metadata={"service": "checkout-api"},
)

with engine.begin() as connection:
    connection.execute(text("SELECT 1"))

instrumentation.uninstall()
```

The helper imports SQLAlchemy only when you opt in, attaches listeners only to the engine you pass, returns the existing instrumentation on duplicate calls, activates a child trace while SQLAlchemy executes the statement, and removes listeners with `uninstall()`. For async SQLAlchemy engines, pass the owned `async_engine.sync_engine`. Captured metadata is bounded to primitive caller metadata, `framework=sqlalchemy`, `dbSystem`, `dbOperation`, optional `dbName`, optional non-negative `rowCount`, sampled state, and exception type. It does not patch global SQLAlchemy factories, wrap sessions, capture raw SQL, SQL parameters, connection URLs, hosts, usernames, result rows, baggage, tracestate, stack traces, or exception messages.

## Cache Operation Spans

Use `cache_operation_with_logbrew_span()` for sync cache calls and `async_cache_operation_with_logbrew_span()` for async calls when you want one app-owned cache span without installing or patching Redis, memcached, Django cache, or Flask cache clients:

```python
from logbrew_sdk import LogBrewClient, cache_operation_with_logbrew_span

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

profile = cache_operation_with_logbrew_span(
    "GET profile",
    client=client,
    event_id="evt_checkout_profile_cache_get",
    timestamp="2026-06-19T11:15:00Z",
    operation=lambda: redis_client.get(profile_cache_key),
    system="redis",
    cache_name="profiles",
    cache_hit=True,
    item_count=1,
    metadata={"service": "checkout-api"},
    span_events=[
        {"name": "cache.lookup", "metadata": {"cacheTier": "primary"}},
    ],
)
```

The helper activates a child `LogBrewTraceContext` while your callable runs, queues one span named from the cache system and operation, preserves the original result or exception, and reports telemetry capture failures through `on_capture_error` without replacing the cache result. Metadata is intentionally bounded to primitive caller metadata, `cacheSystem`, `cacheOperation`, optional `cacheName`, optional hit state, optional non-negative item size/count, sampled state, optional bounded span events, and exception type. It drops key-like metadata fields and does not monkeypatch cache clients, open support tickets, capture cache keys, values, commands, payloads, headers, cookies, network addresses, baggage, tracestate, stack traces, or exception messages.

### Django Cache Spans

Use `instrument_django_cache_with_logbrew_spans()` when your app already owns a Django cache object and you want one span per supported cache method on that object:

```python
from django.core.cache import cache

from logbrew_sdk import LogBrewClient, instrument_django_cache_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

instrumentation = instrument_django_cache_with_logbrew_spans(
    cache,
    client=client,
    cache_name="profiles",
    metadata={"service": "checkout-api"},
)

cache.set(profile_cache_key, profile, timeout=60)
profile = cache.get(profile_cache_key)
instrumentation.uninstall()
```

The helper returns a `LogBrewDjangoCacheInstrumentation` handle, does not add Django as a LogBrew dependency, and does not patch Django globally. It wraps only the cache object you pass, returns the existing instrumentation on duplicate calls, activates a child trace around supported `get`, `get_many`, `set`, `set_many`, `add`, `delete`, `delete_many`, and `clear` calls, derives hit state and item count/size when safely knowable, and puts the original methods back with `uninstall()`. It does not read Django settings, capture cache keys, values, timeout/version arguments, backend locations, hosts, ports, arbitrary command text, response payloads, baggage, tracestate, stack traces, or exception messages.

### Flask-Caching Spans

Use `instrument_flask_cache_with_logbrew_spans()` when your app already owns a Flask-Caching `Cache` object and you want one span per supported cache method on that object:

```python
from flask import Flask
from flask_caching import Cache

from logbrew_sdk import LogBrewClient, instrument_flask_cache_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

app = Flask(__name__)
app.config["CACHE_TYPE"] = "SimpleCache"
cache = Cache(app)
instrumentation = instrument_flask_cache_with_logbrew_spans(
    cache,
    client=client,
    cache_name="profiles",
    metadata={"service": "checkout-api"},
)

cache.set(profile_cache_key, profile, timeout=60)
profile = cache.get(profile_cache_key)
instrumentation.uninstall()
```

The helper returns a `LogBrewFlaskCacheInstrumentation` handle, does not add Flask or Flask-Caching as LogBrew dependencies, and does not patch Flask-Caching globally. It wraps only the cache object you pass, returns the existing instrumentation on duplicate calls, activates a child trace around supported `get`, `get_many`, `set`, `set_many`, `add`, `delete`, `delete_many`, and `clear` calls, derives hit state and item count/size when safely knowable, and puts the original methods back with `uninstall()`. It does not capture cache keys, values, timeout arguments, key prefixes, backend locations, hosts, ports, arbitrary command text, response payloads, baggage, tracestate, stack traces, or exception messages.

### Pymemcache Client Spans

Use `instrument_pymemcache_client_with_logbrew_spans()` when your app already owns a `pymemcache` style client and you want safe spans for calls made through that one object:

```python
from pymemcache.client.base import Client

from logbrew_sdk import LogBrewClient, instrument_pymemcache_client_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
cache_client = Client(("localhost", 11211))

instrumentation = instrument_pymemcache_client_with_logbrew_spans(
    cache_client,
    client=client,
    cache_name="profiles",
    metadata={"service": "checkout-api"},
)

profile = cache_client.get(profile_cache_key, default=None)
cache_client.set(profile_cache_key, profile, expire=60)
instrumentation.uninstall()
```

The helper returns a `LogBrewPymemcacheInstrumentation` handle, does not add `pymemcache` as a LogBrew dependency, and does not patch pymemcache classes globally. It wraps only the client object you pass, returns the existing instrumentation on duplicate calls, activates a child trace around supported `get`, `get_many`, `get_multi`, `gets`, `gets_many`, `set`, `set_many`, `set_multi`, `add`, `replace`, `append`, `prepend`, `cas`, `delete`, `delete_many`, `incr`, `decr`, `touch`, `stats`, `version`, `flush_all`, and `quit` calls, derives hit state and item count/size when safely knowable, and puts the original methods back with `uninstall()`. It does not capture cache keys, values, expiration or noreply arguments, backend locations, hosts, ports, arbitrary command text, response payloads, baggage, tracestate, stack traces, or exception messages.

### Redis Client Spans

Use `instrument_redis_client_with_logbrew_spans()` when your app already owns a `redis-py` style client and you want safe spans for calls that go through that one client's `execute_command` method:

```python
import redis

from logbrew_sdk import LogBrewClient, instrument_redis_client_with_logbrew_spans

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)
redis_client = redis.Redis.from_url("redis://localhost:6379/0")

instrumentation = instrument_redis_client_with_logbrew_spans(
    redis_client,
    client=client,
    cache_name="profiles",
    trace_pipelines=True,  # opt in when Redis pipeline execute timing matters
    metadata={"service": "checkout-api"},
)

profile = redis_client.get(profile_cache_key)
pipeline_results = redis_client.pipeline().get(profile_cache_key).set(profile_cache_key, "fresh").execute()
instrumentation.uninstall()
```

The helper does not add `redis` as a LogBrew dependency and does not patch Redis classes globally. It wraps only the client instance you pass, returns the existing instrumentation on duplicate calls, activates a child trace during sync or async `execute_command` work, derives command name, read/write/delete kind, cache hit, result count, and byte size when safely knowable from the result, and reinstates the original method with `uninstall()`. With `trace_pipelines=True`, it also wraps pipelines returned by that client instance and records one sanitized `redis PIPELINE` span around `execute()`, including only pipeline length and capped operation names such as `GET,SET`. It does not capture Redis keys, values, command arguments, pipeline arguments, connection URLs, network endpoints, ports, usernames, arbitrary command text, response payloads, baggage, tracestate, stack traces, or exception messages.

## Queue Operation Spans

Use `queue_operation_with_logbrew_span()` for sync queue calls and `async_queue_operation_with_logbrew_span()` for async calls when you want one app-owned publish/process span without installing or patching Celery, RQ, Dramatiq, or broker clients:

```python
from logbrew_sdk import LogBrewClient, queue_operation_with_logbrew_span

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-worker",
    sdk_version="1.0.0",
)

queued = queue_operation_with_logbrew_span(
    "publish checkout.email",
    client=client,
    event_id="evt_checkout_email_publish",
    timestamp="2026-06-19T13:00:00Z",
    operation=lambda: celery_task.apply_async(args=[order_id]),
    system="celery",
    operation_kind="publish",
    queue_name="email",
    task_name="checkout.email",
    message_count=1,
    metadata={"service": "checkout-worker"},
    span_events=[
        {"name": "queue.publish.confirmed", "metadata": {"brokerPartition": 4}},
    ],
)
```

The helper activates a child `LogBrewTraceContext` while your callable runs, queues one span named from the queue system and operation, preserves the original result or exception, and reports telemetry capture failures through `on_capture_error` without replacing the queue result. Metadata is intentionally bounded to primitive caller metadata, `queueSystem`, `queueOperation`, optional operation kind, optional queue/task names, optional non-negative message count/attempt, sampled state, optional bounded span events, and exception type. It drops message-like metadata fields and does not monkeypatch queue frameworks, write broker metadata, open support tickets, capture job arguments, message bodies, headers, cookies, broker URLs, baggage, tracestate, stack traces, or exception messages.

For RQ jobs, use `rq_operation_with_logbrew_span()` when you want LogBrew to derive safe `func_name` and `origin` metadata from an app-owned job object without installing RQ as a LogBrew dependency or patching `Queue`/`Worker` globally:

```python
from logbrew_sdk import LogBrewClient, rq_operation_with_logbrew_span

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-worker",
    sdk_version="1.0.0",
)

job = queue.create_job(checkout_email_task, args=[order_id])
queued = rq_operation_with_logbrew_span(
    client=client,
    event_id="evt_checkout_email_rq_publish",
    timestamp="2026-06-19T14:00:00Z",
    job=job,
    operation=lambda: queue.enqueue_job(job),
    operation_kind="publish",
    metadata={"service": "checkout-worker"},
)
```

The RQ helper records one `rq` queue span using explicit caller control. It reads only string-like `job.func_name` and `job.origin` by default, lets you override queue/task names, accepts the same bounded `span_events` option as the generic queue helper, and still avoids job args, kwargs, descriptions, broker metadata writes, global worker patching, baggage, and tracestate.

For Celery tasks, use `celery_operation_with_logbrew_span()` when you want safe task and queue metadata without registering Celery signals or patching `apply_async`. To connect producer and worker spans, create an explicit W3C carrier with `create_celery_trace_headers()` and pass it to your own `apply_async(...)` call:

```python
from logbrew_sdk import (
    LogBrewClient,
    celery_operation_with_logbrew_span,
    create_celery_trace_headers,
)

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-worker",
    sdk_version="1.0.0",
)

queued = celery_operation_with_logbrew_span(
    client=client,
    event_id="evt_checkout_receipt_celery_publish",
    timestamp="2026-06-19T15:00:00Z",
    task=send_receipt_task,
    operation=lambda: send_receipt_task.apply_async(
        args=[order_id],
        headers=create_celery_trace_headers(),
    ),
    operation_kind="publish",
    queue_name="receipts",
    metadata={"service": "checkout-worker"},
)
```

On the worker side, pass the task object as usual. If `task.request.headers` contains a valid `traceparent`, the helper uses it as the upstream parent for the processing span. You can also extract the parent yourself with `logbrew_trace_context_from_celery_headers(task.request.headers)` and pass it as `trace=...` when you need explicit control.

The Celery helper reads only string-like `task.name`, an optional routing key from `task.request.delivery_info`, and a valid W3C `traceparent` from app-owned task headers. `create_celery_trace_headers()` writes only one `traceparent` key; it does not write baggage, tracestate, arbitrary headers, task args, kwargs, broker URLs, or payload data. The helper still avoids signal registration, global patching, hidden header mutation, task IDs, request-header capture, exception messages, and stack traces.

## Agent-Readable Timelines

Use `create_product_action_attributes()` and `create_network_milestone_attributes()` when your service already knows important product steps or API milestones. The helpers create normal `action` event attributes with primitive metadata that AI assistants can analyze across sessions without visual replay, global HTTP patching, payload capture, or header capture.

```python
from logbrew_sdk import (
    LogBrewClient,
    create_network_milestone_attributes,
    create_product_action_attributes,
)

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="checkout-api",
    sdk_version="1.0.0",
)

client.action(
    "evt_checkout_submit",
    "2026-06-02T10:00:05Z",
    create_product_action_attributes(
        {
            "name": "checkout.submit",
            "status": "running",
            "sessionId": "sess_123",
            "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
            "routeTemplate": "/checkout/:step",
            "funnel": "checkout",
            "step": "submit",
            "metadata": {"service": "checkout"},
        }
    ),
)
client.action(
    "evt_payment_api",
    "2026-06-02T10:00:06Z",
    create_network_milestone_attributes(
        {
            "routeTemplate": "/payments/:id",
            "method": "POST",
            "statusCode": 202,
            "durationMs": 94,
            "sessionId": "sess_123",
            "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
            "metadata": {"service": "checkout"},
        }
    ),
)
```

Timeline helpers keep only primitive metadata, strip query strings and hashes from route templates, normalize HTTP methods, infer failed network milestones from status codes `400` and above, and serialize through the existing `action` event type. Keep metadata low-cardinality, such as `sessionId`, `traceId`, `routeTemplate`, `method`, `statusCode`, `durationMs`, `screen`, `funnel`, and `step`.

The packaged `agent-timeline` example shows a two-event checkout timeline with explicit `traceparent` propagation and sanitized product/network metadata:

```bash
python -m logbrew_sdk.examples agent-timeline
```

## HTTP Delivery

Use `HttpTransport` for real outbound delivery from server-side Python apps:

```python
from logbrew_sdk import HttpTransport, LogBrewClient

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-python",
    sdk_version="0.1.0",
)
transport = HttpTransport(
    endpoint="https://api.logbrew.com/v1/events",
    headers={"x-logbrew-source": "python-worker"},
)

client.log(
    "evt_worker_started",
    "2026-06-02T10:00:06Z",
    {"message": "worker started", "level": "info", "logger": "worker"},
)
client.flush(transport)
```

`HttpTransport` uses Python's standard-library HTTP stack, posts JSON, passes the SDK key through the `authorization` header, supports custom endpoint/header/timeout settings, and maps connection failures into retryable `TransportError.network(...)` failures so `LogBrewClient.flush()` can preserve queued events and retry.

## Standard Logging

Use `LogBrewLoggingHandler` when an application already uses Python's standard `logging` module:

```python
import logging

from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-python",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
handler = LogBrewLoggingHandler(
    client,
    transport,
    flush_on_emit=True,
    metadata={"service": "checkout"},
)

logger = logging.getLogger("checkout.worker")
logger.addHandler(handler)
logger.setLevel(logging.INFO)

logger.info("worker started", extra={"order_id": "ord_123"})
```

The handler does not change global logging configuration. It maps standard logging levels into canonical LogBrew severities (`info`, `warning`, `error`, `critical`), keeps the logger name, captures primitive `extra={...}` values as metadata, and records source file name, function, line, thread, and process names without sending the full source path by default. Python `DEBUG` records are captured as `info` and `CRITICAL` records as `critical`; the original Python level name and number remain available in metadata. Exception type and message are captured when `exc_info` is present; full exception text is opt-in with `include_exception_text=True`.
