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

## Route-Template Naming Follow-Up - 2026-06-19

Fresh source refresh:

- Sentry Python SDK, [`getsentry/sentry-python`](https://github.com/getsentry/sentry-python/tree/883e585baf564ff650e2292b70262aef852adec0) at commit `883e585baf564ff650e2292b70262aef852adec0`.
- Sentry source paths/functions read:
  - `sentry_sdk/integrations/starlette.py`: `_transaction_name_from_router`, `_set_transaction_name_and_source`, `_get_transaction_from_middleware`.
  - `sentry_sdk/integrations/asgi.py`: `SentryAsgiMiddleware._get_transaction_name_and_source`.
  - `sentry_sdk/integrations/django/__init__.py`: `DjangoIntegration.__init__`, `_set_transaction_name_and_source`, `_attempt_resolve_again`.
  - `sentry_sdk/integrations/django/transactions.py`: resolver route normalization.
- Datadog `dd-trace-py`, [`DataDog/dd-trace-py`](https://github.com/DataDog/dd-trace-py/tree/187cfc3700200ec8f33d6f610280924ef17e1696) at commit `187cfc3700200ec8f33d6f610280924ef17e1696`.
- Datadog source paths/functions read:
  - `ddtrace/contrib/internal/asgi/middleware.py`: `TraceMiddleware.__call__`, request `resource` setup, 404 resource handling.
  - `ddtrace/contrib/internal/starlette/patch.py`: `_collect_routes_from_app`, `traced_route_init`, `traced_handler`.
  - `ddtrace/contrib/internal/fastapi/patch.py`: FastAPI middleware/route patching.
  - `ddtrace/contrib/internal/django/patch.py`: `_collect_django_routes`, `_collect_routes_once`, `traced_get_response`.
- OpenTelemetry Python Contrib, [`open-telemetry/opentelemetry-python-contrib`](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb) at commit `a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`.
- OpenTelemetry source paths/functions read:
  - `instrumentation/opentelemetry-instrumentation-fastapi/src/opentelemetry/instrumentation/fastapi/__init__.py`: `_get_route_details`, `_get_default_span_details`.
  - `instrumentation/opentelemetry-instrumentation-asgi/src/opentelemetry/instrumentation/asgi/__init__.py`: route/path format handling.
  - `instrumentation/opentelemetry-instrumentation-django/src/opentelemetry/instrumentation/django/middleware/otel_middleware.py`: `_get_span_name`, `process_response`.
  - `instrumentation/opentelemetry-instrumentation-flask/src/opentelemetry/instrumentation/flask/__init__.py`: `get_default_span_name`, `HTTP_ROUTE` handling.

Pattern update:

- Sentry Starlette/FastAPI defaults to URL-style transaction naming from route objects, and Django resolves URL patterns or view names instead of relying only on raw paths.
- Datadog ASGI starts with a method/path resource but its Starlette/FastAPI/Django integrations collect route trees so resources can be normalized by framework route.
- OpenTelemetry FastAPI/Django/Flask span names use `METHOD route-template` and attach `http.route`-style metadata where framework routing is known.

LogBrew follow-up:

- `logbrew-fastapi` request spans and exception titles now use `request_route_template(request)`, for example `GET /orders/{order_id}`.
- `logbrew-django` request spans and exception titles now use `request_route_template(request)`, for example `GET /orders/<int:order_id>/`.
- Span metadata now includes `routeTemplate`; concrete dynamic paths are omitted when a route template is available. Static routes still include `path` because the path and route template are identical.
- LogBrew stays lighter than competitor auto-instrumentation by using explicit app-installed middleware only, with no route-tree walking, framework patching, request body/header/cookie/query capture, baggage, or tracestate.

Verifier evidence:

- Focused TDD red failed because FastAPI/Django dynamic request spans still used concrete paths.
- Focused green: `PYTHONPATH=python/logbrew_py/src:python/logbrew_fastapi/src:python/logbrew_django/src python3 -m unittest python/logbrew_fastapi/tests/test_fastapi_integration.py python/logbrew_django/tests/test_django_integration.py` ran 16 tests in a temporary dependency venv.

## FastAPI/Django Request-to-Dependency Proof - 2026-07-07

### Sources Reused

- Sentry Python SDK source already read for this dependency-span gap: `getsentry/sentry-python@907dd48f1a118d75ddb2f2178e879bdc5fa71283` `sentry_sdk/integrations/sqlalchemy.py`, `sentry_sdk/integrations/aiomysql.py`, `sentry_sdk/integrations/rq.py`, `sentry_sdk/integrations/arq.py`, and `sentry_sdk/integrations/dramatiq.py`; plus `getsentry/sentry-python@883e585baf564ff650e2292b70262aef852adec0` `sentry_sdk/integrations/celery/__init__.py` and `sentry_sdk/integrations/rq.py`.
- Datadog `dd-trace-py` source already read: `DataDog/dd-trace-py@90d3cc64f59ff10213396b37bf83c49a260afab8` `ddtrace/contrib/dbapi.py`, SQLAlchemy patch/engine paths, and RQ/Celery integration paths; later refreshes for DB-API, cache, and Celery/RQ behavior are recorded in the database/cache/queue research notes.
- OpenTelemetry Python Contrib source already read: `open-telemetry/opentelemetry-python-contrib@a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb` DB-API, SQLAlchemy, and Celery instrumentation paths, plus FastAPI/Django/ASGI framework tracing paths from this note.
- PostHog Python source was previously searched for comparable general dependency tracing and did not provide a matching FastAPI/Django DB/cache/queue trace integration in the checked paths.

### Pattern and Tradeoff

- Sentry, Datadog, and OpenTelemetry are stronger for automatic framework-to-dependency composition: a FastAPI/Django request span remains active while DB, cache, queue, and outbound integrations create child spans.
- That breadth is useful for time-to-answer, but the mature competitor path often relies on framework/driver patching, richer semantic capture, broker/header propagation, or heavier runtime dependencies.
- LogBrew's current public SDK path stays explicit and app-owned: the framework integration owns only the request span and active context; DB/cache/queue helpers wrap the specific operation the app chooses.

### LogBrew Change

- Added packaged `python -m logbrew_fastapi.examples dependency-spans` and `python -m logbrew_django.examples dependency-spans`.
- Each example runs a local framework test client, accepts an incoming W3C `traceparent`, then creates SQLite, in-memory cache, and in-memory queue child spans under the active framework request span.
- The installed examples assert deterministic parent/child span IDs for the request, database, cache, and queue spans. They do not capture SQL values, cache keys/values, queue bodies, headers, full URLs, raw propagation metadata, baggage, or tracestate.

### Verification

- RED before implementation: `bash scripts/check_fastapi_package.sh` and `bash scripts/check_django_package.sh` failed because the packaged `dependency-spans` example and sdist files were absent.
- GREEN package proof: `bash scripts/check_fastapi_package.sh` and `bash scripts/check_django_package.sh` build local wheels/sdists, install them into fresh virtual environments, run package metadata/type/unit checks, and execute the dependency examples from installed packages.

### Remaining Gap

- Sentry, Datadog, and OpenTelemetry still lead on automatic FastAPI/Django DB/cache/queue breadth, driver/framework patching, richer DB/cache/queue semantics, baggage/tracestate, request phase timings, and hosted trace UI. LogBrew is now clearer and safer for explicit request-to-dependency composition from installed artifacts, but it is not yet zero-touch dependency instrumentation.
