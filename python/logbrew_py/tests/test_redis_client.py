from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    instrument_redis_client_with_logbrew_spans,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class StubRedisClient:
    def __init__(self, result: Any = b"cached-profile") -> None:
        self.result = result
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.active_trace: LogBrewTraceContext | None = None
        self.connection_pool = object()
        self.pipeline_instance: StubRedisPipeline | None = None

    def execute_command(self, *args: Any, **kwargs: Any) -> Any:
        self.calls.append((args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return self.result

    def pipeline(self, *args: Any, **kwargs: Any) -> StubRedisPipeline:
        self.calls.append((("PIPELINE", *args), kwargs))
        self.pipeline_instance = StubRedisPipeline(result=[b"cached-profile", True])
        return self.pipeline_instance


class StubRedisPipeline:
    def __init__(self, result: Any) -> None:
        self.result = result
        self.command_stack: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.execute_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.active_trace: LogBrewTraceContext | None = None

    def get(self, key: str) -> StubRedisPipeline:
        self.command_stack.append((("GET", key), {}))
        return self

    def set(self, key: str, value: str) -> StubRedisPipeline:
        self.command_stack.append((("SET", key, value), {}))
        return self

    def execute(self, *args: Any, **kwargs: Any) -> Any:
        self.execute_calls.append((args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return self.result


class AsyncStubRedisClient:
    def __init__(self, result: Any = None) -> None:
        self.result = [b"one", None, b"", b"three"] if result is None else result
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.active_trace: LogBrewTraceContext | None = None

    async def execute_command(self, *args: Any, **kwargs: Any) -> Any:
        await asyncio.sleep(0)
        self.calls.append((args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return self.result


class RedisClientInstrumentationTests(unittest.TestCase):
    def test_redis_client_instrumentation_queues_privacy_bounded_span_and_uninstalls(self) -> None:
        logbrew_client = sample_client()
        redis_client = StubRedisClient()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([300.0, 300.011])

        with use_logbrew_trace(parent_trace):
            instrumentation = instrument_redis_client_with_logbrew_spans(
                redis_client,
                client=logbrew_client,
                event_id_factory=lambda: "evt_python_redis_get",
                timestamp="2026-06-29T12:00:00Z",
                cache_name="profiles",
                span_id_factory=lambda: "b7ad6b7169203381",
                clock=lambda: next(clock_values),
                metadata={
                    "service": "checkout",
                    "cacheKey": "sensitive:user:42",
                    "commandArgs": ["sensitive:user:42"],
                    "connection": "redis://cache.example.invalid:6379/0",
                },
            )
            duplicate = instrument_redis_client_with_logbrew_spans(redis_client, client=logbrew_client)
            result = redis_client.execute_command("GET", "sensitive:user:42", routing_hint="placeholder")

        self.assertEqual(result, b"cached-profile")
        self.assertIs(duplicate, instrumentation)
        self.assertEqual(redis_client.calls, [(("GET", "sensitive:user:42"), {"routing_hint": "placeholder"})])
        self.assertEqual(
            redis_client.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203381",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(logbrew_client.preview_json())["events"][0]
        self.assertEqual(event["id"], "evt_python_redis_get")
        self.assertEqual(event["attributes"]["name"], "redis GET")
        self.assertEqual(event["attributes"]["durationMs"], 11.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "cache")
        self.assertEqual(metadata["framework"], "redis-py")
        self.assertEqual(metadata["cacheSystem"], "redis")
        self.assertEqual(metadata["cacheOperation"], "GET")
        self.assertEqual(metadata["cacheOperationKind"], "read")
        self.assertEqual(metadata["cacheName"], "profiles")
        self.assertTrue(metadata["cacheHit"])
        self.assertEqual(metadata["itemCount"], 1)
        self.assertEqual(metadata["itemSizeBytes"], len(b"cached-profile"))
        self.assertEqual(metadata["service"], "checkout")
        serialized = logbrew_client.preview_json()
        self.assertNotIn("sensitive:user:42", serialized)
        self.assertNotIn("cacheKey", serialized)
        self.assertNotIn("commandArgs", serialized)
        self.assertNotIn("cache.example.invalid", serialized)
        self.assertNotIn("placeholder", serialized)

        instrumentation.uninstall()
        self.assertFalse(instrumentation.installed)
        self.assertFalse(hasattr(redis_client, "_logbrew_redis_instrumentation"))
        redis_client.execute_command("GET", "sensitive:user:99")
        self.assertEqual(len(json.loads(logbrew_client.preview_json())["events"]), 1)

    def test_redis_client_instrumentation_handles_async_results_and_mget_counts(self) -> None:
        async def run() -> None:
            logbrew_client = sample_client()
            redis_client = AsyncStubRedisClient()
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            clock_values = iter([310.0, 310.013])

            with use_logbrew_trace(parent_trace):
                instrument_redis_client_with_logbrew_spans(
                    redis_client,
                    client=logbrew_client,
                    event_id_factory=lambda: "evt_python_redis_mget",
                    timestamp="2026-06-29T12:00:01Z",
                    cache_name="profiles",
                    span_id_factory=lambda: "b7ad6b7169203382",
                    clock=lambda: next(clock_values),
                )
                result = await redis_client.execute_command("MGET", "sensitive:one", "sensitive:two")

            self.assertEqual(result, [b"one", None, b"", b"three"])
            self.assertEqual(
                redis_client.active_trace,
                LogBrewTraceContext(
                    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                    span_id="b7ad6b7169203382",
                    parent_span_id="00f067aa0ba902b7",
                    sampled=True,
                ),
            )
            event = json.loads(logbrew_client.preview_json())["events"][0]
            self.assertEqual(event["attributes"]["name"], "redis MGET")
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["cacheOperationKind"], "read")
            self.assertTrue(metadata["cacheHit"])
            self.assertEqual(metadata["itemCount"], 2)
            self.assertNotIn("sensitive:one", logbrew_client.preview_json())

        asyncio.run(run())

    def test_redis_client_instrumentation_can_trace_app_owned_pipeline_execute(self) -> None:
        logbrew_client = sample_client()
        redis_client = StubRedisClient()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([315.0, 315.019])

        with use_logbrew_trace(parent_trace):
            instrumentation = instrument_redis_client_with_logbrew_spans(
                redis_client,
                client=logbrew_client,
                trace_pipelines=True,
                event_id_factory=lambda: "evt_python_redis_pipeline",
                timestamp="2026-06-29T12:00:03Z",
                cache_name="profiles",
                span_id_factory=lambda: "b7ad6b7169203385",
                clock=lambda: next(clock_values),
                metadata={
                    "service": "checkout",
                    "cacheKey": "sensitive:user:42",
                    "connection": "redis://cache.example.invalid:6379/0",
                },
            )
            pipeline = redis_client.pipeline(transaction=True)
            pipeline.get("sensitive:user:42").set("sensitive:user:42", "sensitive-profile")
            result = pipeline.execute(retry_hint="placeholder")

        self.assertEqual(result, [b"cached-profile", True])
        self.assertEqual(redis_client.calls, [(("PIPELINE",), {"transaction": True})])
        self.assertIs(redis_client.pipeline_instance, pipeline)
        self.assertEqual(pipeline.execute_calls, [((), {"retry_hint": "placeholder"})])
        self.assertEqual(
            pipeline.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203385",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(logbrew_client.preview_json())["events"][0]
        self.assertEqual(event["id"], "evt_python_redis_pipeline")
        self.assertEqual(event["attributes"]["name"], "redis PIPELINE")
        self.assertEqual(event["attributes"]["durationMs"], 19.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "cache")
        self.assertEqual(metadata["framework"], "redis-py")
        self.assertEqual(metadata["cacheSystem"], "redis")
        self.assertEqual(metadata["cacheOperation"], "PIPELINE")
        self.assertEqual(metadata["cacheOperationKind"], "command")
        self.assertEqual(metadata["cacheName"], "profiles")
        self.assertEqual(metadata["pipelineLength"], 2)
        self.assertEqual(metadata["pipelineOperations"], "GET,SET")
        self.assertEqual(metadata["service"], "checkout")
        serialized = logbrew_client.preview_json()
        self.assertNotIn("sensitive:user:42", serialized)
        self.assertNotIn("sensitive-profile", serialized)
        self.assertNotIn("cacheKey", serialized)
        self.assertNotIn("cache.example.invalid", serialized)
        self.assertNotIn("placeholder", serialized)

        instrumentation.uninstall()
        redis_client.pipeline().get("sensitive:user:99").execute()
        self.assertEqual(len(json.loads(logbrew_client.preview_json())["events"]), 1)

    def test_redis_client_pipeline_created_before_uninstall_stops_tracing_after_uninstall(self) -> None:
        logbrew_client = sample_client()
        redis_client = StubRedisClient()
        instrumentation = instrument_redis_client_with_logbrew_spans(
            redis_client,
            client=logbrew_client,
            trace_pipelines=True,
            event_id_factory=lambda: "evt_python_redis_pipeline_after_uninstall",
            timestamp="2026-06-29T12:00:04Z",
            span_id_factory=lambda: "b7ad6b7169203386",
            clock=lambda: 330.0,
        )
        pipeline = redis_client.pipeline()

        instrumentation.uninstall()
        result = pipeline.get("sensitive:user:99").execute()

        self.assertEqual(result, [b"cached-profile", True])
        self.assertIsNone(pipeline.active_trace)
        self.assertEqual(json.loads(logbrew_client.preview_json())["events"], [])

    def test_redis_client_instrumentation_preserves_errors_and_capture_failures(self) -> None:
        logbrew_client = sample_client()

        class StubRedisError(RuntimeError):
            pass

        class FailingRedisClient:
            def execute_command(self, *_args: Any, **_kwargs: Any) -> Any:
                raise StubRedisError("sensitive:user:42 unavailable")

        redis_client = FailingRedisClient()
        instrument_redis_client_with_logbrew_spans(
            redis_client,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_redis_error",
            timestamp="2026-06-29T12:00:02Z",
            span_id_factory=lambda: "b7ad6b7169203383",
            clock=lambda: 320.0,
        )

        with self.assertRaises(StubRedisError):
            redis_client.execute_command("SET", "sensitive:user:42", "sensitive-profile")

        event = json.loads(logbrew_client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["name"], "redis SET")
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["cacheOperationKind"], "write")
        self.assertEqual(metadata["errorType"], "StubRedisError")
        self.assertEqual(
            event["attributes"]["events"],
            [
                {
                    "name": "exception",
                    "metadata": {
                        "exceptionEscaped": True,
                        "exceptionType": "StubRedisError",
                    },
                }
            ],
        )
        serialized = logbrew_client.preview_json()
        self.assertNotIn("sensitive:user:42", serialized)
        self.assertNotIn("sensitive-profile", serialized)
        self.assertNotIn("unavailable", serialized)

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        closed_redis_client = StubRedisClient(result="ok")
        instrument_redis_client_with_logbrew_spans(
            closed_redis_client,
            client=closed_client,
            event_id_factory=lambda: "evt_python_redis_capture_failure",
            span_id_factory=lambda: "b7ad6b7169203384",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(closed_redis_client.execute_command("PING"), "ok")
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_redis_client_instrumentation_requires_execute_command(self) -> None:
        with self.assertRaises(TypeError):
            instrument_redis_client_with_logbrew_spans(object(), client=sample_client())
