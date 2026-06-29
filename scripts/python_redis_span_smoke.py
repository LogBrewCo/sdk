from __future__ import annotations

import asyncio
import json
from typing import Any

import redis
import redis.asyncio as async_redis

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    instrument_redis_client_with_logbrew_spans,
    use_logbrew_trace,
)


class LocalRedis(redis.Redis):
    def __init__(self, result: Any) -> None:
        super().__init__(host="127.0.0.1", port=0, db=0)
        self.result = result
        self.active_span: str | None = None
        self.pipeline_instance: LocalRedisPipeline | None = None

    def execute_command(self, *args: Any, **kwargs: Any) -> Any:
        active = get_active_logbrew_trace()
        self.active_span = active.span_id if active is not None else None
        return self.result

    def pipeline(self, *args: Any, **kwargs: Any) -> "LocalRedisPipeline":
        self.pipeline_instance = LocalRedisPipeline([b"cached-profile", True])
        return self.pipeline_instance


class LocalRedisPipeline:
    def __init__(self, result: Any) -> None:
        self.result = result
        self.active_span: str | None = None
        self.command_stack: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def get(self, key: str) -> "LocalRedisPipeline":
        self.command_stack.append((("GET", key), {}))
        return self

    def set(self, key: str, value: str) -> "LocalRedisPipeline":
        self.command_stack.append((("SET", key, value), {}))
        return self

    def execute(self) -> Any:
        active = get_active_logbrew_trace()
        self.active_span = active.span_id if active is not None else None
        return self.result


class LocalAsyncRedis(async_redis.Redis):
    def __init__(self, result: Any) -> None:
        super().__init__(host="127.0.0.1", port=0, db=0)
        self.result = result
        self.active_span: str | None = None

    async def execute_command(self, *args: Any, **kwargs: Any) -> Any:
        await asyncio.sleep(0)
        active = get_active_logbrew_trace()
        self.active_span = active.span_id if active is not None else None
        return self.result


class StubRedisError(RuntimeError):
    pass


class FailingRedis(redis.Redis):
    def __init__(self) -> None:
        super().__init__(host="127.0.0.1", port=0, db=0)

    def execute_command(self, *args: Any, **kwargs: Any) -> Any:
        raise StubRedisError("sensitive:user:42 unavailable")


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-redis",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
event_ids = iter(
    [
        "evt_python_redis_get",
        "evt_python_redis_pipeline",
        "evt_python_redis_mget",
        "evt_python_redis_error",
    ]
)
span_ids = iter(
    [
        "b7ad6b7169203381",
        "b7ad6b7169203385",
        "b7ad6b7169203382",
        "b7ad6b7169203383",
    ]
)
clock_values = iter([300.0, 300.011, 305.0, 305.017, 310.0, 310.013, 320.0, 320.004])

sync_redis = LocalRedis(b"cached-profile")
async_redis_client = LocalAsyncRedis([b"one", None, b"", b"three"])
failing_redis = FailingRedis()
captured: dict[str, Any] = {}

with use_logbrew_trace(parent_trace):
    instrumentation = instrument_redis_client_with_logbrew_spans(
        sync_redis,
        client=client,
        event_id_factory=lambda: next(event_ids),
        timestamp="2026-06-29T12:00:00Z",
        cache_name="profiles",
        trace_pipelines=True,
        span_id_factory=lambda: next(span_ids),
        clock=lambda: next(clock_values),
        metadata={
            "service": "checkout",
            "cacheKey": "sensitive:user:42",
            "connection": "redis://cache.example.invalid:6379/0",
        },
    )
    duplicate = instrument_redis_client_with_logbrew_spans(sync_redis, client=client)
    captured["syncResult"] = sync_redis.get("sensitive:user:42")
    captured["syncActiveSpan"] = sync_redis.active_span
    captured["duplicateSame"] = duplicate is instrumentation
    pipeline = sync_redis.pipeline(transaction=True)
    captured["pipelineResult"] = pipeline.get("sensitive:user:42").set("sensitive:user:42", "sensitive-profile").execute()
    captured["pipelineActiveSpan"] = pipeline.active_span

    async def run_async_redis() -> None:
        instrument_redis_client_with_logbrew_spans(
            async_redis_client,
            client=client,
            event_id_factory=lambda: next(event_ids),
            timestamp="2026-06-29T12:00:01Z",
            cache_name="profiles",
            span_id_factory=lambda: next(span_ids),
            clock=lambda: next(clock_values),
        )
        captured["asyncResult"] = await async_redis_client.mget("sensitive:one", "sensitive:two")
        captured["asyncActiveSpan"] = async_redis_client.active_span

    asyncio.run(run_async_redis())

    instrument_redis_client_with_logbrew_spans(
        failing_redis,
        client=client,
        event_id_factory=lambda: next(event_ids),
        timestamp="2026-06-29T12:00:02Z",
        span_id_factory=lambda: next(span_ids),
        clock=lambda: next(clock_values),
    )
    try:
        failing_redis.set("sensitive:user:42", "sensitive-profile")
    except StubRedisError as error:
        captured["errorType"] = type(error).__name__

    captured["parentSpanAfterRedis"] = get_active_logbrew_trace().span_id

closed_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-redis",
    sdk_version="0.1.0",
)
closed_client.closed = True
capture_errors: list[str] = []
closed_redis = LocalRedis("ok")
instrument_redis_client_with_logbrew_spans(
    closed_redis,
    client=closed_client,
    event_id_factory=lambda: "evt_python_redis_capture_failure",
    span_id_factory=lambda: "b7ad6b7169203384",
    on_capture_error=lambda error: capture_errors.append(str(error)),
)
closed_redis.ping()

instrumentation.uninstall()
sync_redis.get("sensitive:user:99")

serialized = client.preview_json()
for forbidden in (
    "sensitive:user:42",
    "sensitive:one",
    "sensitive-profile",
    "cacheKey",
    "unavailable",
    "127.0.0.1",
    "cache.example.invalid",
    "connection",
):
    if forbidden in serialized:
        raise SystemExit(f"Redis span leaked private data: {forbidden}")

payload = json.loads(serialized)
events = payload["events"]
metadata = [event["attributes"]["metadata"] for event in events]
statuses = [event["attributes"]["status"] for event in events]

print(
    json.dumps(
        {
            "asyncActiveSpan": captured["asyncActiveSpan"],
            "asyncCacheHit": metadata[2]["cacheHit"],
            "asyncItemCount": metadata[2]["itemCount"],
            "cacheHit": metadata[0]["cacheHit"],
            "captureErrors": len(capture_errors),
            "cacheOperationKind": metadata[0]["cacheOperationKind"],
            "duplicateSame": captured["duplicateSame"],
            "errorStatus": statuses[-1],
            "errorType": metadata[-1]["errorType"],
            "events": len(events),
            "framework": metadata[0]["framework"],
            "itemCount": metadata[0]["itemCount"],
            "itemSizeBytes": metadata[0]["itemSizeBytes"],
            "ok": True,
            "operations": [item["cacheOperation"] for item in metadata],
            "parentSpanAfterRedis": captured["parentSpanAfterRedis"],
            "pipelineActiveSpan": captured["pipelineActiveSpan"],
            "pipelineLength": metadata[1]["pipelineLength"],
            "pipelineOperations": metadata[1]["pipelineOperations"],
            "pipelineResultCount": len(captured["pipelineResult"]),
            "syncActiveSpan": captured["syncActiveSpan"],
            "syncResult": captured["syncResult"].decode("utf-8"),
        },
        sort_keys=True,
    )
)
