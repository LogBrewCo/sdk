# Python Flask Tracing Research - 2026-07-07

## Scope

Evaluate Flask request tracing patterns in public competitor SDKs before adding LogBrew's Flask integration. The goal was a lighter, app-owned Flask path that still captures first-useful request spans, exception issues, W3C trace continuation, logger correlation, and local fake-intake proof.

## Sources Read

- Sentry Python, `getsentry/sentry-python@85ba59f707654719bc5edbb224c01884103d9c8b`
- Sentry paths: `setup.py`, `sentry_sdk/integrations/flask.py`, `sentry_sdk/integrations/wsgi.py`, `sentry_sdk/integrations/_wsgi_common.py`, `sentry_sdk/integrations/httpx.py`, `sentry_sdk/integrations/aiohttp.py`, `tests/integrations/flask/test_flask.py`
- Sentry functions/classes read: `FlaskIntegration.setup_once`, `_request_started`, `_set_transaction_name_and_source`, `FlaskRequestExtractor`, `_capture_exception`, `SentryWsgiMiddleware.__call__`
- Datadog Python, `DataDog/dd-trace-py@c3e1f08d9b39b2984827eea4249c3f0370579199`
- Datadog paths: `ddtrace/contrib/internal/flask/patch.py`, `ddtrace/contrib/internal/flask/wrappers.py`, `ddtrace/contrib/internal/requests/patch.py`, `ddtrace/contrib/internal/requests/session.py`, `ddtrace/contrib/internal/httpx/patch.py`, `ddtrace/contrib/internal/urllib3/patch.py`, `tests/contrib/flask`
- Datadog functions/classes read: `patch`, `_FlaskWSGIMiddleware`, `patched_wsgi_app`, `_collect_flask_routes`, `_walk_wsgi_mounts`, `patched_add_url_rule`, `wrap_view`, `_wrap_call`, `_wrap_call_with_tracing_check`
- OpenTelemetry Python Contrib, `open-telemetry/opentelemetry-python-contrib@6b55f8290d30ae4cbf04aef4ccf8fd9215d9f95e`
- OpenTelemetry paths: `instrumentation/opentelemetry-instrumentation-flask/pyproject.toml`, `instrumentation/opentelemetry-instrumentation-flask/src/opentelemetry/instrumentation/flask/__init__.py`, `instrumentation/opentelemetry-instrumentation-requests/src/opentelemetry/instrumentation/requests/__init__.py`, `instrumentation/opentelemetry-instrumentation-httpx/src/opentelemetry/instrumentation/httpx/__init__.py`, `instrumentation/opentelemetry-instrumentation-urllib3/src/opentelemetry/instrumentation/urllib3/__init__.py`
- OpenTelemetry functions/classes read: `get_default_span_name`, `_rewrapped_app`, `_wrapped_before_request`, `_wrapped_teardown_request`, `_InstrumentedFlask`, `FlaskInstrumentor.instrument_app`
- PostHog Python, `PostHog/posthog-python@b4056cbe057085480027258645afe693e13fd15e`
- PostHog paths checked: `posthog/client.py` plus repository search for Flask instrumentation. No comparable source-level Flask trace middleware was found in that package.

## Competitor Patterns

Sentry combines Flask signals with a WSGI middleware wrapper. It can derive transaction names from endpoints and URL rules, continue traces through WSGI request extraction, and capture Flask exceptions with request context. This is mature and broad, but it patches `Flask.__call__`, which is less app-owned than explicit middleware registration.

Datadog uses a broad integration patch that wraps Flask WSGI app dispatch, request hooks, routes, views, templates, and errors. This creates rich automatic coverage, but the tradeoff is hidden global patching and more surface area for privacy and compatibility review.

OpenTelemetry's Flask instrumentation wraps the WSGI app and request lifecycle hooks, names spans from routes, exposes request/response hooks, and supports optional header capture/sanitization. It is portable and flexible, but users must reason about OTel provider/exporter setup and header capture policy.

PostHog's Python package did not expose a comparable Flask tracing middleware in the public source checked for this cycle.

## Outbound HTTP Composition Pattern

Sentry and Datadog compose Flask request traces with outbound HTTP spans by patching client libraries such as httpx, aiohttp, requests, and urllib3. This is convenient and gives users broader automatic traces, but it also means client calls are intercepted outside the direct call site and require careful privacy controls around URLs, headers, and request metadata.

OpenTelemetry uses separate instrumentor packages for Flask and HTTP clients. This keeps the pieces modular, but users still need to opt into multiple instrumentors and understand provider/exporter wiring.

LogBrew keeps the Flask package app-owned and uses the existing core Python HTTP helper inside the active Flask request. The helper creates a child span under the Flask request span, injects one W3C `traceparent`, and records only method, route template, status, trace ids, span ids, source, and primitive metadata. It does not capture full URLs, query strings, request/response bodies, arbitrary headers, cookies, baggage, or tracestate.

## Packaging Pattern

Sentry ships Flask support as a `sentry-sdk` extra in `setup.py`, while Datadog keeps Flask instrumentation under the main `ddtrace` package. OpenTelemetry ships a separate `opentelemetry-instrumentation-flask` distribution with a `FlaskInstrumentor` entry point. PostHog's checked Python source did not expose a Flask tracing package.

LogBrew follows the OpenTelemetry-style optional package boundary for Flask: `logbrew-flask` depends on `logbrew-sdk` and Flask, so core Python users do not install Flask dependencies by default. The release workflow now builds and checks `python/logbrew_flask` with the other Python distributions and can publish/verify `logbrew-flask` only when `include_pypi_extras=true` and the PyPI trusted publisher is configured. No real PyPI release was made in this cycle.

## LogBrew Design

LogBrew adds `logbrew-flask` as a separate typed package rather than hiding Flask behavior in the core Python SDK. Apps call `add_logbrew_middleware(app, ...)`, which registers app-owned Flask hooks without monkeypatching `Flask.__call__` or patching Flask globally.

The integration captures one low-cardinality request span per captured response, one issue plus error span for Flask exceptions, optional `http.server.duration` metrics, active request trace access for handlers, and `LogBrewLoggingHandler` correlation under the active request span. Valid inbound W3C `traceparent` headers are continued with fresh child span ids; malformed propagation falls back without echoing raw header values.

Privacy defaults are stricter than the richer automatic competitors: no request bodies, response bodies, cookies, arbitrary headers, query strings, raw `traceparent`, baggage, or tracestate are captured. Dynamic route values are not emitted when Flask exposes a route template.

## Verification Added

- `python/logbrew_flask/tests/test_flask_integration.py`
- `scripts/check_flask_package.sh`
- `scripts/real_user_flask_smoke.sh`
- `.github/workflows/publish-packages.yml` guarded `logbrew-flask` PyPI extras path
- `python -m logbrew_flask.examples outbound-http` packaged example

The installed-artifact proofs build local `logbrew-sdk` and `logbrew-flask` wheels/sdists, install them into fresh virtual environments, run Flask test-client flows, prove log/span/issue correlation, prove Flask request span to outbound HTTP child span correlation, validate the injected `traceparent` span id against the emitted outbound span id, validate typed consumer usage, and exercise packaged examples.

## Remaining Gap

LogBrew is still intentionally lighter than Sentry, Datadog, and OpenTelemetry for automatic Flask view/template/database/outbound instrumentation. The next Flask-related improvements should come from concrete user demand or source-backed proof that narrower explicit helpers can improve time-to-answer without adopting broad hidden patching.
