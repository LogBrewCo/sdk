# Python Database Span Research - 2026-06-19

## Goal

Reduce the Python server-side database span gap after outbound HTTP helpers shipped for `urllib.request`, `requests`, and `httpx`. Sentry, Datadog, and OpenTelemetry are stronger for automatic database instrumentation; LogBrew needs a lighter explicit helper that real Python apps can use without global patching or driver dependencies.

## Sources Read

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `907dd48f1a118d75ddb2f2178e879bdc5fa71283`.
- Sentry files/functions: `sentry_sdk/integrations/sqlalchemy.py`; `SqlalchemyIntegration`, `_before_cursor_execute(...)`, `_after_cursor_execute(...)`, `_handle_error(...)`. Also `sentry_sdk/integrations/aiomysql.py`; `_wrap_execute(...)`, `_wrap_executemany(...)`.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`.
- OpenTelemetry files/functions: `instrumentation/opentelemetry-instrumentation-dbapi/src/opentelemetry/instrumentation/dbapi/__init__.py`; `wrap_connect(...)`, `instrument_connection(...)`, `DatabaseApiIntegration`, `CursorTracer._populate_span(...)`, `CursorTracer.traced_execution(...)`, `CursorTracer.traced_execution_async(...)`. Also `instrumentation/opentelemetry-instrumentation-sqlalchemy/src/opentelemetry/instrumentation/sqlalchemy/__init__.py` and `engine.py`; `SQLAlchemyInstrumentor`, `EngineTracer`, `_before_cur_exec(...)`, `_after_cur_exec(...)`, `_handle_error(...)`.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `90d3cc64f59ff10213396b37bf83c49a260afab8`.
- Datadog files/functions: `ddtrace/contrib/dbapi.py`; `TracedCursor`, `TracedCursor._trace_method(...)`, `execute(...)`, `executemany(...)`, `TracedConnection.cursor(...)`. Also `ddtrace/contrib/internal/sqlalchemy/patch.py` and `engine.py`; `patch(...)`, `trace_engine(...)`, `EngineTracer._before_cur_exec(...)`, `_after_cur_exec(...)`, `_handle_db_error(...)`.

## Targeted Competitor Smokes

These were focused behavior checks, not full upstream test suites.

- Sentry installed-package smoke: `sentry-sdk` plus SQLAlchemy and SQLite produced one transaction with a DB span through `SqlalchemyIntegration`, using `before_send_transaction` and no real hosted intake.
- OpenTelemetry installed-package smoke: `opentelemetry-instrumentation-sqlalchemy` plus SDK in-memory exporter produced DB spans for SQLite; observed span names included `connect` and `select :memory:` with `db.system=sqlite`.
- Datadog installed-package smoke: `ddtrace` exposed `trace_engine(...)`, mutated the SQLAlchemy engine in place, and executed SQLite successfully. Without a configured writer it attempted to send one trace to the default local Datadog agent at `http://localhost:8126`, showing the heavier default runtime assumption LogBrew should avoid in core.

## Competitor Patterns

- Sentry attaches SQLAlchemy event listeners for `before_cursor_execute`, `after_cursor_execute`, and error handling. It can capture SQL query information, DB system/name/server fields, and span status with little app code once the integration is installed.
- OpenTelemetry wraps DB-API connections/cursors and SQLAlchemy engine events. It derives operation names from SQL, sets semantic DB attributes, supports sync and async execution, and can record metrics. This is standards-rich but dependency-heavy and instrumentation-owned.
- Datadog wraps DB-API cursors/connections and SQLAlchemy engine events, traces execute/executemany/fetch paths, and can route spans to its local agent by default. This wins broad coverage but has a heavier runtime model than a dependency-light LogBrew core should copy.

## LogBrew Implementation

- Added `database_operation_with_logbrew_span(...)` and `async_database_operation_with_logbrew_span(...)` to `logbrew-sdk` Python.
- The helpers are explicit and dependency-free by default: apps pass a callable around the important DB operation instead of LogBrew patching SQLAlchemy, DB-API drivers, cursors, connections, or event listeners.
- LogBrew creates a child `LogBrewTraceContext`, activates it while the sync or async operation runs, queues one span named from `system` and `operation_name`, returns the original result, and re-raises the original exception.
- Metadata is privacy-bounded: primitive caller metadata, `source=database`, `dbSystem`, `dbOperation`, optional `dbName`, optional `statementTemplate`, optional non-negative `rowCount`, sampled flag, and exception type. It avoids SQL parameters, result rows, connection strings, network addresses, sensitive configuration values, raw SQL values, baggage, tracestate, stack traces, and exception messages.
- A shared `_instrumentation.py` module now holds generic child-trace, metadata compaction, timestamp, and duration helpers so DB and HTTP span helpers do not depend on each other.

## Tradeoffs

- Better than Sentry/Datadog/OpenTelemetry for teams that need a small explicit helper with no database dependency, no hidden global patching, no local-agent assumption, and obvious privacy boundaries.
- Worse than Sentry/Datadog/OpenTelemetry for teams that expect drop-in SQLAlchemy/DB-API instrumentation across all queries, automatic query operation naming, DB semantic conventions, query comments, DB duration metrics, or fetch-span coverage.
- The next safe improvement is optional framework-owned DB integration packages or examples after the core explicit helper is proven, not hidden SQLAlchemy/DB-API patching in `logbrew-sdk`.

## Verification

- Red test first: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_database_client.py` failed because `async_database_operation_with_logbrew_span` was not exported.
- Green focused tests: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_database_client.py python/logbrew_py/tests/test_http_client.py`.
- Full Python core tests: `PYTHONPATH=python/logbrew_py/src python3 -m unittest discover -s python/logbrew_py/tests -p 'test_*.py'` ran 53 tests.
- Static proof: `bash scripts/check_python_static.sh` passed with Ruff `0.15.15` and mypy `2.1.0`.
- Installed-artifact proof is wired in `scripts/real_user_python_smoke.sh`: wheel, reinstall, freeze/direct reinstall, sdist, and sdist reinstall run `database_span_smoke.py` and check sync/async DB span correlation, row counts, error type only, capture-failure reporting, and no parameter/private-value leakage.

## Remaining Gaps

- Python still lacks optional SQLAlchemy/DB-API integration packages for teams that want automatic coverage.
- Cache and queue spans are still thinner than Sentry/Datadog/OpenTelemetry.
- LogBrew now supports bounded span event summaries and type-only exception events for explicit DB spans, but still avoids baggage, tracestate, full OpenTelemetry event arrays/links, DB semantic conventions beyond the current safe metadata subset, and automatic query/fetch spans.
