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

The helper clones the caller request, writes exactly one normalized W3C `traceparent`, runs the opener under a child `LogBrewTraceContext`, queues one span with method, query-free route, status, duration, and primitive metadata, then returns the original response or re-raises the original HTTP/network error. Telemetry capture failures are reportable through `on_capture_error` and do not replace the app-owned HTTP result. It does not patch `urllib`, does not capture request or response payloads, does not store headers, cookies, query strings, fragments, baggage, tracestate, or raw propagation values.

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

The `requests` helper clones caller headers, replaces any caller-supplied `traceparent` with one normalized child header, runs the request under that child trace context, queues one sanitized dependency span, and returns the original `requests.Response` or re-raises the original exception. It records method, route template, status code, duration, sampled flag, and primitive metadata only. It does not capture payloads, response bodies, headers, cookies, full URLs, query strings, fragments, baggage, tracestate, or raw propagation values.

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

The `httpx` helpers follow the same privacy and failure behavior as the `requests` helper: cloned caller headers, exactly one normalized child `traceparent`, active child trace context during the call or awaited call, sanitized dependency span capture, original response/error preservation, and optional `on_capture_error` reporting for telemetry failures. They do not capture payloads, response bodies, headers, cookies, full URLs, query strings, fragments, baggage, tracestate, or raw propagation values.

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
)
```

The helper activates a child `LogBrewTraceContext` while your callable runs, queues one span named from the DB system and operation, preserves the original result or exception, and reports telemetry capture failures through `on_capture_error` without replacing the database result. Metadata is intentionally bounded to primitive caller metadata, `dbSystem`, `dbOperation`, optional `dbName`, optional `statementTemplate`, optional non-negative `rowCount`, sampled state, and exception type. It does not monkeypatch SQLAlchemy or DB-API drivers, does not open support tickets, and does not capture SQL parameters, result rows, connection strings, network addresses, sensitive configuration values, payloads, baggage, tracestate, stack traces, or exception messages.

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
)
```

The helper activates a child `LogBrewTraceContext` while your callable runs, queues one span named from the cache system and operation, preserves the original result or exception, and reports telemetry capture failures through `on_capture_error` without replacing the cache result. Metadata is intentionally bounded to primitive caller metadata, `cacheSystem`, `cacheOperation`, optional `cacheName`, optional hit state, optional non-negative item size/count, sampled state, and exception type. It drops key-like metadata fields and does not monkeypatch cache clients, open support tickets, capture cache keys, values, commands, payloads, headers, cookies, network addresses, baggage, tracestate, stack traces, or exception messages.

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
)
```

The helper activates a child `LogBrewTraceContext` while your callable runs, queues one span named from the queue system and operation, preserves the original result or exception, and reports telemetry capture failures through `on_capture_error` without replacing the queue result. Metadata is intentionally bounded to primitive caller metadata, `queueSystem`, `queueOperation`, optional operation kind, optional queue/task names, optional non-negative message count/attempt, sampled state, and exception type. It drops message-like metadata fields and does not monkeypatch queue frameworks, write broker metadata, open support tickets, capture job arguments, message bodies, headers, cookies, broker URLs, baggage, tracestate, stack traces, or exception messages.

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

The RQ helper records one `rq` queue span using explicit caller control. It reads only string-like `job.func_name` and `job.origin` by default, lets you override queue/task names, and still avoids job args, kwargs, descriptions, broker metadata writes, global worker patching, baggage, and tracestate.

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
