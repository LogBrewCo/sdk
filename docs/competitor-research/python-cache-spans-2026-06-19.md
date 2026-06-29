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

## 2026-06-29 Redis Client Refresh

### Fresh Sources Read

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `a661615a40fa26450e4b4f50cec760733cc858d8`.
- Sentry files/functions: `sentry_sdk/integrations/redis/__init__.py` `RedisIntegration.setup_once`, `sentry_sdk/integrations/redis/_sync_common.py` `patch_redis_client`, `patch_redis_pipeline`, `sentry_sdk/integrations/redis/_async_common.py` `patch_redis_async_client`, `patch_redis_async_pipeline`, `sentry_sdk/integrations/redis/redis.py` `_patch_redis`, `sentry_sdk/integrations/redis/modules/caches.py` `_compile_cache_span_properties`, `_set_cache_data`, `sentry_sdk/integrations/redis/modules/queries.py` `_compile_db_span_properties`, `_set_db_data`, and `sentry_sdk/integrations/redis/utils.py` `_get_safe_command`, `_set_client_data`, `_set_pipeline_data`.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `ec27300a9433f5985cd7467ee840037e12602a70`.
- OpenTelemetry files/functions: `instrumentation/opentelemetry-instrumentation-redis/src/opentelemetry/instrumentation/redis/__init__.py` `_traced_execute_factory`, `_traced_execute_pipeline_factory`, `_async_traced_execute_factory`, `_async_traced_execute_pipeline_factory`, `_instrument`, and `instrument_client`; `util.py` `_format_command_args`, `_set_connection_attributes`, `_build_span_name`, `_build_span_meta_data_for_pipeline`; `README.rst`.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `8f36ac8332c5eb789f20241e547c486f51ade9be`.
- Datadog files/functions: `ddtrace/contrib/internal/redis/patch.py` `patch`, `unpatch`, `instrumented_execute_command`, `instrumented_execute_pipeline`, `_run_redis_command`; `ddtrace/contrib/internal/redis/asyncio_patch.py` `instrumented_async_execute_command`, `instrumented_async_execute_pipeline`; `ddtrace/contrib/internal/redis_utils.py` `determine_row_count`, `_instrument_redis_cmd`, `_instrument_redis_execute_pipeline`, `_run_redis_command_async`; `ddtrace/ext/redis.py`.

### Updated Pattern

Sentry, OpenTelemetry, and Datadog all treat Redis as a first-class trace source. Their strongest user-facing advantage is breadth: class-level sync and async Redis wrapping, pipeline spans, cluster support, command span names, connection attributes, hooks, row counts, and cache-hit or item-size metadata. The tradeoff is heavier runtime coupling to Redis client internals and a larger privacy surface because command text, keys, connection details, or response-derived data can appear unless sanitized or configured carefully.

### LogBrew Follow-Up

LogBrew now adds `instrument_redis_client_with_logbrew_spans(...)` for one caller-owned Redis-like client. It wraps only that instance's `execute_command`, returns the existing instrumentation on duplicate calls, supports sync and async results, activates a child trace during command execution, records command name plus read/write/delete kind, derives cache hit/count/byte-size only from safe result shapes, preserves original result/error behavior, and reinstates the original method with `uninstall()`.

The helper stays intentionally smaller than the competitor defaults: no `redis` dependency in `logbrew-sdk`, no global class patching, no pipeline or cluster internals, no command arguments, no keys or values, no connection URL/host/port/user capture, no arbitrary command text, no response payloads, no baggage/tracestate, no stack traces, and no exception messages.

### Verification

- RED: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_redis_client.py` failed because `instrument_redis_client_with_logbrew_spans` was not exported.
- GREEN focused tests: the same command runs four Redis instrumentation tests covering sync and async clients, duplicate install, uninstall, hit/count/size metadata, type-only error spans, capture-failure isolation, and private key/value redaction.
- Installed-artifact proof is wired into `scripts/real_user_python_smoke.sh` through `scripts/python_redis_span_smoke.py`. The smoke installs real `redis>=5,<7`, uses local subclassed sync and async Redis clients, exercises `get`, `mget`, and failing `set` paths without a live Redis server, and runs across wheel, reinstall, freeze/direct reinstall, sdist, and sdist reinstall paths.

### Remaining Gaps

LogBrew remains weaker than Sentry, Datadog, and OpenTelemetry for automatic Redis class instrumentation, pipeline spans, cluster coverage, Django/Flask cache hooks, memcached client wrapping, command filtering/obfuscation modes, connection metrics, broader semantic conventions, baggage/tracestate, and full OTel processor/exporter interop. The next safe step would be an optional framework-owned Redis/Django cache package only if installed-artifact proof and privacy defaults remain as clear as the one-client helper.

## 2026-06-29 Redis Pipeline Refresh

Source refresh:

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `707464306ca78d4928e4668ba4d383948f7eb7fb`; read `sentry_sdk/integrations/redis/_sync_common.py` `patch_redis_pipeline(...)`, `sentry_sdk/integrations/redis/_async_common.py` `patch_redis_async_pipeline(...)`, `sentry_sdk/integrations/redis/utils.py` `_set_pipeline_data(...)`, and `sentry_sdk/integrations/redis/redis.py` `_patch_redis(...)`. Sentry patches Redis pipeline classes, starts `redis.pipeline.execute`, and records transaction/cluster booleans plus a capped safe command summary.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `ec27300a9433f5985cd7467ee840037e12602a70`; read `opentelemetry-instrumentation-redis` `_traced_execute_pipeline_factory(...)`, `_async_traced_execute_pipeline_factory(...)`, and `util.py` `_build_span_meta_data_for_pipeline(...)`. OTel wraps sync and async pipeline execute paths, derives span names/resources from the command stack, and records `db.redis.pipeline_length`.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `6091865277beba3afd0275954950456b79151d90`; read `ddtrace/contrib/internal/redis/patch.py` `instrumented_execute_pipeline(...)`, `ddtrace/contrib/internal/redis/asyncio_patch.py` `instrumented_async_execute_pipeline(...)`, and `ddtrace/contrib/internal/redis_utils.py` `_instrument_redis_execute_pipeline(...)`. Datadog wraps Redis pipeline classes and emits a `redis.execute_pipeline` span from a joined command summary.

Design pattern and tradeoff:

- Competitors treat Redis pipelines as one span around `execute()` rather than one span per queued command. They get useful batch timing and command counts, but rely on class patching and command-stack internals.
- The safer LogBrew shape is opt-in instance-owned pipeline wrapping: only pipelines returned by the caller's instrumented client are wrapped, and only primitive operation labels are recorded.

LogBrew update:

- Added `trace_pipelines=True` to `instrument_redis_client_with_logbrew_spans(...)`.
- When enabled, LogBrew wraps the app-owned client's `pipeline()` method, instruments each returned pipeline object's `execute()` method once, and emits one `redis PIPELINE` child span.
- Pipeline spans include `framework=redis-py`, `cacheOperation=PIPELINE`, `cacheOperationKind=command`, optional caller `cacheName`, `pipelineLength`, and capped comma-separated operation names such as `GET,SET`.
- They avoid global Redis class/module patching, cluster internals, pipeline keys, values, command arguments, pipeline execute arguments, response payloads, connection URLs, hosts, ports, usernames, baggage, tracestate, stacks, and exception messages.

Verification:

- Focused tests prove `trace_pipelines=True` preserves app-owned `pipeline()` arguments, activates a child trace during pipeline `execute()`, captures one sanitized pipeline span, keeps command keys/values and execute kwargs out of payloads, and `uninstall()` stops future pipeline spans.
- `scripts/python_redis_span_smoke.py` now proves a real installed-artifact app shape with `redis>=5,<7`, sync command spans, opt-in sync pipeline spans, async command spans, error spans, capture-failure isolation, duplicate instrumentation reuse, and local privacy checks.

Remaining gap after this refresh:

- LogBrew now covers app-owned Redis command and opt-in pipeline execution spans. Sentry, Datadog, and OpenTelemetry still win for automatic Redis class instrumentation, cluster pipeline coverage, Django/Flask cache hooks, memcached wrapping, command filtering/obfuscation modes, connection metrics, broader semantic conventions, baggage/tracestate, and full OTel processor/exporter interop.

## 2026-06-29 Django Cache Refresh

Source refresh:

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `707464306ca78d4928e4668ba4d383948f7eb7fb`; read `sentry_sdk/integrations/django/caching.py` `METHODS_TO_INSTRUMENT`, `_patch_cache_method(...)`, `_patch_cache(...)`, `_get_address_port(...)`, `should_enable_cache_spans()`, and `patch_caching()`. Sentry patches Django `CacheHandler` creation/access and then wraps `set`, `set_many`, `get`, and `get_many`, deriving hit state, item size, cache key, and sanitized peer address/port.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `93e7e6d6ccf5e101f70c1ab8d1fef1b150573f2a`; read `ddtrace/contrib/internal/flask_cache/patch.py` `get_traced_cache(...)` and `TracedCache.get/set/add/delete/delete_many/clear/get_many/set_many(...)`, plus `ddtrace/contrib/internal/pymemcache/patch.py` `patch(...)`/`unpatch(...)` and `client.py` `WrappedClient`, `WrappedHashClient`, `_trace(...)`, `_get_query_string(...)`, `_get_address_tags(...)`. Datadog wraps Flask cache classes and pymemcache classes, records cache backend, contact points, command keys when enabled, and row counts.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `ec27300a9433f5985cd7467ee840037e12602a70`; read `instrumentation/opentelemetry-instrumentation-pymemcache/src/opentelemetry/instrumentation/pymemcache/__init__.py` `COMMANDS`, `_wrap_cmd(...)`, `_get_query_string(...)`, `_get_address_attributes(...)`, and `PymemcacheInstrumentor._instrument(...)`/`_uninstrument(...)`. OTel globally wraps pymemcache client methods, names spans from cache commands, and records DB statement plus peer attributes.

Design pattern and tradeoff:

- Competitors win on drop-in cache breadth: Django/Flask cache hooks, pymemcache wrapping, backend/peer details, key/resource labels, and row counts. The tradeoff is global patching, framework/client dependency coupling, and a wider privacy surface around keys, backend locations, command text, or connection details.
- The safer LogBrew shape is one app-owned Django-style cache object wrapper: no Django import at default install time, no `CacheHandler` or class patching, no settings reads, no backend location capture, and no cache key/value serialization.

LogBrew update:

- Added `instrument_django_cache_with_logbrew_spans(...)` and `LogBrewDjangoCacheInstrumentation`.
- Apps pass an owned Django cache object such as `django.core.cache.cache` or `caches["default"]`; LogBrew wraps only supported methods on that object and puts the original methods back with `uninstall()`.
- Supported methods are `get`, `get_many`, `set`, `set_many`, `add`, `delete`, `delete_many`, and `clear`.
- Spans include `framework=django-cache`, `cacheSystem=django-cache`, `cacheOperation`, `cacheOperationKind`, optional caller `cacheName`, hit state for reads, item counts/sizes where safely knowable, sampled state, and type-only errors.
- The helper avoids default Django dependency, global Django patching, settings access, cache keys, values, timeout/version kwargs, backend locations, hosts, ports, arbitrary command text, response payloads, baggage, tracestate, stacks, and exception messages.

Verification:

- RED: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_django_cache_client.py` failed because `instrument_django_cache_with_logbrew_spans` was not exported.
- GREEN focused tests prove app-owned cache method args/results are preserved, child trace context is active during calls, duplicate install returns the existing instrumentation, `uninstall()` stops future spans, type-only errors are queued, capture failures do not interrupt cache calls, and private keys/values/backend locations/timeout/version kwargs stay out of payloads.
- Installed-artifact proof is wired into `scripts/real_user_python_smoke.sh` through `scripts/python_django_cache_span_smoke.py`, which installs real Django, configures a local in-memory cache, exercises `set`, `get`, and `get_many`, and proves no private key/value/backend leakage.

Remaining gap after this refresh:

- LogBrew now covers app-owned Django cache objects plus app-owned Redis commands and pipeline execution. Sentry, Datadog, and OpenTelemetry still win for hidden automatic Django/Flask/pymemcache patching, Redis cluster spans, command filtering/obfuscation modes, connection metrics, broader semantic conventions, baggage/tracestate, and full OTel processor/exporter interop.

## 2026-06-29 Pymemcache Refresh

Source refresh:

- Sentry Python SDK: `https://github.com/getsentry/sentry-python.git` at `707464306ca78d4928e4668ba4d383948f7eb7fb`; searched `sentry_sdk` for `pymemcache`, `memcache`, `flask_cache`, and `cache`, then read `sentry_sdk/integrations/django/caching.py` `METHODS_TO_INSTRUMENT`, `_patch_cache_method(...)`, `_patch_cache(...)`, `_get_address_port(...)`, `should_enable_cache_spans()`, and `patch_caching()`. Sentry covers Django cache spans and Redis cache behavior, but no first-class pymemcache integration was found in the current Python SDK tree.
- Datadog dd-trace-py: `https://github.com/DataDog/dd-trace-py.git` at `d7dea02e7de2aadac569fde01e12569fe1f06fa6`; read `ddtrace/contrib/internal/pymemcache/patch.py` `patch(...)`, `unpatch(...)`, `get_version()`, `_supported_versions`, and `ddtrace/contrib/internal/pymemcache/client.py` `WrappedClient`, `WrappedHashClient`, `_get_address_tags(...)`, `_get_query_string(...)`, `_trace(...)`, and method wrappers for `set`, `set_many`, `set_multi`, `add`, `replace`, `append`, `prepend`, `cas`, `get`, `get_many`, `get_multi`, `gets`, `gets_many`, `delete`, `delete_many`, `incr`, `decr`, `touch`, `stats`, `version`, `flush_all`, and `quit`. Datadog patches pymemcache classes globally and records service/component/system/span-kind metadata, optional command text/keys, peer tags, and row counts for reads.
- OpenTelemetry Python Contrib: `https://github.com/open-telemetry/opentelemetry-python-contrib.git` at `ec27300a9433f5985cd7467ee840037e12602a70`; read `instrumentation/opentelemetry-instrumentation-pymemcache/src/opentelemetry/instrumentation/pymemcache/__init__.py` `COMMANDS`, `_set_connection_attributes(...)`, `_with_tracer_wrapper(...)`, `_wrap_cmd(...)`, `_get_query_string(...)`, `_get_address_attributes(...)`, and `PymemcacheInstrumentor._instrument(...)`/`_uninstrument(...)`. OTel wraps `pymemcache.client.base.Client` methods globally and records `db.system=memcached`, peer attributes, and command text.

Design pattern and tradeoff:

- Datadog and OpenTelemetry are stronger for drop-in memcached breadth because one integration can cover many pymemcache calls without per-object app code. The tradeoff is global/client-class patching, deeper coupling to pymemcache internals, and a larger privacy surface around command text, keys, and network peer fields.
- Sentry's current Python source does not appear to ship a dedicated pymemcache integration, but its Django cache integration shows the same broad auto-patching pattern for framework caches.
- The safer LogBrew shape is one app-owned pymemcache-style client wrapper: no default `pymemcache` dependency, no class/module patching, no network peer capture, and no cache key/value/argument serialization.

LogBrew update:

- Added `instrument_pymemcache_client_with_logbrew_spans(...)` and `LogBrewPymemcacheInstrumentation`.
- Apps provide one owned pymemcache-style client; LogBrew wraps supported methods on that object only and puts the original methods back with `uninstall()`.
- Supported methods are `set`, `set_many`, `set_multi`, `add`, `replace`, `append`, `prepend`, `cas`, `get`, `get_many`, `get_multi`, `gets`, `gets_many`, `delete`, `delete_many`, `incr`, `decr`, `touch`, `stats`, `version`, `flush_all`, and `quit`.
- Spans include `framework=pymemcache`, `cacheSystem=memcached`, `cacheOperation`, `cacheOperationKind`, optional caller `cacheName`, hit state for reads, item counts/sizes where safely knowable, sampled state, and type-only errors.
- The helper avoids default pymemcache dependency, global pymemcache patching, cache keys, values, expiration/noreply arguments, backend locations, hosts, ports, arbitrary command text, response payloads, baggage, tracestate, stacks, and exception messages.

Verification:

- RED: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_pymemcache_client.py` failed because `instrument_pymemcache_client_with_logbrew_spans` was not exported.
- GREEN focused tests prove app-owned method args/results are preserved, child trace context is active during calls, duplicate install returns the existing instrumentation, positional `get(key, default)` and `gets(key, default, cas_default)` misses stay misses, nested batch calls do not double trace, `uninstall()` stops future spans, type-only errors are queued, capture failures do not interrupt cache calls, and private keys/values/connection details/expire kwargs stay out of payloads.
- Installed-artifact proof is wired into `scripts/real_user_python_smoke.sh` through `scripts/python_pymemcache_span_smoke.py`, which installs real `pymemcache>=4,<5`, uses a local no-network subclass, exercises `get`, `gets`, `get_many`, and `set`, and checks payload privacy plus trace correlation across wheel, reinstall, freeze/direct reinstall, sdist, and sdist reinstall paths.

Remaining gap after this refresh:

- LogBrew now covers app-owned pymemcache clients, app-owned Django cache objects, app-owned Redis commands, and opt-in Redis pipeline execution. Datadog and OpenTelemetry still win for hidden automatic pymemcache class instrumentation, peer metadata, command filtering/obfuscation modes, richer semantic conventions, baggage/tracestate, and full OTel processor/exporter interop. Sentry still wins for broader automatic Django cache coverage but does not appear to beat LogBrew on dedicated pymemcache coverage from the current Python SDK source.
