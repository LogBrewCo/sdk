# Python Trace Correlation Research - 2026-06-16

## Scope

Improve LogBrew Python, FastAPI, and Django tracing where competitors are stronger: active request context, trace-log-error correlation, route-level span names, exception correlation, and privacy-safe metadata.

## Competitor Source Read

- Sentry Python SDK, [`getsentry/sentry-python`](https://github.com/getsentry/sentry-python/tree/1df9835e485a346f670ca5615106536a20212795) at commit `1df9835e485a346f670ca5615106536a20212795`.
- Sentry source paths/functions read:
  - `sentry_sdk/integrations/fastapi.py`: `_set_transaction_name_and_source`, `_wrap_async_handler`, `patch_get_request_handler`.
  - `sentry_sdk/integrations/asgi.py`: `SentryAsgiMiddleware._run_app`, `_get_transaction_name_and_source`.
  - `sentry_sdk/integrations/django/__init__.py`: `_set_transaction_name_and_source`, `_before_get_response`.
- OpenTelemetry Python contrib, [`open-telemetry/opentelemetry-python-contrib`](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/97017a46805e34faf5c181b895e002f9e0cefab5) at commit `97017a46805e34faf5c181b895e002f9e0cefab5`.
- OpenTelemetry source paths/functions read:
  - `instrumentation/opentelemetry-instrumentation-fastapi/src/opentelemetry/instrumentation/fastapi/__init__.py`: `ExceptionHandlerMiddleware`, `_get_route_details`, `_get_default_span_details`, FastAPI middleware wrapping around `OpenTelemetryMiddleware`.
  - `instrumentation/opentelemetry-instrumentation-asgi/src/opentelemetry/instrumentation/asgi/__init__.py`: `OpenTelemetryMiddleware`, ASGI carrier/getter helpers, request/response hook flow.
  - `instrumentation/opentelemetry-instrumentation-django/src/opentelemetry/instrumentation/django/__init__.py`: request/response hook guidance, middleware-context notes, SQL commenter trace propagation notes.
- Datadog `dd-trace-py`, [`DataDog/dd-trace-py`](https://github.com/DataDog/dd-trace-py/tree/96412c9279099fe5338b7104b06e65f50cac29d1) at commit `96412c9279099fe5338b7104b06e65f50cac29d1`.
- Datadog source paths/functions read:
  - `ddtrace/contrib/internal/logging/patch.py`: `DDLogRecord`, `_w_makeRecord`, `_w_StrFormatStyle_format`.
  - `ddtrace/_trace/tracer.py`: `Tracer.get_log_correlation_context`.
  - `ddtrace/contrib/internal/asgi/middleware.py`: `span_from_scope`, `TraceMiddleware.__call__`.
  - `ddtrace/contrib/internal/django/utils.py`: `_before_request_tags`, `_after_request_tags`.

## What Competitors Do Better

- Sentry keeps framework request context active while handler code runs, derives transaction names from framework route information, and attaches request/error information inside framework-specific wrappers.
- OpenTelemetry's FastAPI integration explicitly wraps middleware stacks so exceptions can still be recorded against the active span, and it derives low-cardinality route span names from framework routing instead of raw URLs.
- Datadog injects active trace/span IDs into Python `logging` records, making app logs correlate with active traces without requiring every call site to pass IDs manually.

## LogBrew Adaptation

- Added a lightweight `LogBrewTraceContext` in `logbrew-sdk`, with active context ownership isolated in `logbrew_sdk/_trace_context.py` and backed by Python `contextvars`. Public helpers include `create_logbrew_trace_context()`, `get_active_logbrew_trace()`, `use_logbrew_trace()`, `trace_metadata()`, and `span_attributes_from_trace_context()`.
- `LogBrewLoggingHandler` now adds active `traceId`, `spanId`, `parentSpanId`, and `sampled` metadata to standard-library logs emitted inside an active LogBrew trace context.
- `logbrew-fastapi` now creates one request-local trace context per request, exposes it through `get_active_logbrew_trace()` during handler work, stores it on `request.state.logbrew_trace`, reuses the same span id for the request span, and adds the same IDs to captured exception issues.
- `logbrew-django` now mirrors the same behavior with request `META["logbrew.trace"]`, active `contextvars`, request-span reuse, and exception issue correlation.
- Missing or malformed inbound `traceparent` starts a fresh W3C-shaped local trace instead of leaking the raw header or breaking the app.

## Tradeoffs

- We kept LogBrew lighter than Sentry/OTel/Datadog by not monkey-patching framework internals, not globally patching logging, and not creating receive/send/database/template spans by default.
- Framework integrations still preserve app-owned logging configuration: logs only become LogBrew events when the user installs `LogBrewLoggingHandler`.
- Privacy defaults remain stricter than common competitor defaults: no request bodies, response bodies, headers, cookies, query strings, or raw `traceparent` values are captured.
- Python tracing is still behind full Sentry/OTel depth for auto child spans, DB spans, rich span events, baggage, and existing OpenTelemetry context ingestion.

## Verification

- `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_sdk.py`
- `bash scripts/real_user_fastapi_smoke.sh` passed with `fastapi@0.137.1`.
- `bash scripts/real_user_django_smoke.sh` passed with `django@6.0.6`.
- `bash scripts/check_fastapi_package.sh`
- `bash scripts/check_django_package.sh`
- `bash scripts/check_python_static.sh`
- `python3 scripts/check_python_sources.py python/logbrew_py python/logbrew_fastapi python/logbrew_django`
- `bash scripts/check_shell_static.sh`
- `python3 scripts/check_markdown_links.py`
