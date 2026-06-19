# Python Outbound HTTP Tracing Research - 2026-06-19

## Scope

Reduce the Python server-side outbound HTTP tracing gap after Node gained explicit fetch spans. Sentry, OpenTelemetry, and Datadog are stronger for automatic Python HTTP client spans across `http.client`, `urllib`, `requests`, `urllib3`, and `httpx`; LogBrew needed a lighter dependency-free helper that a developer can verify from installed artifacts.

## Competitor Source Read

- Sentry Python SDK, [`getsentry/sentry-python`](https://github.com/getsentry/sentry-python/tree/907dd48f1a118d75ddb2f2178e879bdc5fa71283) at commit `907dd48f1a118d75ddb2f2178e879bdc5fa71283`.
  - `sentry_sdk/integrations/stdlib.py`: `StdlibIntegration.setup_once`, `_install_httplib`, patched `HTTPConnection.putrequest`, `getresponse`, `HTTPResponse.read`, `HTTPResponse.close`, `_complete_span`.
  - `sentry_sdk/integrations/httpx.py`: `HttpxIntegration.setup_once`, `_install_httpx_client`, patched sync/async `Client.send`, response status/error completion, propagation header injection.
- OpenTelemetry Python contrib, [`open-telemetry/opentelemetry-python-contrib`](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb) at commit `a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`.
  - `instrumentation/opentelemetry-instrumentation-urllib/src/opentelemetry/instrumentation/urllib/__init__.py`: `URLLibInstrumentor._instrument`, `_instrument`, `_instrumented_open_call`, propagation `inject(headers)`, status/error/duration recording.
  - `instrumentation/opentelemetry-instrumentation-requests/src/opentelemetry/instrumentation/requests/__init__.py`: `_instrument`, `instrumented_send`, request/response hooks, propagation `inject(headers)`, duration histograms, status/error handling.
- Datadog `dd-trace-py`, [`DataDog/dd-trace-py`](https://github.com/DataDog/dd-trace-py/tree/fef0f9b7ab3177cf52b48fdecf2c4961d65e92a2) at commit `fef0f9b7ab3177cf52b48fdecf2c4961d65e92a2`.
  - `ddtrace/contrib/internal/httpx/patch.py`: `_wrapped_sync_send`, `_wrapped_async_send`, `_wrapped_sync_send_single_request`, `_wrapped_async_send_single_request`, `patch`, `unpatch`.
  - `ddtrace/contrib/internal/urllib3/patch.py`: `_wrap_urlopen`, `patch`, distributed tracing event context, response completion.
  - `ddtrace/contrib/internal/urllib/patch.py`: `patch`, `unpatch` for `urllib.request.urlopen`.

## Observed Pattern

- Mature competitors create a client span around outbound request execution, inject propagation headers before the request leaves, and finish spans on response or exception.
- OpenTelemetry and Datadog expose hooks or event contexts so integrations can add status, duration, headers, and metrics; Sentry also handles response-body read/close lifecycle for lower-level `http.client`.
- The tradeoff is broader mutation: monkey-patching global clients, mutating request headers, optional header/body capture paths, baggage/tracestate propagation, and extra integration dependencies.

## LogBrew Adaptation

- Added dependency-free `urlopen_with_logbrew_span()` in `logbrew-sdk` for app-owned `urllib.request` calls.
- The helper clones the caller `Request`, overwrites exactly one normalized W3C `traceparent`, scopes the opener under a child `LogBrewTraceContext`, queues one span with method, query-free route, HTTP status, duration, sampled flag, and primitive metadata, then returns the response or re-raises the original error.
- Capture failures are non-fatal and can be observed through `on_capture_error`; they do not replace HTTP responses or application exceptions.
- It avoids global monkey-patching, `requests`/`httpx` dependencies, payload/header/cookie/full-URL/query/fragment capture, raw propagation metadata, baggage, tracestate, support tickets, and backend-owned behavior.

## Verification

- TDD red: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_sdk.py -k urlopen_with_logbrew_span` failed with `ImportError: cannot import name 'urlopen_with_logbrew_span'`.
- Unit proof covers request cloning, caller-header preservation, traceparent overwrite, active child context, span correlation, status/duration metadata, query/header/payload redaction, original HTTP error preservation, and non-fatal capture failure.
- Installed-artifact proof is wired into `scripts/real_user_python_smoke.sh` for wheel, wheel reinstall, sdist, sdist reinstall, frozen requirements, and direct requirements.

## Remaining Gaps

- Optional `requests`/`httpx` integration packages could provide one-line adoption for teams that explicitly want those dependencies.
- Python still lacks DB/cache/queue spans, richer span events/exceptions, baggage/tracestate, and automatic HTTP client patching; keep those out of core unless the integration package owns the dependency and broader capture surface.
