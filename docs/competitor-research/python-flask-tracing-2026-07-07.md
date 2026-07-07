# Python Flask Tracing Research - 2026-07-07

## Scope

Evaluate Flask request tracing patterns in public competitor SDKs before adding LogBrew's Flask integration. The goal was a lighter, app-owned Flask path that still captures first-useful request spans, exception issues, W3C trace continuation, logger correlation, and local fake-intake proof.

## Sources Read

- Sentry Python, `getsentry/sentry-python@85ba59f707654719bc5edbb224c01884103d9c8b`
- Sentry paths: `sentry_sdk/integrations/flask.py`, `sentry_sdk/integrations/wsgi.py`, `sentry_sdk/integrations/_wsgi_common.py`, `tests/integrations/flask/test_flask.py`
- Sentry functions/classes read: `FlaskIntegration.setup_once`, `_request_started`, `_set_transaction_name_and_source`, `FlaskRequestExtractor`, `_capture_exception`, `SentryWsgiMiddleware.__call__`
- Datadog Python, `DataDog/dd-trace-py@c3e1f08d9b39b2984827eea4249c3f0370579199`
- Datadog paths: `ddtrace/contrib/internal/flask/patch.py`, `ddtrace/contrib/internal/flask/wrappers.py`, `tests/contrib/flask`
- Datadog functions/classes read: `patch`, `_FlaskWSGIMiddleware`, `patched_wsgi_app`, `_collect_flask_routes`, `_walk_wsgi_mounts`, `patched_add_url_rule`, `wrap_view`, `_wrap_call`, `_wrap_call_with_tracing_check`
- OpenTelemetry Python Contrib, `open-telemetry/opentelemetry-python-contrib@6b55f8290d30ae4cbf04aef4ccf8fd9215d9f95e`
- OpenTelemetry path: `instrumentation/opentelemetry-instrumentation-flask/src/opentelemetry/instrumentation/flask/__init__.py`
- OpenTelemetry functions/classes read: `get_default_span_name`, `_rewrapped_app`, `_wrapped_before_request`, `_wrapped_teardown_request`, `_InstrumentedFlask`, `FlaskInstrumentor.instrument_app`
- PostHog Python, `PostHog/posthog-python@b4056cbe057085480027258645afe693e13fd15e`
- PostHog paths checked: `posthog/client.py` plus repository search for Flask instrumentation. No comparable source-level Flask trace middleware was found in that package.

## Competitor Patterns

Sentry combines Flask signals with a WSGI middleware wrapper. It can derive transaction names from endpoints and URL rules, continue traces through WSGI request extraction, and capture Flask exceptions with request context. This is mature and broad, but it patches `Flask.__call__`, which is less app-owned than explicit middleware registration.

Datadog uses a broad integration patch that wraps Flask WSGI app dispatch, request hooks, routes, views, templates, and errors. This creates rich automatic coverage, but the tradeoff is hidden global patching and more surface area for privacy and compatibility review.

OpenTelemetry's Flask instrumentation wraps the WSGI app and request lifecycle hooks, names spans from routes, exposes request/response hooks, and supports optional header capture/sanitization. It is portable and flexible, but users must reason about OTel provider/exporter setup and header capture policy.

PostHog's Python package did not expose a comparable Flask tracing middleware in the public source checked for this cycle.

## LogBrew Design

LogBrew adds `logbrew-flask` as a separate typed package rather than hiding Flask behavior in the core Python SDK. Apps call `add_logbrew_middleware(app, ...)`, which registers app-owned Flask hooks without monkeypatching `Flask.__call__` or patching Flask globally.

The integration captures one low-cardinality request span per captured response, one issue plus error span for Flask exceptions, optional `http.server.duration` metrics, active request trace access for handlers, and `LogBrewLoggingHandler` correlation under the active request span. Valid inbound W3C `traceparent` headers are continued with fresh child span ids; malformed propagation falls back without echoing raw header values.

Privacy defaults are stricter than the richer automatic competitors: no request bodies, response bodies, cookies, arbitrary headers, query strings, raw `traceparent`, baggage, or tracestate are captured. Dynamic route values are not emitted when Flask exposes a route template.

## Verification Added

- `python/logbrew_flask/tests/test_flask_integration.py`
- `scripts/check_flask_package.sh`
- `scripts/real_user_flask_smoke.sh`

The installed-artifact proofs build local `logbrew-sdk` and `logbrew-flask` wheels/sdists, install them into fresh virtual environments, run Flask test-client flows, prove log/span/issue correlation, validate trace/span IDs, validate typed consumer usage, and exercise packaged examples.

## Remaining Gap

LogBrew is still intentionally lighter than Sentry, Datadog, and OpenTelemetry for automatic Flask view/template/database/outbound instrumentation. The next Flask-related improvements should come from concrete user demand or source-backed proof that a narrower explicit helper can improve time-to-answer without adopting broad hidden patching.
