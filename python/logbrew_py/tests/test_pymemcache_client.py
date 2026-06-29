from __future__ import annotations

import json
import unittest
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    instrument_pymemcache_client_with_logbrew_spans,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class StubPymemcacheClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.active_trace: LogBrewTraceContext | None = None

    def get(self, *args: Any, **kwargs: Any) -> bytes:
        self.calls.append(("get", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return b"cached-profile"

    def get_many(self, *args: Any, **kwargs: Any) -> dict[bytes, bytes]:
        self.calls.append(("get_many", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return {b"private:user:42": b"cached-profile"}

    def set(self, *args: Any, **kwargs: Any) -> bool:
        self.calls.append(("set", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return True


class NestedSetManyPymemcacheClient(StubPymemcacheClient):
    def set_many(self, *args: Any, **kwargs: Any) -> list[bytes]:
        self.calls.append(("set_many", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        for key, value in args[0].items():
            self.set(key, value, **kwargs)
        return []


class PymemcacheInstrumentationTests(unittest.TestCase):
    def test_pymemcache_instrumentation_queues_privacy_bounded_spans_and_uninstalls(self) -> None:
        logbrew_client = sample_client()
        cache = StubPymemcacheClient()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        span_ids = iter(["b7ad6b7169203401", "b7ad6b7169203402", "b7ad6b7169203403"])
        clock_values = iter([700.0, 700.006, 701.0, 701.009, 702.0, 702.004])

        with use_logbrew_trace(parent_trace):
            instrumentation = instrument_pymemcache_client_with_logbrew_spans(
                cache,
                client=logbrew_client,
                event_id_factory=iter(
                    [
                        "evt_python_pymemcache_get",
                        "evt_python_pymemcache_get_many",
                        "evt_python_pymemcache_set",
                    ]
                ).__next__,
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
            duplicate = instrument_pymemcache_client_with_logbrew_spans(cache, client=logbrew_client)
            get_result = cache.get(b"private:user:42", default=None)
            many_result = cache.get_many([b"private:user:42", b"private:user:99"])
            set_result = cache.set(b"private:user:42", b"sensitive-profile", expire=60)

        self.assertIs(duplicate, instrumentation)
        self.assertEqual(get_result, b"cached-profile")
        self.assertEqual(many_result, {b"private:user:42": b"cached-profile"})
        self.assertTrue(set_result)
        self.assertEqual(
            cache.calls,
            [
                ("get", (b"private:user:42",), {"default": None}),
                ("get_many", ([b"private:user:42", b"private:user:99"],), {}),
                ("set", (b"private:user:42", b"sensitive-profile"), {"expire": 60}),
            ],
        )
        self.assertEqual(
            cache.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203403",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

        payload = json.loads(logbrew_client.preview_json())
        self.assertEqual(
            [event["attributes"]["name"] for event in payload["events"]],
            ["memcached GET", "memcached GET_MANY", "memcached SET"],
        )
        get_metadata = payload["events"][0]["attributes"]["metadata"]
        many_metadata = payload["events"][1]["attributes"]["metadata"]
        set_metadata = payload["events"][2]["attributes"]["metadata"]
        self.assertEqual(get_metadata["source"], "cache")
        self.assertEqual(get_metadata["framework"], "pymemcache")
        self.assertEqual(get_metadata["cacheSystem"], "memcached")
        self.assertEqual(get_metadata["cacheOperation"], "GET")
        self.assertEqual(get_metadata["cacheOperationKind"], "read")
        self.assertEqual(get_metadata["cacheName"], "profiles")
        self.assertTrue(get_metadata["cacheHit"])
        self.assertEqual(get_metadata["itemSizeBytes"], len(b"cached-profile"))
        self.assertEqual(many_metadata["cacheOperation"], "GET_MANY")
        self.assertEqual(many_metadata["itemCount"], 1)
        self.assertTrue(many_metadata["cacheHit"])
        self.assertEqual(set_metadata["cacheOperationKind"], "write")
        self.assertEqual(set_metadata["itemSizeBytes"], len(b"sensitive-profile"))
        serialized = logbrew_client.preview_json()
        self.assertNotIn("private:user:42", serialized)
        self.assertNotIn("private:user:99", serialized)
        self.assertNotIn("sensitive-profile", serialized)
        self.assertNotIn("cacheKey", serialized)
        self.assertNotIn("cache.example.invalid", serialized)
        self.assertNotIn("expire", serialized)

        instrumentation.uninstall()
        self.assertFalse(hasattr(cache, "_logbrew_pymemcache_instrumentation"))
        cache.get(b"private:user:42")
        self.assertEqual(len(json.loads(logbrew_client.preview_json())["events"]), 3)

    def test_nested_batch_internal_calls_emit_only_outer_span(self) -> None:
        logbrew_client = sample_client()
        cache = NestedSetManyPymemcacheClient()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )

        instrument_pymemcache_client_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_pymemcache_set_many",
            timestamp="2026-06-29T21:00:00Z",
            cache_name="profiles",
            span_id_factory=lambda: "b7ad6b7169203404",
            clock=iter([710.0, 710.007]).__next__,
        )

        with use_logbrew_trace(parent_trace):
            result = cache.set_many({b"private:user:42": b"sensitive-profile"}, expire=60)

        self.assertEqual(result, [])
        self.assertEqual(
            cache.calls,
            [
                ("set_many", ({b"private:user:42": b"sensitive-profile"},), {"expire": 60}),
                ("set", (b"private:user:42", b"sensitive-profile"), {"expire": 60}),
            ],
        )
        self.assertEqual(
            cache.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203404",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

        payload = json.loads(logbrew_client.preview_json())
        self.assertEqual(len(payload["events"]), 1)
        metadata = payload["events"][0]["attributes"]["metadata"]
        self.assertEqual(payload["events"][0]["attributes"]["name"], "memcached SET_MANY")
        self.assertEqual(metadata["cacheOperation"], "SET_MANY")
        self.assertEqual(metadata["itemCount"], 1)

    def test_positional_get_default_is_treated_as_miss(self) -> None:
        logbrew_client = sample_client()

        class MissingPymemcacheClient:
            def get(self, key: bytes, default: bytes | None = None) -> bytes | None:
                return default

        cache = MissingPymemcacheClient()
        instrument_pymemcache_client_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_pymemcache_miss",
            span_id_factory=lambda: "b7ad6b7169203405",
            clock=iter([715.0, 715.002]).__next__,
        )

        self.assertEqual(cache.get(b"private:user:42", b"fallback-profile"), b"fallback-profile")

        payload = json.loads(logbrew_client.preview_json())
        metadata = payload["events"][0]["attributes"]["metadata"]
        self.assertFalse(metadata["cacheHit"])
        self.assertNotIn("itemSizeBytes", metadata)

    def test_pymemcache_instrumentation_preserves_errors_and_capture_failures(self) -> None:
        logbrew_client = sample_client()

        class FailingPymemcacheClient:
            def get(self, key: bytes) -> object:
                raise RuntimeError(f"{key!r} unavailable")

        cache = FailingPymemcacheClient()
        instrument_pymemcache_client_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_pymemcache_error",
            span_id_factory=lambda: "b7ad6b7169203405",
            clock=iter([720.0, 720.003]).__next__,
        )

        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            cache.get(b"private:user:42")

        payload = json.loads(logbrew_client.preview_json())
        event = payload["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "RuntimeError")
        self.assertNotIn("private:user:42", logbrew_client.preview_json())

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        healthy_cache = StubPymemcacheClient()
        instrument_pymemcache_client_with_logbrew_spans(
            healthy_cache,
            client=closed_client,
            event_id_factory=lambda: "evt_python_pymemcache_capture_error",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(healthy_cache.get(b"private:user:42"), b"cached-profile")
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])
