# logbrew-fastapi

FastAPI integration for capturing LogBrew request spans and exceptions with the public Python SDK.

## Install

```bash
python3 -m pip install logbrew-sdk logbrew-fastapi
```

The package is typed, ships `py.typed`, depends on the core `logbrew-sdk`, and keeps FastAPI as a normal framework dependency instead of bundling or monkeypatching the user's app.

## Example

```python
from fastapi import FastAPI
from logbrew_fastapi import add_logbrew_middleware
from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-fastapi",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
app = FastAPI()
add_logbrew_middleware(
    app,
    client=client,
    transport=transport,
    span_id_factory=lambda: "b7ad6b7169203331",
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
```

`add_logbrew_middleware()` records successful requests as span events, records unhandled handler exceptions as issue plus error-span events, and flushes through the provided transport after each response. If no transport is provided, events stay queued on the core client so the app can flush them itself.

When an incoming request has a valid W3C `traceparent` header, request capture continues that trace by using the incoming `traceId` and parent span id while creating a fresh child span id. Missing or malformed `traceparent` headers keep the existing synthetic request span behavior so bad client headers do not break the app. Automatic metadata uses the request path without query text.

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
