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

## 2026-07-04 Failure Metadata Privacy Pass

### Sources Re-read

- Sentry Python SDK, [`getsentry/sentry-python`](https://github.com/getsentry/sentry-python/tree/1bd120f41780bfd5fd4d4b7c65aae395e425adab) at commit `1bd120f41780bfd5fd4d4b7c65aae395e425adab`.
- Sentry files/functions: `sentry_sdk/integrations/httpx.py` (`HttpxIntegration`, `_install_httpx_client`, `_install_httpx_async_client`), `sentry_sdk/integrations/stdlib.py` (`StdlibIntegration`, `_install_httplib`, `_complete_span`), and `sentry_sdk/integrations/aiohttp.py` (`AioHttpIntegration`, `create_trace_config`, `_capture_exception`).
- OpenTelemetry Python Contrib, [`open-telemetry/opentelemetry-python-contrib`](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/2359804163c7c2426858453d647d20d1b5d93782) at commit `2359804163c7c2426858453d647d20d1b5d93782`.
- OpenTelemetry files/functions: `opentelemetry-instrumentation-requests` `instrumented_send`, `opentelemetry-instrumentation-urllib` `_instrumented_open_call`, `opentelemetry-instrumentation-httpx` `SyncOpenTelemetryTransport.handle_request`/`AsyncOpenTelemetryTransport.handle_async_request`, and `opentelemetry-instrumentation-aiohttp-client` `create_trace_config`/`on_request_exception`.
- Datadog `dd-trace-py`, [`DataDog/dd-trace-py`](https://github.com/DataDog/dd-trace-py/tree/c12bb9dfb723bb96a662b7b90f36c805c4af43fb) at commit `c12bb9dfb723bb96a662b7b90f36c805c4af43fb`.
- Datadog files/functions: `ddtrace/contrib/internal/requests/connection.py` `_wrap_send`, `ddtrace/contrib/internal/requests/patch.py` `patch`/`unpatch`, `ddtrace/contrib/internal/httpx/patch.py` `_wrapped_sync_send`/`_wrapped_async_send`, and `ddtrace/contrib/_events/http_client.py`/`http.py` response metadata events.
- PostHog Python, [`PostHog/posthog-python`](https://github.com/PostHog/posthog-python/tree/6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1) at commit `6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1`; no comparable general-purpose outbound HTTP client tracing integration was found in the searched public source.

### Pattern and Tradeoff

- Sentry, Datadog, and OpenTelemetry are still stronger for broad automatic HTTP client coverage, especially zero-touch `http.client`/`requests`/`httpx`/`aiohttp` paths.
- OpenTelemetry's current HTTP client instrumentation records exception type through `ERROR_TYPE` on failure paths while keeping request/response header capture opt-in and sanitizable. Sentry and Datadog carry richer automatic instrumentation but also broader patching and URL/header/body capture surfaces depending on options.
- LogBrew's core Python SDK should keep the lighter explicit-helper model until an optional integration package owns the heavier auto-patching surface.

### LogBrew Change

- Tightened Python outbound HTTP failure spans so `urlopen_with_logbrew_span(...)`, `requests_request_with_logbrew_span(...)`, `httpx_request_with_logbrew_span(...)`, and `async_httpx_request_with_logbrew_span(...)` record `errorType` and status code when available, but never serialize exception messages into span metadata.
- This preserves first-debugging utility for status/type/route/duration/trace correlation while avoiding accidental leakage of user-specific request details or service response text from exception messages.

### Verification

- RED before implementation: focused Python tests failed because failed `urllib`, `requests`, sync `httpx`, and async `httpx` spans contained `errorMessage`.
- GREEN after implementation: focused tests pass and verify original exception identity, status code, source, route privacy, and absence of private exception text in serialized event JSON.

## 2026-07-04 Per-Client Auto Instrumentation Pass

### Sources Re-read

- Sentry Python SDK, [`getsentry/sentry-python`](https://github.com/getsentry/sentry-python/tree/1bd120f41780bfd5fd4d4b7c65aae395e425adab) at commit `1bd120f41780bfd5fd4d4b7c65aae395e425adab`.
- Sentry files/functions: `sentry_sdk/integrations/httpx.py` (`HttpxIntegration.setup_once`, `_install_httpx_client`, `_install_httpx_async_client`) and `sentry_sdk/integrations/stdlib.py` (`StdlibIntegration.setup_once`, `_install_httplib`, `_complete_span`). No separate `requests.py` integration is present in `sentry_sdk/integrations`; requests traffic is covered through lower-level stdlib/HTTP behavior where applicable.
- OpenTelemetry Python Contrib, [`open-telemetry/opentelemetry-python-contrib`](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/2359804163c7c2426858453d647d20d1b5d93782) at commit `2359804163c7c2426858453d647d20d1b5d93782`.
- OpenTelemetry files/functions: `opentelemetry-instrumentation-requests` `_instrument`, `instrumented_send`, `_uninstrument`, `RequestsInstrumentor._instrument`; `opentelemetry-instrumentation-httpx` `HTTPXClientInstrumentor.instrument_client`, `uninstrument_client`, `SyncOpenTelemetryTransport.handle_request`, `AsyncOpenTelemetryTransport.handle_async_request`, `_inject_propagation_headers`.
- Datadog `dd-trace-py`, [`DataDog/dd-trace-py`](https://github.com/DataDog/dd-trace-py/tree/c12bb9dfb723bb96a662b7b90f36c805c4af43fb) at commit `c12bb9dfb723bb96a662b7b90f36c805c4af43fb`.
- Datadog files/functions: `ddtrace/contrib/internal/requests/patch.py` `patch`/`unpatch`, `ddtrace/contrib/internal/requests/connection.py` `_wrap_send`, and `ddtrace/contrib/internal/httpx/patch.py` `_wrapped_sync_send`, `_wrapped_async_send`, `_wrapped_sync_send_single_request`, `_wrapped_async_send_single_request`, `patch`, `unpatch`.
- PostHog Python, [`PostHog/posthog-python`](https://github.com/PostHog/posthog-python/tree/6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1) at commit `6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1`; searched public tree paths for `requests`, `httpx`, and `urllib` and found only request type stubs, not a comparable outbound HTTP tracing integration.

### Pattern and Tradeoff

- Sentry, Datadog, and OpenTelemetry remain ahead on broad zero-touch HTTP coverage. Their integrations patch global classes or transport methods, inject propagation before send, finish spans on response or exception, and expose some unpatch/uninstrument controls.
- OpenTelemetry's `HTTPXClientInstrumentor.instrument_client(...)` is the safer pattern for LogBrew to adapt first because it instruments caller-selected clients instead of forcing process-wide behavior.
- LogBrew should avoid copying broad URL/header/body capture surfaces. A narrower LogBrew-native version should instrument only app-owned client instances, preserve original responses/errors, and keep query strings, payloads, headers, exception messages, baggage, and tracestate out of payloads by default.

### LogBrew Change

- Added `instrument_requests_session_with_logbrew_spans(...)` for app-owned `requests.Session`-style objects and `instrument_httpx_client_with_logbrew_spans(...)` for app-owned sync or async `httpx` client-style objects.
- Each helper wraps one instance's `request` method, returns a handle with `installed` and `uninstall()`, returns the existing handle on duplicate installation, uses an event ID factory for per-call spans, supports optional route-template resolution, and delegates span capture to the already verified explicit helpers.
- The helpers do not patch global `requests`, global `httpx.Client`, global `httpx.AsyncClient`, lower-level transports, request/response hooks, or stdlib networking. They do not add runtime dependencies, create hidden sessions, capture payloads, headers, full URLs, query strings, exception messages, baggage, tracestate, or raw propagation metadata.

### Verification

- RED before implementation: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python.logbrew_py.tests.test_http_client -v` failed because `instrument_httpx_client_with_logbrew_spans` and `instrument_requests_session_with_logbrew_spans` were not exported.
- GREEN focused proof now covers requests session instrumentation, duplicate install, uninstall, sync httpx instrumentation, async httpx instrumentation, normalized traceparent injection, event ID factories, route-template resolver use, original error preservation, type-only failure metadata, and omission of query/header/payload/error-message data.

## 2026-07-04 Aiohttp Client Session Pass

### Sources Re-read

- Sentry Python SDK, [`getsentry/sentry-python`](https://github.com/getsentry/sentry-python/tree/1bd120f41780bfd5fd4d4b7c65aae395e425adab) at commit `1bd120f41780bfd5fd4d4b7c65aae395e425adab`.
- Sentry file/functions: `sentry_sdk/integrations/aiohttp.py` `AioHttpIntegration.setup_once`, `create_trace_config`, `on_request_start`, and `on_request_end`.
- OpenTelemetry Python Contrib, [`open-telemetry/opentelemetry-python-contrib`](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/2359804163c7c2426858453d647d20d1b5d93782) at commit `2359804163c7c2426858453d647d20d1b5d93782`.
- OpenTelemetry file/functions: `instrumentation/opentelemetry-instrumentation-aiohttp-client/src/opentelemetry/instrumentation/aiohttp_client/__init__.py` `create_trace_config`, `_end_trace`, `on_request_start`, `on_request_end`, `on_request_exception`, `_instrument`, `_uninstrument`, `_uninstrument_session`, `AioHttpClientInstrumentor._instrument`, and `AioHttpClientInstrumentor.uninstrument_session`.
- Datadog `dd-trace-py`, [`DataDog/dd-trace-py`](https://github.com/DataDog/dd-trace-py/tree/c12bb9dfb723bb96a662b7b90f36c805c4af43fb) at commit `c12bb9dfb723bb96a662b7b90f36c805c4af43fb`.
- Datadog file/functions: `ddtrace/contrib/internal/aiohttp/patch.py` `_traced_clientsession_request`, `_traced_clientsession_init`, `patch`, `_unpatch_client`, and `unpatch`.
- PostHog Python, [`PostHog/posthog-python`](https://github.com/PostHog/posthog-python/tree/6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1) at commit `6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1`; searched public tree paths for `aiohttp` and async HTTP tracing and found no comparable general-purpose aiohttp client tracing integration.

### Pattern and Tradeoff

- Sentry and OpenTelemetry add `aiohttp` `TraceConfig` hooks during session setup, then create and finish spans from request start/end/exception callbacks.
- Datadog uses broader process-level patching around `ClientSession.__init__`, `ClientSession._request`, and connector behavior so users get more automatic coverage and timing detail.
- Those mature paths are still stronger for zero-touch coverage and request lifecycle richness, but they also carry broader mutation surfaces, optional URL/header/body capture paths, baggage/tracestate propagation, and extra dependency/runtime coupling.

### LogBrew Change

- Added `aiohttp_request_with_logbrew_span(...)` for explicit app-owned async requests and `instrument_aiohttp_client_session_with_logbrew_spans(...)` for one caller-owned `aiohttp.ClientSession`-style instance.
- The instrumentation wraps only the session instance's `_request` coroutine, returns a `LogBrewAiohttpClientSessionInstrumentation` handle, returns the existing handle on duplicate install, and puts the original coroutine back with `uninstall()`.
- It writes one normalized child W3C `traceparent`, keeps the child trace active during the awaited request, queues route/status/duration/source/error-type metadata, preserves original responses/errors, and captures direct `status`/`status_code` error shapes used by `aiohttp.ClientResponseError`.
- It does not patch `aiohttp.ClientSession` globally, add `TraceConfig`, own connectors/sessions, capture payloads, headers, cookies, full URLs, query strings, fragments, exception messages, baggage, tracestate, raw propagation metadata, support tickets, or backend-owned behavior.

### Verification

- RED before implementation: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python.logbrew_py.tests.test_http_client -v` failed because `LogBrewAiohttpClientSessionInstrumentation` was not exported.
- Second RED for real aiohttp status shape: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python.logbrew_py.tests.test_http_client.HttpClientInstrumentationTests.test_aiohttp_client_session_instrumentation_preserves_errors_without_message_metadata -v` failed with missing `statusCode` when the exception exposed direct `status`.
- GREEN focused and full Python unit discovery cover explicit aiohttp request spans, per-session install/duplicate/uninstall behavior, normalized traceparent propagation, active child context during request execution, direct-status failure metadata, original error preservation, and omission of query/header/payload/error-message data.
- Installed wheel/sdist smoke now installs real `aiohttp`, starts a local `aiohttp.web` server, instruments a real `ClientSession`, verifies propagated traceparent, clean uninstall, real `ClientResponseError` status capture, package metadata/type surface, and no query/header/body/error-message leakage.

### Remaining Gap

- Sentry, Datadog, and OpenTelemetry still lead on automatic aiohttp lifecycle coverage, TraceConfig ownership, connector/request phase timings, metrics, baggage/tracestate, and broader automatic HTTP client patching. Keep LogBrew core explicit and app-owned unless a separate integration package owns the heavier dependency, privacy, uninstall, and high-load behavior.

## 2026-07-07 FastAPI/Django Request-to-Outbound Proof

### Sources Reused

- Sentry Python source already read for this gap: `sentry_sdk/integrations/asgi.py`, `sentry_sdk/integrations/django/__init__.py`, `sentry_sdk/integrations/httpx.py`, `sentry_sdk/integrations/stdlib.py`, and `sentry_sdk/integrations/aiohttp.py`.
- Datadog Python source already read for this gap: `ddtrace/contrib/internal/fastapi/patch.py`, `ddtrace/contrib/internal/django/*`, `ddtrace/contrib/internal/requests/patch.py`, `ddtrace/contrib/internal/requests/connection.py`, and `ddtrace/contrib/internal/httpx/patch.py`.
- OpenTelemetry Python Contrib source already read for this gap: `opentelemetry-instrumentation-fastapi`, `opentelemetry-instrumentation-django`, `opentelemetry-instrumentation-asgi`, `opentelemetry-instrumentation-requests`, and `opentelemetry-instrumentation-httpx`.
- PostHog Python public source previously searched for comparable HTTP/client tracing and still has no source-level equivalent in the checked paths.

### Pattern and Tradeoff

- Sentry, Datadog, and OpenTelemetry are stronger for broad automatic composition: a framework request span remains active while patched HTTP clients create outbound child spans and inject propagation headers.
- That is convenient for users, but the competitor pattern typically depends on process-wide or library-level patching and requires careful policy for URLs, headers, payloads, baggage, tracestate, and lifecycle hooks.
- LogBrew's lighter path should keep framework packages explicit and app-owned until a concrete integration can prove richer automation without hidden mutation or broader capture.

### LogBrew Change

- Added packaged `python -m logbrew_fastapi.examples outbound-http` and `python -m logbrew_django.examples outbound-http` examples.
- Each example runs a framework test client, accepts an incoming W3C `traceparent`, uses the active request trace inside the handler/view, wraps a caller-owned `requests`-style request seam with `requests_request_with_logbrew_span(...)`, and emits one outbound child span plus one framework request span.
- The proofs validate that the outgoing `traceparent` span id matches the emitted outbound span id and that the outbound span parent is the framework request span. Events keep only route/status/duration/source and primitive metadata; they do not capture payloads, headers, cookies, full URLs, query strings, exception messages, baggage, tracestate, raw propagation metadata, or global HTTP client patches.

### Verification

- RED before implementation: installed-artifact FastAPI and Django smokes failed after typecheck because the packaged `outbound-http` example was absent from the example list.
- GREEN proof runs through `scripts/check_fastapi_package.sh`, `scripts/check_django_package.sh`, `scripts/real_user_fastapi_smoke.sh`, and `scripts/real_user_django_smoke.sh`, which build local wheels/sdists, install into fresh virtual environments, run package metadata checks, run framework test-client flows, and execute the outbound examples from installed packages.

### Remaining Gap

- Sentry, Datadog, and OpenTelemetry still lead on automatic FastAPI/Django outbound coverage, DB/cache/queue spans, baggage/tracestate, request phase timings, and richer span event/link models. LogBrew is now stronger for agent-readable installed proof and privacy-bounded explicit composition, but not yet for zero-touch breadth.
