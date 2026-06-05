# logbrew-fastapi

FastAPI integration for capturing LogBrew request spans and exceptions with the public Python SDK.

## Install

```bash
python3 -m pip install logbrew-sdk logbrew-fastapi
python3 -m logbrew_fastapi.examples --help
python3 -m logbrew_fastapi.examples --list
python3 -m logbrew_fastapi.examples readme-example
python3 -m logbrew_fastapi.examples real-user-smoke
python3 -m logbrew_fastapi.examples
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

When an incoming request has a valid W3C `traceparent` header, request capture continues that trace by using the incoming `traceId` and parent span id while creating a fresh child span id. Missing or malformed `traceparent` headers keep the existing synthetic request span behavior so bad client headers do not break the app. Automatic metadata uses the request path without query text. Use `span_id_factory` only when tests need deterministic child span ids.

By default, transport failures do not break the FastAPI response path. Set `raise_flush_errors=True` in test environments when you want misconfigured transport behavior to fail loudly.

Use a clearly fake placeholder like `LOGBREW_API_KEY` in local examples and tests.
