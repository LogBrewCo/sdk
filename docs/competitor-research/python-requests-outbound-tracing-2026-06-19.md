# Python `requests` Outbound Tracing

Date: 2026-06-19

## Competitor Source Read

- Sentry Python `https://github.com/getsentry/sentry-python.git` at `907dd48f1a118d75ddb2f2178e879bdc5fa71283`.
- Read `sentry_sdk/integrations/stdlib.py`: patched `HTTPConnection.putrequest(...)`/`getresponse(...)` span and breadcrumb flow, `should_propagate_trace(...)`, and current `tests/integrations/requests/test_requests.py` coverage for `requests` through stdlib HTTP instrumentation.
- Read `sentry_sdk/integrations/httpx.py`: `HttpxIntegration.setup_once()`, `_install_httpx_client()`, and `_install_httpx_async_client()` patch `Client.send`/`AsyncClient.send`, set HTTP client spans, propagate Sentry trace headers, and mark status.
- OpenTelemetry Python Contrib `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`.
- Read `instrumentation/opentelemetry-instrumentation-requests/src/opentelemetry/instrumentation/requests/__init__.py`: `_instrument(...)`, `instrumented_send(...)`, `RequestsInstrumentor._instrument(...)`, and `get_default_span_name(...)`.
- Datadog dd-trace-py `https://github.com/DataDog/dd-trace-py.git` at `90d3cc64f59ff10213396b37bf83c49a260afab8`.
- Read `ddtrace/contrib/internal/requests/patch.py`: `patch()`, `unpatch()`, and `TracedSession` wrapping.
- Read `ddtrace/contrib/internal/requests/connection.py`: `_wrap_send(...)`, URL path extraction, `_extract_query_string(...)`, and `_get_service_name(...)`.
- Read `ddtrace/contrib/internal/requests/session.py`: `TracedSession`.

## Pattern Observed

- Sentry is broad and automatic: current `requests` coverage comes through lower-level stdlib HTTP patching, while `httpx` patches client send methods directly. This is strong for zero-touch coverage but captures broader URL/query/fragment context than LogBrew core should copy by default.
- OpenTelemetry instruments `requests.Session.send`, creates client spans, injects propagation headers, sets status/error attributes, records client duration metrics, and exposes hooks plus optional request/response header capture. It is powerful but dependency-heavy and monkeypatch-oriented.
- Datadog patches `requests.Session.send` and also exposes `TracedSession`; it derives service/resource/status metadata and can include query information depending on configuration. It is mature but broader than LogBrew's privacy-first default.

## LogBrew Change

- Added dependency-free `requests_request_with_logbrew_span(...)` to the Python SDK.
- The helper accepts a caller-owned `requests.Session`, a request callable, or lazily imports `requests.request` only when neither is supplied.
- It clones caller headers, replaces any existing `traceparent` with exactly one normalized W3C child header, runs the outbound call under a child `LogBrewTraceContext`, queues one sanitized dependency span, and returns the original response or re-raises the original exception.
- Span metadata is limited to source, method, route template, status code, sampled flag, error type, and caller-supplied primitive metadata.
- It deliberately avoids monkeypatching, transitive `requests` dependency, payload/body capture, arbitrary header capture, response-body capture, cookies, full URL/query/fragment storage, baggage, tracestate, raw propagation values, backend support-ticket behavior, and local usage/quota inference.

## Verification Added

- Unit tests prove header cloning, traceparent replacement, active child trace during the call, status/error span capture, original response/error preservation, capture-failure isolation, and no query/header/payload leakage in preview JSON.
- `scripts/real_user_python_smoke.sh` now verifies the helper from installed wheel, wheel reinstall, freeze reinstall, direct requirement reinstall, sdist install, and sdist reinstall paths.
- README guidance now teaches both `urllib.request` and `requests` outbound client spans while keeping app-owned request/session control explicit.

## Remaining Gaps

- Python still lacks an explicit `httpx` helper with sync and async coverage.
- Framework outbound/DB/cache/queue spans remain thinner than Sentry, Datadog, and OpenTelemetry.
- LogBrew intentionally avoids global auto-patching in core; any future automatic Python HTTP instrumentation should live in a clearly named integration package with reversible ownership and separate verifier proof.
