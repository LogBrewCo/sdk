from __future__ import annotations

import json

from flask import Flask
from flask_caching import Cache

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    instrument_flask_cache_with_logbrew_spans,
    use_logbrew_trace,
)


app = Flask(__name__)
app.config.update(
    CACHE_DEFAULT_TIMEOUT=60,
    CACHE_KEY_PREFIX="checkout:",
    CACHE_TYPE="SimpleCache",
)
flask_cache = Cache(app)
flask_cache.clear()

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-flask-cache",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
event_ids = iter(
    [
        "evt_python_flask_cache_set",
        "evt_python_flask_cache_get",
        "evt_python_flask_cache_get_many",
        "evt_python_flask_cache_delete_many",
    ]
)
span_ids = iter(["b7ad6b7169203411", "b7ad6b7169203412", "b7ad6b7169203413", "b7ad6b7169203414"])
clock_values = iter([700.0, 700.004, 701.0, 701.006, 702.0, 702.007, 703.0, 703.002])

instrumentation = instrument_flask_cache_with_logbrew_spans(
    flask_cache,
    client=client,
    event_id_factory=lambda: next(event_ids),
    timestamp="2026-06-30T12:00:00Z",
    cache_name="profiles",
    span_id_factory=lambda: next(span_ids),
    clock=lambda: next(clock_values),
    metadata={
        "service": "checkout",
        "cacheKey": "private:user:42",
        "connection": "redis://cache.example.invalid:6379/0",
    },
)
duplicate = instrument_flask_cache_with_logbrew_spans(flask_cache, client=client)

with use_logbrew_trace(parent_trace):
    flask_cache.set("private:user:42", "sensitive-profile", timeout=60)
    get_result = flask_cache.get("private:user:42")
    many_result = flask_cache.get_many("private:user:42", "private:user:99")
    delete_many_result = flask_cache.delete_many("private:user:42", "private:user:99")

instrumentation.uninstall()
flask_cache.get("private:user:42")

serialized = client.preview_json()
for forbidden in (
    "private:user:42",
    "private:user:99",
    "sensitive-profile",
    '"cacheKey"',
    "cache.example.invalid",
    '"timeout": 60',
    "checkout:",
):
    if forbidden in serialized:
        raise SystemExit(f"flask cache span leaked private data: {forbidden}")

payload = json.loads(serialized)
metadata = [event["attributes"]["metadata"] for event in payload["events"]]
print(
    json.dumps(
        {
            "cacheName": metadata[1]["cacheName"],
            "deleteManyCount": metadata[3]["itemCount"],
            "deleteManyResult": delete_many_result,
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
            "syncValuePresent": get_result is not None and many_result[0] is not None,
            "uninstallStoppedTracing": len(payload["events"]) == 4,
        },
        sort_keys=True,
    )
)
