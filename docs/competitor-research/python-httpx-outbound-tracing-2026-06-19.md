# Python httpx outbound tracing research - 2026-06-19

## Sources read

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `907dd48f1a118d75ddb2f2178e879bdc5fa71283`.
- Sentry files/functions: `sentry_sdk/integrations/httpx.py` and `sentry_sdk/integrations/httpx2.py`; `HttpxIntegration`, `_install_httpx_client`, `_install_httpx_async_client`, patched `Client.send`, patched `AsyncClient.send`.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`.
- OpenTelemetry files/functions: `instrumentation/opentelemetry-instrumentation-httpx/src/opentelemetry/instrumentation/httpx/__init__.py`; `SyncOpenTelemetryTransport`, `AsyncOpenTelemetryTransport`, `_inject_propagation_headers`, `HTTPXClientInstrumentor._handle_request_wrapper`, `HTTPXClientInstrumentor._handle_async_request_wrapper`.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `90d3cc64f59ff10213396b37bf83c49a260afab8`.
- Datadog files/functions: `ddtrace/contrib/internal/httpx/patch.py` and `utils.py`; `patch`, `unpatch`, `_wrapped_sync_send`, `_wrapped_async_send`, `_wrapped_sync_send_single_request`, `_wrapped_async_send_single_request`, `_get_service_name`, `httpx_url_to_str`.

## Competitor patterns

- Sentry gives developers automatic sync and async `httpx` coverage by monkeypatching `httpx.Client.send` and `httpx.AsyncClient.send`. It injects tracing headers, creates spans, and preserves response/error behavior, but the global patch can surprise apps and it records broader request URL context than LogBrew should capture by default.
- OpenTelemetry offers both explicit transport wrappers and global client instrumentation. It handles propagation injection, sync/async spans, metrics, status/error mapping, and request/response hooks, but this is heavier and assumes OTel dependencies and instrumentation ownership.
- Datadog globally patches sync/async send paths and lower-level single-request send methods, derives service names, injects distributed tracing, and captures richer request context including URL-derived values. That improves automatic coverage but increases dependency and patching surface.

## LogBrew implementation

- Added `httpx_request_with_logbrew_span(...)` and `async_httpx_request_with_logbrew_span(...)` to `logbrew-sdk` Python.
- The helpers are explicit and dependency-free by default: apps pass a caller-owned `request` callable or `session`, or install `httpx` for the default sync/async request path.
- LogBrew clones caller headers, replaces any caller `traceparent` with exactly one normalized child W3C header, activates the child trace during the sync or awaited call, queues one sanitized span, and returns the original response or re-raises the original error.
- Span metadata is privacy-bounded: method, route template, status code, sampled flag, primitive caller metadata, and exception type/status on failure. It avoids payloads, response bodies, headers, cookies, full URLs, query strings, fragments, baggage, tracestate, and raw propagation values.

## Tradeoffs

- Better than Sentry/Datadog for teams that want predictable, opt-in, dependency-light instrumentation with no global monkeypatching and safer default metadata.
- Worse than Sentry/Datadog/OpenTelemetry for teams that want zero-code automatic `httpx` instrumentation across all clients and transports.
- The next safe improvement is an optional framework-owned auto-instrumentation package, not a hidden default patch in core.

## Verification

- `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_sdk.py python/logbrew_py/tests/test_http_client.py`
- `scripts/real_user_python_smoke.sh` now checks `httpx` helper metadata, typecheck, wheel install, wheel reinstall, freeze/direct reinstall, sdist install, and sdist reinstall using dependency-free sync and async caller-owned stubs.
