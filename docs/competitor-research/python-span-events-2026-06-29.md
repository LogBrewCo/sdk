# Python Span Event Summaries - 2026-06-29

## Goal

Improve Python trace detail where LogBrew was weaker than Sentry, Datadog, and OpenTelemetry: rich span timelines and exception context on dependency spans. Keep the default Python SDK explicit, dependency-free, and safer than broad automatic instrumentation.

## Sources Read

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `0290953ae399ddf95ea3625ab8b3d8f0d7360035`.
- Sentry files/functions: `sentry_sdk/tracing.py` (`Span.set_data`, `Span.set_status`, `Span.to_json`), `sentry_sdk/integrations/otlp.py` (`setup_capture_exceptions`, `_sentry_patched_record_exception`), `sentry_sdk/integrations/sqlalchemy.py` (`_handle_error`), and `sentry_sdk/integrations/celery/__init__.py` (`_capture_exception`, publish/run patch paths from previous queue research).
- OpenTelemetry Python: `https://github.com/open-telemetry/opentelemetry-python.git` at `50912be81bbc715ee040c9d8eb2f70b3d662ae26`.
- OpenTelemetry files/functions: `opentelemetry-api/src/opentelemetry/trace/span.py` (`Span.add_event`, `Span.record_exception`) and `opentelemetry-sdk/src/opentelemetry/sdk/trace/__init__.py` (`Span.add_event`, `Span.record_exception`, `Span.__exit__`).
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `ec27300a9433f5985cd7467ee840037e12602a70`.
- OpenTelemetry Contrib files/functions: `instrumentation/opentelemetry-instrumentation-fastapi/src/opentelemetry/instrumentation/fastapi/__init__.py` (`span.record_exception`, `span.set_status`), `instrumentation/opentelemetry-instrumentation-aiohttp-server/src/opentelemetry/instrumentation/aiohttp_server/__init__.py` (`span.record_exception`), `instrumentation/opentelemetry-instrumentation-celery/src/opentelemetry/instrumentation/celery/__init__.py` (`_trace_failure`, `span.record_exception`), and `instrumentation/opentelemetry-instrumentation-sqlalchemy/src/opentelemetry/instrumentation/sqlalchemy/engine.py` (`_handle_error`).
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `e7cc6b69897f42a07a3e28f4a492f19dd6699c89`.
- Datadog files/functions: `ddtrace/_trace/span.py` (`Span.set_exc_info`, `Span.record_exception`, `_validate_attribute`) and `ddtrace/internal/opentelemetry/span.py` (`Span.add_event`, `Span.record_exception`, `Span.__exit__`).

## Competitor Pattern

- OpenTelemetry exposes first-class span events and exception recording. The SDK stores bounded event collections and automatically records exceptions for context-manager spans when configured.
- OpenTelemetry contrib integrations record exceptions on framework and queue spans, then set error status.
- Datadog records exception events and validates event attributes, but its native `set_exc_info` path also stores error messages and stack traces.
- Sentry Python focuses more on span data/status and error events, and its OTLP integration can capture exceptions recorded through OpenTelemetry.

## LogBrew Implementation

- Added `SpanEventSummary` and `SpanAttributes.events` to the Python core payload contract.
- Added validation for up to eight event summaries per span. Each event requires `name`, may include a timezone-aware `timestamp`, and keeps only primitive metadata.
- Added `span_events` to explicit database, cache, queue, RQ, and Celery helpers.
- Dependency helpers add one automatic `exception` event on failures with only `exceptionType` and `exceptionEscaped=true`.
- DB/cache/queue helper event metadata is additionally filtered through existing privacy deny-lists, so query params, cache keys, message bodies, headers, args, kwargs, payloads, and similar fields are dropped before capture.

## Tradeoffs

- Better than competitors for privacy-first explicit instrumentation: no hidden patching, no new dependency, no local-agent assumption, no exception message or stack in span events, and clear event-count limits.
- Worse than Sentry/Datadog/OpenTelemetry for automatic event capture, full OpenTelemetry event arrays, links, baggage/tracestate, automatic framework exception hooks, and broad version-specific instrumentation.
- This is the safe core step. Optional framework-owned packages can later add heavier automatic behavior where users explicitly choose it.

## Verification

- Red test first: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_sdk.py python/logbrew_py/tests/test_database_client.py python/logbrew_py/tests/test_cache_client.py python/logbrew_py/tests/test_queue_client.py` failed because spans ignored `events`, helpers rejected `span_events`, and failure spans had no exception event.
- Green focused tests: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_sdk.py python/logbrew_py/tests/test_database_client.py python/logbrew_py/tests/test_cache_client.py python/logbrew_py/tests/test_queue_client.py python/logbrew_py/tests/test_rq_client.py python/logbrew_py/tests/test_celery_client.py` ran 47 tests.
- Source smoke proof: `PYTHONPATH=python/logbrew_py/src python3 scripts/python_database_span_smoke.py`, `python_cache_span_smoke.py`, and `python_queue_span_smoke.py` prove milestone span events, automatic type-only exception events, active trace correlation, capture-failure isolation, and no private value leakage.

## Remaining Gaps

- Python still lacks automatic SQLAlchemy/DB-API/Redis/Celery/RQ instrumentation packages.
- Python still avoids full OpenTelemetry event arrays, links, baggage, tracestate, exception messages/stacks, request phase timings, and semantic-convention depth.
- Next high-impact Python work should target optional framework-owned automatic instrumentation only when installed-artifact and privacy proof justify the extra coupling.
