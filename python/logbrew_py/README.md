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

The built wheel should also carry `py.typed` and wheel metadata with the expected package description before install.
Normal installs also expose standard package metadata like `pip show logbrew-sdk`, `pip show -f logbrew-sdk`, `pip list --format=json`, `pip freeze`, and `importlib.metadata.version("logbrew-sdk")`. The plain `pip show` summary should keep the expected package name, version, summary, author, license expression, and `site-packages` install location.
The built source distribution should also carry `README.md`, `pyproject.toml`, `py.typed`, and the packaged `logbrew_sdk.examples.readme_example` plus `logbrew_sdk.examples.real_user_smoke` modules in the archive itself. Both wheel and source-distribution installs carry the expected `py.typed`, example modules, and dist-info metadata files in `site-packages`, and that installed metadata keeps the pip install command, fake `LOGBREW_API_KEY` placeholder, `preview_json()` guidance, and packaged examples entrypoint commands a user would expect from the package description. Those installs should also keep pip-written `INSTALLER`, `direct_url.json`, `--report`, `pip inspect`, plain `pip show` summary fields, `pip show -f` file listings, and `pip list --format=json` package listings plus the expected `pip freeze` file URL with sha256 provenance so tooling can confirm the package came from the expected wheel or source-distribution artifact, the installed environment should stay clean under `python -m pip check`, both the wheel and source-distribution paths should survive a clean `python -m pip uninstall -y logbrew-sdk` removal before reinstalling the same artifact, a small installed-user `python -m unittest` run should still succeed, the published README example should still run from the installed package on both the main install and the reinstall paths, and the packaged examples entrypoint should be discoverable and runnable through `python -m logbrew_sdk.examples --help`, `python -m logbrew_sdk.examples --list`, `python -m logbrew_sdk.examples readme-example`, `python -m logbrew_sdk.examples real-user-smoke`, `python -m logbrew_sdk.examples`, `python -m logbrew_sdk.examples.readme_example`, and `python -m logbrew_sdk.examples.real_user_smoke`, with both `--help` and `--list` printing copy-pasteable packaged-example commands, including explicit named README-example and real-user-smoke entrypoint commands plus the default no-argument `python -m logbrew_sdk.examples` path being called out explicitly as the `real-user-smoke` entrypoint, instead of only generic argument help or bare example names. A one-line direct requirements file derived from that freeze output should also reinstall cleanly under `python -m pip install --require-hashes -r ...` in a fresh virtual environment.
The installed module, public payload shape types like `ReleaseAttributes`, `SpanAttributes`, and `TraceparentContext`, `LogBrewClient`, `HttpTransport`, `RecordingTransport`, `SdkError`, `TransportResponse`, `TransportError`, W3C trace helpers like `parse_traceparent()`, `create_traceparent()`, and `span_attributes_from_traceparent()`, and key lifecycle methods like `create()`, `preview_json()`, `flush()`, `shutdown()`, `pending_events()`, `always_accept()`, and `TransportError.network()` also expose stable docstrings that tools like `help(...)` can show after install. Installed wheel and sdist paths now both prove the field-level typing metadata for commonly inspected attributes like `TransportResponse.status_code`, `TransportResponse.attempts`, and `RecordingTransport.sent_bodies`, prove the typed consumer through a temp `pyproject.toml`-driven mypy config, and prove a consumer-owned `Makefile` that wraps the installed-user typecheck, unittest, README-example, packaged-example, packaged examples list, packaged examples help, packaged examples entrypoint, packaged real-user example, and happy-path smoke commands instead of relying only on loose raw commands, with plain `make` printing copy-pasteable `make smoke-...` commands and the shorter `make smoke-run` path labeled explicitly as the `real-user-smoke` flow.

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
