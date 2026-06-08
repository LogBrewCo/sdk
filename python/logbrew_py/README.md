# logbrew-sdk

Public Python SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
python3 -m pip install logbrew-sdk
python3 -m logbrew_sdk.examples --help
python3 -m logbrew_sdk.examples --list
python3 -m logbrew_sdk.examples readme-example
python3 -m logbrew_sdk.examples real-user-smoke
python3 -m logbrew_sdk.examples
python3 -m logbrew_sdk.examples.readme_example
python3 -m logbrew_sdk.examples.real_user_smoke
```

The package includes `py.typed`, public type aliases such as `ReleaseAttributes`, `SpanAttributes`, `MetricAttributes`, and `TraceparentContext`, and packaged example entrypoints that can be run after install. Use `pip show logbrew-sdk`, `python -m pip check`, and `python -c 'import logbrew_sdk; print(logbrew_sdk.__version__)'` when you want quick install metadata checks.

For Automation Agents

- Run `python3 -m logbrew_sdk.examples --help` and `python3 -m logbrew_sdk.examples --list` to discover the packaged examples.
- Run `python3 -m logbrew_sdk.examples readme-example` for the README payload and `python3 -m logbrew_sdk.examples real-user-smoke` for the fuller local flow.
- Use `help(logbrew_sdk.LogBrewClient)` or `help(logbrew_sdk.HttpTransport)` to inspect the installed API surface from a consumer environment.

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

Use a clearly fake placeholder like `LOGBREW_API_KEY` in local examples and tests. Call `flush()` or `shutdown()` to send queued events through a transport, and use `preview_json()` when you want a stable local JSON preview without sending anything.

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
from logbrew_sdk import parse_traceparent, span_attributes_from_traceparent

traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
context = parse_traceparent(traceparent)
attributes = span_attributes_from_traceparent(
    traceparent,
    name="GET /health",
    span_id="b7ad6b7169203331",
    status="ok",
    duration_ms=12.5,
    metadata={"service": "checkout"},
)
```

`parse_traceparent()` validates W3C shape, rejects all-zero trace/span IDs, normalizes IDs to lowercase, and exposes the sampled flag. `span_attributes_from_traceparent()` returns LogBrew span attributes with `traceId` from the incoming trace and `parentSpanId` from the incoming parent span. FastAPI and Django integrations use these helpers automatically for valid inbound `traceparent` headers and start a fresh synthetic span when the header is missing or malformed.

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

The handler does not change global logging configuration. It maps standard logging levels into LogBrew log levels, keeps the logger name, captures primitive `extra={...}` values as metadata, and records source file name, function, line, thread, and process names without sending the full source path by default. Exception type and message are captured when `exc_info` is present; full exception text is opt-in with `include_exception_text=True`.
