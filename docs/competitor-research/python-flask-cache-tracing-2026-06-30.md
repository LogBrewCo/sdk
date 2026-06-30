# Python Flask-Caching Trace Gap

## Scope

Reduce the Python Flask cache tracing gap for apps that already use
Flask-Caching and want dependency spans without global patching or cache key
capture.

## Competitor Source Read

- Sentry Python `getsentry/sentry-python@291739faa48285f2634b5c0935e8f45bf365164e`
  - `sentry_sdk/integrations/flask.py`: `FlaskIntegration`, request signal
    hooks, WSGI transaction naming, and request event extraction.
  - `sentry_sdk/integrations/django/caching.py`: `METHODS_TO_INSTRUMENT`,
    `_patch_cache_method(...)`, `_patch_cache(...)`, `patch_caching(...)`,
    cache hit/item-size attributes, and backend address handling.
  - `sentry_sdk/integrations/redis/_sync_common.py`: `patch_redis_client(...)`
    and `patch_redis_pipeline(...)` for command and pipeline spans.
  - `sentry_sdk/integrations/redis/modules/caches.py`:
    `_compile_cache_span_properties(...)` and `_set_cache_data(...)`.
- Datadog dd-trace-py
  `DataDog/dd-trace-py@a819241caed620a180db9e2c6793079ba13527ec`
  - `ddtrace/contrib/internal/flask_cache/patch.py`:
    `get_traced_cache(...)`, nested `TracedCache`, traced `get`, `set`, `add`,
    `delete`, `delete_many`, `clear`, `get_many`, and `set_many`.
  - `ddtrace/contrib/internal/flask_cache/utils.py`:
    `_resource_from_cache_prefix(...)`, `_extract_client(...)`, and
    `_extract_conn_tags(...)`.
- OpenTelemetry Python Contrib
  `open-telemetry/opentelemetry-python-contrib@ec27300a9433f5985cd7467ee840037e12602a70`
  - `instrumentation/opentelemetry-instrumentation-flask`: Flask server-span
    instrumentation, route naming, hooks, and request/response attributes.
  - `instrumentation/opentelemetry-instrumentation-redis`: Redis sync/async
    client and pipeline instrumentation, hooks, and semantic DB/cache
    attributes.
  - `instrumentation/opentelemetry-instrumentation-pymemcache`: pymemcache
    command wrapping and connection attributes.
- PostHog Python
  `PostHog/posthog-python@e20e22937b6ffebd073931d5e359b68efd6718e5`
  - No comparable Flask-Caching trace instrumentation was found in the public
    source search; PostHog is focused on product events, flags, exceptions, and
    AI tracing helpers.

## Pattern Observed

- Sentry is strong on Flask request transactions plus Django/Redis cache spans,
  but no first-class Flask-Caching source path was found at this commit.
- Datadog has the closest direct Flask-Caching solution: subclass the
  Flask-Caching `Cache`, override common cache methods, derive span resource
  names from the operation and cache prefix, record hit/row-count metadata, and
  optionally attach backend connection tags.
- OpenTelemetry is broader for standards-based Flask request spans and
  Redis/pymemcache client spans, but no dedicated Flask-Caching wrapper was
  found in the scoped source read.

## LogBrew Implementation

LogBrew adds `instrument_flask_cache_with_logbrew_spans(...)` and
`LogBrewFlaskCacheInstrumentation`.

Apps pass one app-owned Flask-Caching style `Cache` object. LogBrew wraps only
that object, returns the existing instrumentation on duplicate calls, and
puts the original methods back with `uninstall()`.

Supported methods are `get`, `get_many`, `set`, `set_many`, `add`, `delete`,
`delete_many`, and `clear`.

Captured metadata is limited to primitive caller metadata,
`framework=flask-caching`, `cacheSystem=flask-caching`, cache operation/kind,
optional caller cache name, hit state, item count/size, sampled state, and
exception type. It avoids cache keys, values, timeout arguments, key prefixes,
backend locations, hosts, ports, arbitrary command text, response payloads,
baggage, tracestate, stack traces, exception messages, global Flask-Caching
patching, subclass replacement, and default Flask/Flask-Caching dependencies.

## Verification

- RED: `PYTHONPATH=python/logbrew_py/src python3 -m unittest
  python/logbrew_py/tests/test_flask_cache_client.py` initially failed because
  `instrument_flask_cache_with_logbrew_spans` was not exported.
- GREEN focused unit tests: same command passed with 4 tests.
- Real framework smoke: a temp venv installed `Flask-Caching>=2,<3` and ran
  `scripts/python_flask_cache_span_smoke.py`, proving real `Flask` +
  `Flask-Caching` object wrapping, duplicate install reuse, set/get/get_many/
  delete_many spans, active child trace correlation, privacy checks, and
  uninstall behavior.

## Honest Comparison

- Better for privacy and adoption: LogBrew does not replace the cache class,
  does not install Flask-Caching by default, and does not capture keys, values,
  key prefixes, backend addresses, or exception messages.
- Worse than Datadog for automatic depth: LogBrew does not offer drop-in
  subclass replacement, backend connection tags, or fleet-wide Flask-Caching
  auto instrumentation.
- Worse than Sentry/OpenTelemetry in broader ecosystem depth: LogBrew still
  has less hidden automatic coverage and fewer semantic conventions across
  all Flask, Redis, and memcached paths.
- Next useful gap: Flask request middleware/route-template depth and optional
  automatic Flask-Caching integration package only if installed-artifact proof
  can preserve the same privacy boundaries.
