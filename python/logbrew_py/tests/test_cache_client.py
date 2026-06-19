from __future__ import annotations

import asyncio
import json
import unittest

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    async_cache_operation_with_logbrew_span,
    cache_operation_with_logbrew_span,
    get_active_logbrew_trace,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class CacheOperationSpanTests(unittest.TestCase):
    def test_cache_operation_with_logbrew_span_queues_privacy_bounded_span(self) -> None:
        client = sample_client()
        active_trace: LogBrewTraceContext | None = None
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([200.0, 200.009])

        def operation() -> bytes:
            nonlocal active_trace
            active_trace = get_active_logbrew_trace()
            return b"cached-profile"

        with use_logbrew_trace(parent_trace):
            result = cache_operation_with_logbrew_span(
                operation_name="GET profile",
                client=client,
                event_id="evt_python_cache_get",
                timestamp="2026-06-19T11:15:00Z",
                operation=operation,
                system="redis",
                cache_name="profiles",
                cache_hit=True,
                item_size_bytes=14,
                item_count=1,
                span_id_factory=lambda: "b7ad6b7169203351",
                clock=lambda: next(clock_values),
                metadata={"service": "checkout", "cacheKey": "private:user:42"},
            )

        self.assertEqual(result, b"cached-profile")
        self.assertEqual(
            active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203351",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "redis GET profile")
        self.assertEqual(event["attributes"]["durationMs"], 9.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "cache")
        self.assertEqual(metadata["cacheSystem"], "redis")
        self.assertEqual(metadata["cacheOperation"], "GET profile")
        self.assertEqual(metadata["cacheName"], "profiles")
        self.assertTrue(metadata["cacheHit"])
        self.assertEqual(metadata["itemSizeBytes"], 14)
        self.assertEqual(metadata["itemCount"], 1)
        self.assertEqual(metadata["service"], "checkout")
        serialized = client.preview_json()
        self.assertNotIn("private:user:42", serialized)
        self.assertNotIn("cacheKey", serialized)

    def test_cache_operation_with_logbrew_span_preserves_errors_and_capture_failures(self) -> None:
        client = sample_client()

        class StubCacheError(RuntimeError):
            pass

        original_error = StubCacheError("redis private:user:42 unavailable")

        with self.assertRaises(StubCacheError) as raised:
            cache_operation_with_logbrew_span(
                operation_name="SET profile",
                client=client,
                event_id="evt_python_cache_failure",
                timestamp="2026-06-19T11:15:01Z",
                operation=lambda: (_ for _ in ()).throw(original_error),
                system="redis",
                cache_name="profiles",
                span_id_factory=lambda: "b7ad6b7169203352",
                clock=lambda: 220.0,
            )

        self.assertIs(raised.exception, original_error)
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["source"], "cache")
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "StubCacheError")
        self.assertNotIn("private:user:42", client.preview_json())

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        result = cache_operation_with_logbrew_span(
            operation_name="GET health",
            client=closed_client,
            event_id="evt_python_cache_capture_error",
            timestamp="2026-06-19T11:15:02Z",
            operation=lambda: "ok",
            system="memory",
            span_id_factory=lambda: "b7ad6b7169203353",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(result, "ok")
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_async_cache_operation_with_logbrew_span_queues_privacy_bounded_span(self) -> None:
        async def run() -> None:
            client = sample_client()
            active_trace: LogBrewTraceContext | None = None
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            clock_values = iter([230.0, 230.017])

            async def operation() -> dict[str, str]:
                nonlocal active_trace
                active_trace = get_active_logbrew_trace()
                return {"status": "stored"}

            with use_logbrew_trace(parent_trace):
                result = await async_cache_operation_with_logbrew_span(
                    operation_name="SET profile",
                    client=client,
                    event_id="evt_python_cache_async_set",
                    timestamp="2026-06-19T11:15:03Z",
                    operation=operation,
                    system="memcached",
                    cache_name="profiles",
                    cache_hit=False,
                    item_size_bytes=64,
                    span_id_factory=lambda: "b7ad6b7169203354",
                    clock=lambda: next(clock_values),
                    metadata={"service": "checkout", "keys": ["private:user:42"]},
                )

            self.assertEqual(result, {"status": "stored"})
            self.assertEqual(
                active_trace,
                LogBrewTraceContext(
                    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                    span_id="b7ad6b7169203354",
                    parent_span_id="00f067aa0ba902b7",
                    sampled=True,
                ),
            )
            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["attributes"]["name"], "memcached SET profile")
            self.assertEqual(event["attributes"]["durationMs"], 17.0)
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["source"], "cache")
            self.assertEqual(metadata["cacheSystem"], "memcached")
            self.assertFalse(metadata["cacheHit"])
            self.assertEqual(metadata["itemSizeBytes"], 64)
            serialized = client.preview_json()
            self.assertNotIn("keys", serialized)
            self.assertNotIn("private:user:42", serialized)

        asyncio.run(run())
