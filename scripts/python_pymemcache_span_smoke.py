from __future__ import annotations

import json
from typing import Any

from pymemcache.client.base import Client as PymemcacheClient

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    instrument_pymemcache_client_with_logbrew_spans,
    use_logbrew_trace,
)


class LocalPymemcache(PymemcacheClient):
    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), connect_timeout=0.01, timeout=0.01)
        self.active_span: str | None = None

    def get(self, *args: Any, **kwargs: Any) -> bytes:
        active = get_active_logbrew_trace()
        self.active_span = active.span_id if active is not None else None
        return b"cached-profile"

    def get_many(self, *args: Any, **kwargs: Any) -> dict[bytes, bytes]:
        active = get_active_logbrew_trace()
        self.active_span = active.span_id if active is not None else None
        return {b"private:user:42": b"cached-profile"}

    def set(self, *args: Any, **kwargs: Any) -> bool:
        active = get_active_logbrew_trace()
        self.active_span = active.span_id if active is not None else None
        return True


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-pymemcache",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
event_ids = iter(
    [
        "evt_python_pymemcache_get",
        "evt_python_pymemcache_get_many",
        "evt_python_pymemcache_set",
    ]
)
span_ids = iter(["b7ad6b7169203401", "b7ad6b7169203402", "b7ad6b7169203403"])
clock_values = iter([530.0, 530.006, 531.0, 531.009, 532.0, 532.004])
pymemcache_client = LocalPymemcache()
captured: dict[str, Any] = {}

with use_logbrew_trace(parent_trace):
    instrumentation = instrument_pymemcache_client_with_logbrew_spans(
        pymemcache_client,
        client=client,
        event_id_factory=lambda: next(event_ids),
        timestamp="2026-06-29T21:00:00Z",
        cache_name="profiles",
        span_id_factory=lambda: next(span_ids),
        clock=lambda: next(clock_values),
        metadata={
            "service": "checkout",
            "cacheKey": "private:user:42",
            "connection": "memcached://cache.example.invalid:11211",
        },
    )
    duplicate = instrument_pymemcache_client_with_logbrew_spans(pymemcache_client, client=client)
    captured["getResult"] = pymemcache_client.get(b"private:user:42", default=None)
    captured["getActiveSpan"] = pymemcache_client.active_span
    captured["manyResult"] = pymemcache_client.get_many([b"private:user:42", b"private:user:99"])
    captured["manyActiveSpan"] = pymemcache_client.active_span
    captured["setResult"] = pymemcache_client.set(b"private:user:42", b"sensitive-profile", expire=60, noreply=False)
    captured["setActiveSpan"] = pymemcache_client.active_span
    captured["duplicateSame"] = duplicate is instrumentation
    captured["parentSpanAfterCache"] = get_active_logbrew_trace().span_id

instrumentation.uninstall()
pymemcache_client.get(b"private:user:99")

serialized = client.preview_json()
for forbidden in (
    "private:user:42",
    "private:user:99",
    "sensitive-profile",
    "cacheKey",
    "cache.example.invalid",
    '"expire": 60',
    "noreply",
    "127.0.0.1",
):
    if forbidden in serialized:
        raise SystemExit(f"pymemcache span leaked private data: {forbidden}")

payload = json.loads(serialized)
events = payload["events"]
metadata = [event["attributes"]["metadata"] for event in events]

print(
    json.dumps(
        {
            "cacheName": metadata[0]["cacheName"],
            "duplicateSame": captured["duplicateSame"],
            "events": len(events),
            "framework": metadata[0]["framework"],
            "getActiveSpan": captured["getActiveSpan"],
            "getHit": metadata[0]["cacheHit"],
            "getItemSizeBytes": metadata[0]["itemSizeBytes"],
            "manyActiveSpan": captured["manyActiveSpan"],
            "manyHit": metadata[1]["cacheHit"],
            "manyItemCount": metadata[1]["itemCount"],
            "ok": True,
            "operations": [item["cacheOperation"] for item in metadata],
            "parentSpanAfterCache": captured["parentSpanAfterCache"],
            "setActiveSpan": captured["setActiveSpan"],
            "setKind": metadata[2]["cacheOperationKind"],
            "syncValuePresent": captured["getResult"] is not None and bool(captured["manyResult"]),
            "uninstallStoppedTracing": len(events) == 3,
        },
        sort_keys=True,
    )
)
