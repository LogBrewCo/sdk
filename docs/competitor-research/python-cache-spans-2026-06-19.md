# Python Cache Span Research - 2026-06-19

## Goal

Reduce the Python cache span gap after explicit outbound HTTP and database span helpers shipped. Sentry, Datadog, and OpenTelemetry are stronger for Redis, Django cache, Flask cache, and memcached auto-instrumentation; LogBrew needs a lighter explicit helper that gives real apps useful cache spans without hidden patching or cache-client dependencies.

## Sources Read

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `907dd48f1a118d75ddb2f2178e879bdc5fa71283`.
- Sentry files/functions: `sentry_sdk/integrations/redis/redis.py`; `_patch_redis(...)`, `_get_redis_command_args(...)`. Also `sentry_sdk/integrations/django/caching.py`; `_patch_cache_method(...)`, `_patch_cache(...)`, `_get_address_port(...)`, `patch_caching(...)`; and `sentry_sdk/integrations/redis/modules/caches.py`; `_compile_cache_span_properties(...)`, `_get_cache_span_description(...)`, `_set_cache_data(...)`.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`.
- OpenTelemetry files/functions: `instrumentation/opentelemetry-instrumentation-redis/src/opentelemetry/instrumentation/redis/__init__.py`; `_traced_execute_factory(...)`, `_traced_execute_pipeline_factory(...)`, `_async_traced_execute_factory(...)`, `_async_traced_execute_pipeline_factory(...)`, `_instrument(...)`. Also `instrumentation/opentelemetry-instrumentation-pymemcache/src/opentelemetry/instrumentation/pymemcache/__init__.py`; `_wrap_cmd(...)`, `_get_query_string(...)`, `_get_address_attributes(...)`, `PymemcacheInstrumentor`.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `90d3cc64f59ff10213396b37bf83c49a260afab8`.
- Datadog files/functions: `ddtrace/contrib/internal/redis/patch.py`; `patch(...)`, `instrumented_execute_command(...)`, `instrumented_execute_pipeline(...)`, `_run_redis_command(...)`. Also `ddtrace/contrib/internal/redis_utils.py`; `determine_row_count(...)`, `_extract_conn_tags(...)`, `_build_tags(...)`, `_instrument_redis_cmd(...)`, `_instrument_redis_execute_pipeline(...)`; `ddtrace/contrib/internal/pymemcache/patch.py`; `patch(...)`; and `ddtrace/contrib/internal/flask_cache/patch.py`; `get_traced_cache(...)`, `TracedCache.get/set/add/delete/get_many/set_many(...)`.

## Targeted Competitor Smokes

These were focused behavior checks, not full upstream test suites.

- Sentry installed-package smoke: `sentry-sdk`, `redis`, and `fakeredis` produced one transaction with two `db.redis` spans for local `SET` and `GET`, using `before_send_transaction` and no real hosted intake.
- OpenTelemetry installed-package smoke: `opentelemetry-instrumentation-redis`, SDK in-memory exporter, `redis`, and `fakeredis` produced `SET` and `GET` spans with `db.system=redis`.
- Datadog installed-package smoke: `ddtrace.patch(redis=True)` executed against `fakeredis` without app changes, then attempted default local-agent delivery to `http://localhost:8126`, confirming the heavier runtime assumption LogBrew should avoid in core.

## Competitor Patterns

- Sentry patches Redis clients and pipelines, and can patch Django cache methods. It records cache get/put semantics, hit state, item size, cache keys, network peer fields, and Redis command spans with little app code.
- OpenTelemetry wraps Redis sync/async clients and pipelines plus pymemcache client methods. It names spans from cache commands, records DB/cache semantic attributes, supports request/response hooks, and covers pipeline length.
- Datadog patches Redis sync/async clients, cluster/pipeline paths, pymemcache constructors, and Flask cache methods. It derives row counts for row-returning Redis commands, records command/resource data, and assumes Datadog tracer delivery semantics by default.

## LogBrew Implementation

- Added `cache_operation_with_logbrew_span(...)` and `async_cache_operation_with_logbrew_span(...)` to `logbrew-sdk` Python.
- The helpers are explicit and dependency-free by default: apps pass a callable around the important cache operation instead of LogBrew patching Redis, memcached, Django cache, Flask cache, clients, constructors, pipelines, or event hooks.
- LogBrew creates a child `LogBrewTraceContext`, activates it while the sync or async operation runs, queues one span named from `system` and `operation_name`, returns the original result, and re-raises the original exception.
- Metadata is privacy-bounded: primitive caller metadata after dropping key-like fields, `source=cache`, `cacheSystem`, `cacheOperation`, optional `cacheName`, optional hit state, optional non-negative item size/count, sampled flag, and exception type. It avoids cache keys, values, commands, payloads, headers, cookies, network addresses, baggage, tracestate, stack traces, and exception messages.

## Tradeoffs

- Better than Sentry/Datadog/OpenTelemetry for teams that need a small explicit helper with no cache dependency, no hidden global patching, no local-agent assumption, and cache-key privacy by default.
- Worse than Sentry/Datadog/OpenTelemetry for teams that expect drop-in Redis/Django/Flask/memcached coverage, automatic pipeline spans, command parsing, row counts from command responses, network peer fields, or semantic-convention-rich cache telemetry.
- The next safe improvement is optional framework-owned Redis/Django cache examples or integration packages, not hidden cache-client patching in `logbrew-sdk`.

## Verification

- Red test first: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_cache_client.py` failed because `async_cache_operation_with_logbrew_span` was not exported.
- Green focused tests: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_cache_client.py python/logbrew_py/tests/test_database_client.py python/logbrew_py/tests/test_http_client.py` ran 9 tests.
- Source smoke proof: `PYTHONPATH=python/logbrew_py/src python3 scripts/python_cache_span_smoke.py` proved sync/async cache span correlation, hit/size/count metadata, exception type only, capture-failure isolation, and no private key leakage.
- Installed-artifact proof is wired in `scripts/real_user_python_smoke.sh`: wheel, reinstall, freeze/direct reinstall, sdist, and sdist reinstall run `python_cache_span_smoke.py` and check sync/async cache spans from installed packages.

## Remaining Gaps

- Python still lacks optional Redis/Django cache/Flask cache/memcached integration packages for teams that want automatic coverage.
- Queue spans are still thinner than Sentry/Datadog/OpenTelemetry.
- LogBrew now supports bounded span event summaries and type-only exception events for explicit cache spans, but still avoids baggage, tracestate, full OpenTelemetry event arrays/links, cache command parsing, pipeline spans, network peer fields, and automatic cache-client patching.
