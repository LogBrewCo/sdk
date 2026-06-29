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

## 2026-06-29 SQLAlchemy Engine Refresh

Source refresh:

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `9c836062fc6f7244aae5046ce66814f0469c9891`; read `sentry_sdk/integrations/sqlalchemy.py`, especially `SqlalchemyIntegration.setup_once(...)`, `_before_cursor_execute(...)`, `_after_cursor_execute(...)`, `_handle_error(...)`, `_get_db_system(...)`, and `_set_db_data(...)`.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `ec27300a9433f5985cd7467ee840037e12602a70`; read `instrumentation/opentelemetry-instrumentation-sqlalchemy/src/opentelemetry/instrumentation/sqlalchemy/__init__.py` and `engine.py`, especially `SQLAlchemyInstrumentor._instrument(...)`, `_wrap_create_engine(...)`, `_wrap_create_async_engine(...)`, `_wrap_connect(...)`, and `EngineTracer.__init__(...)`.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `8f36ac8332c5eb789f20241e547c486f51ade9be`; read `ddtrace/contrib/internal/sqlalchemy/patch.py` and `engine.py`, especially `patch(...)`, `unpatch(...)`, `_wrap_create_engine(...)`, `trace_engine(...)`, `EngineTracer.attach(...)`, `_before_cur_exec(...)`, `_after_cur_exec(...)`, `_handle_db_error(...)`, `_set_tags_from_url(...)`, and `_set_tags_from_cursor(...)`.

Observed pattern:

- Sentry, Datadog, and OpenTelemetry all use SQLAlchemy event hooks around cursor execution and error handling; Datadog and OpenTelemetry also support broader global wrapping/patching of engine creation.
- Competitors are stronger for automatic coverage and richer DB semantic fields. They also accept heavier runtime behavior: global integration/patching, more dependencies, richer DB connection metadata, or agent/exporter assumptions.

LogBrew update:

- Added `instrument_sqlalchemy_engine_with_logbrew_spans(engine, ...)` as an optional, app-owned SQLAlchemy engine helper in the core Python SDK.
- The helper imports SQLAlchemy only when called, attaches listeners to exactly the passed engine, returns the existing instrumentation on duplicate calls, activates a child trace between `before_cursor_execute` and completion/error, emits one sanitized DB span, and removes listeners through `uninstall()`.
- Captured metadata stays intentionally smaller than competitors: primitive caller metadata with sensitive-key filtering, `framework=sqlalchemy`, `dbSystem`, `dbOperation`, optional caller-supplied `dbName`, optional non-negative `rowCount`, sampled state, and type-only exceptions. It does not capture SQL text, SQL parameters, connection URLs, hosts, usernames, result rows, baggage, tracestate, stack traces, or exception messages.

Remaining gap after this refresh:

- LogBrew is now more practical for real SQLAlchemy users without adding a dependency or patching globals, but Sentry/Datadog/OpenTelemetry still win for drop-in global instrumentation, DB-API coverage, metrics, query comments, semantic-convention breadth, baggage/tracestate, and fetch/connect pool spans.

## 2026-06-29 DB-API Connection Refresh

Source refresh:

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `a661615a40fa26450e4b4f50cec760733cc858d8`; read `sentry_sdk/tracing_utils.py` (`record_sql_queries(...)`, `_format_sql(...)`), `sentry_sdk/integrations/sqlalchemy.py` (`SqlalchemyIntegration.setup_once(...)`, `_before_cursor_execute(...)`, `_after_cursor_execute(...)`, `_handle_error(...)`, `_set_db_data(...)`), and `sentry_sdk/integrations/aiomysql.py` (`AioMySQLIntegration.setup_once(...)`, `_wrap_connect(...)`, `_wrap_execute(...)`, `_wrap_executemany(...)`).
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `ec27300a9433f5985cd7467ee840037e12602a70`; read `instrumentation/opentelemetry-instrumentation-dbapi/src/opentelemetry/instrumentation/dbapi/__init__.py`, especially `trace_integration(...)`, `wrap_connect(...)`, `instrument_connection(...)`, `uninstrument_connection(...)`, `DatabaseApiIntegration`, `TracedConnectionProxy.cursor(...)`, `CursorTracer.traced_execution(...)`, `CursorTracer.traced_execution_async(...)`, `get_operation_name(...)`, and `get_statement(...)`.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `8f36ac8332c5eb789f20241e547c486f51ade9be`; read `ddtrace/contrib/dbapi.py` (`TracedCursor`, `_trace_method(...)`, `execute(...)`, `executemany(...)`, `callproc(...)`, `FetchTracedCursor`, `TracedConnection.cursor(...)`, `commit(...)`, `rollback(...)`, `_get_vendor(...)`), `ddtrace/contrib/internal/sqlite3/patch.py` (`patch(...)`, `traced_connect(...)`, `TracedSQLiteCursor`, `TracedSQLite.execute(...)`), `ddtrace/contrib/internal/psycopg/connection.py` (`Psycopg3TracedConnection.execute(...)`, `Psycopg2TracedConnection`, `patch_conn(...)`, `patched_connect_factory(...)`), and `ddtrace/contrib/internal/psycopg/cursor.py` (`Psycopg3TracedCursor` and fetch variants).

Observed pattern:

- Sentry is strongest for polished framework-owned integration paths and can record query text/parameters when configured, but it relies on integration hooks or driver-specific wrappers rather than a tiny explicit DB-API wrapper in core.
- OpenTelemetry has the most standards-shaped DB-API design: module `connect` patching, direct connection instrumentation, cursor execute/executemany/callproc wrapping, SQL comment support, optional statement capture, connection attributes, metrics, and async execution paths.
- Datadog has broad DB-API coverage with wrapt proxies, driver-specific patches, row counts, optional fetch tracing, commit/rollback spans, and connection tags. It is stronger for automatic breadth, but heavier and more instrumentation-owned.

LogBrew update:

- Added `instrument_dbapi_connection_with_logbrew_spans(connection, ...)` plus `LogBrewDbapiConnection` and `LogBrewDbapiCursor` to the Python SDK.
- The helper wraps exactly one caller-owned DB-API connection, returns the same wrapper on duplicate calls, wraps cursors returned from `cursor()`, and supports cursor `execute`, `executemany`, `callproc`, plus common connection shortcut `execute` and `executemany`.
- LogBrew creates a child trace around each call, derives only the SQL verb or procedure label, records `framework=dbapi`, `dbMethod`, optional caller `dbName`, optional non-negative row count, sampled state, and type-only exceptions.
- It avoids competitor-heavy behavior in core: no module/class/connect patching, no driver dependency, no SQL text, no bind values, no result rows, no connection URLs, no network addresses, no user names, no baggage, no tracestate, no stack traces, and no exception messages. `uninstall()` disables future spans and returns the original connection.

Verification:

- Focused unit tests cover trace activation, duplicate wrapper reuse, cursor chaining preservation, row count capture, uninstall behavior, type-only errors, capture-failure isolation, and no SQL/bind/private-value leakage.
- `scripts/python_dbapi_span_smoke.py` uses real stdlib `sqlite3` against a local in-memory app flow and validates update/select/error spans plus uninstall behavior without external services.
- `scripts/real_user_python_smoke.sh` now checks `_dbapi_client.py` in wheel, sdist, and installed package metadata and runs the DB-API smoke through wheel install, wheel reinstall, freeze reinstall, direct requirement reinstall, sdist install, and sdist reinstall.

Remaining gap after this refresh:

- LogBrew is now more useful than the prior explicit-only helper for real DB-API users who want safe spans without hidden patching. Sentry, Datadog, and OpenTelemetry still win for automatic multi-driver DB-API patching, richer semantic conventions, statement-comment injection, fetch/connect/commit/rollback spans, metrics, baggage/tracestate, and broad integration-owned coverage.
