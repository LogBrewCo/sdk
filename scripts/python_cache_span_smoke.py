from __future__ import annotations

import asyncio
import json

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    async_cache_operation_with_logbrew_span,
    cache_operation_with_logbrew_span,
    get_active_logbrew_trace,
    use_logbrew_trace,
)


class StubCacheError(RuntimeError):
    pass


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-cache",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
captured: dict[str, object] = {}


def cache_get_operation() -> bytes:
    active = get_active_logbrew_trace()
    captured["activeSpan"] = active.span_id if active is not None else None
    return b"cached-profile"


async def async_cache_set_operation() -> dict[str, str]:
    active = get_active_logbrew_trace()
    captured["asyncActiveSpan"] = active.span_id if active is not None else None
    return {"status": "stored"}


with use_logbrew_trace(parent_trace):
    value = cache_operation_with_logbrew_span(
        "GET profile",
        client=client,
        event_id="evt_python_cache_get",
        timestamp="2026-06-19T11:15:00Z",
        operation=cache_get_operation,
        system="redis",
        cache_name="profiles",
        cache_hit=True,
        item_size_bytes=14,
        item_count=1,
        span_id_factory=lambda: "b7ad6b7169203351",
        clock=iter([200.0, 200.009]).__next__,
        metadata={"service": "checkout", "cacheKey": "private:user:42"},
        span_events=[
            {
                "name": "cache.lookup",
                "metadata": {
                    "cacheTier": "primary",
                    "rawKey": "private:user:42",
                },
            }
        ],
    )

with use_logbrew_trace(parent_trace):
    async_value = asyncio.run(
        async_cache_operation_with_logbrew_span(
            "SET profile",
            client=client,
            event_id="evt_python_cache_async_set",
            timestamp="2026-06-19T11:15:01Z",
            operation=async_cache_set_operation,
            system="memcached",
            cache_name="profiles",
            cache_hit=False,
            item_size_bytes=64,
            span_id_factory=lambda: "b7ad6b7169203352",
            clock=iter([210.0, 210.017]).__next__,
            metadata={"service": "checkout", "keys": ["private:user:42"]},
        )
    )

try:
    cache_operation_with_logbrew_span(
        "SET profile",
        client=client,
        event_id="evt_python_cache_error",
        timestamp="2026-06-19T11:15:02Z",
        operation=lambda: (_ for _ in ()).throw(StubCacheError("private:user:42 unavailable")),
        system="redis",
        cache_name="profiles",
        span_id_factory=lambda: "b7ad6b7169203353",
        clock=iter([220.0, 220.004]).__next__,
    )
except StubCacheError:
    pass

closed_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-cache",
    sdk_version="0.1.0",
)
closed_client.closed = True
capture_errors: list[str] = []
cache_operation_with_logbrew_span(
    "GET health",
    client=closed_client,
    event_id="evt_python_cache_capture_failure",
    timestamp="2026-06-19T11:15:03Z",
    operation=lambda: "ok",
    system="memory",
    span_id_factory=lambda: "b7ad6b7169203354",
    on_capture_error=lambda error: capture_errors.append(str(error)),
)

serialized = client.preview_json()
for forbidden in ("private:user:42", '"cacheKey"', '"keys"', '"rawKey"', "unavailable"):
    if forbidden in serialized:
        raise SystemExit(f"cache span leaked private data: {forbidden}")

payload = json.loads(serialized)
sync_metadata = payload["events"][0]["attributes"]["metadata"]
async_metadata = payload["events"][1]["attributes"]["metadata"]
error_metadata = payload["events"][2]["attributes"]["metadata"]
sync_events = payload["events"][0]["attributes"]["events"]
error_events = payload["events"][2]["attributes"]["events"]

if sync_events != [{"name": "cache.lookup", "metadata": {"cacheTier": "primary"}}]:
    raise SystemExit(f"cache span event summary mismatch: {sync_events}")
if error_events != [
    {
        "name": "exception",
        "metadata": {
            "exceptionEscaped": True,
            "exceptionType": "StubCacheError",
        },
    }
]:
    raise SystemExit(f"cache exception event summary mismatch: {error_events}")

print(
    json.dumps(
        {
            "activeSpan": captured["activeSpan"],
            "asyncActiveSpan": captured["asyncActiveSpan"],
            "asyncCacheSystem": async_metadata["cacheSystem"],
            "asyncItemSizeBytes": async_metadata["itemSizeBytes"],
            "asyncStored": async_value["status"],
            "cacheHit": sync_metadata["cacheHit"],
            "cacheSystem": sync_metadata["cacheSystem"],
            "captureErrors": len(capture_errors),
            "errorType": error_metadata["errorType"],
            "events": len(payload["events"]),
            "itemCount": sync_metadata["itemCount"],
            "itemSizeBytes": sync_metadata["itemSizeBytes"],
            "ok": True,
            "spanEvents": len(sync_events),
            "syncBytes": len(value),
        },
        sort_keys=True,
    )
)
