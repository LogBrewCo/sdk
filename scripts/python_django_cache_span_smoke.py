from __future__ import annotations

import json

from django.conf import settings

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    instrument_django_cache_with_logbrew_spans,
    use_logbrew_trace,
)


if not settings.configured:
    settings.configure(
        CACHES={
            "default": {
                "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                "LOCATION": "logbrew-django-cache-smoke",
            }
        },
        DEFAULT_AUTO_FIELD="django.db.models.AutoField",
        INSTALLED_APPS=[],
        USE_TZ=True,
    )

import django  # noqa: E402
from django.core.cache import caches  # noqa: E402


django.setup()

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-django-cache",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
django_cache = caches["default"]
django_cache.clear()
event_ids = iter(
    [
        "evt_python_django_cache_set",
        "evt_python_django_cache_get",
        "evt_python_django_cache_get_many",
    ]
)
span_ids = iter(["b7ad6b7169203391", "b7ad6b7169203392", "b7ad6b7169203393"])
clock_values = iter([500.0, 500.004, 501.0, 501.006, 502.0, 502.007])

instrumentation = instrument_django_cache_with_logbrew_spans(
    django_cache,
    client=client,
    event_id_factory=lambda: next(event_ids),
    timestamp="2026-06-29T19:00:00Z",
    cache_name="profiles",
    span_id_factory=lambda: next(span_ids),
    clock=lambda: next(clock_values),
    metadata={
        "service": "checkout",
        "cacheKey": "private:user:42",
        "connection": "memcached://cache.example.invalid:11211",
    },
)
duplicate = instrument_django_cache_with_logbrew_spans(django_cache, client=client)

with use_logbrew_trace(parent_trace):
    django_cache.set("private:user:42", "sensitive-profile", timeout=60)
    get_result = django_cache.get("private:user:42", default=None, version=None)
    many_result = django_cache.get_many(["private:user:42", "private:user:99"], version=None)

instrumentation.uninstall()
django_cache.get("private:user:42")

serialized = client.preview_json()
for forbidden in (
    "private:user:42",
    "private:user:99",
    "sensitive-profile",
    '"cacheKey"',
    "cache.example.invalid",
    '"timeout": 60',
):
    if forbidden in serialized:
        raise SystemExit(f"django cache span leaked private data: {forbidden}")

payload = json.loads(serialized)
metadata = [event["attributes"]["metadata"] for event in payload["events"]]
print(
    json.dumps(
        {
            "cacheName": metadata[1]["cacheName"],
            "duplicateSame": duplicate is instrumentation,
            "events": len(payload["events"]),
            "framework": metadata[0]["framework"],
            "getHit": metadata[1]["cacheHit"],
            "getItemSizeBytes": metadata[1]["itemSizeBytes"],
            "manyHit": metadata[2]["cacheHit"],
            "manyItemCount": metadata[2]["itemCount"],
            "ok": True,
            "operations": [item["cacheOperation"] for item in metadata],
            "parentSpanAfterCache": parent_trace.span_id,
            "setKind": metadata[0]["cacheOperationKind"],
            "syncValuePresent": get_result is not None,
            "uninstallStoppedTracing": len(payload["events"]) == 3,
        },
        sort_keys=True,
    )
)
