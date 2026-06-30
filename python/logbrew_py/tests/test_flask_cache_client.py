from __future__ import annotations

import json
import unittest
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    instrument_flask_cache_with_logbrew_spans,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class StubFlaskCache:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.active_trace: LogBrewTraceContext | None = None

    def get(self, *args: Any, **kwargs: Any) -> bytes:
        self.calls.append(("get", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return b"cached-profile"

    def get_many(self, *args: Any, **kwargs: Any) -> list[bytes | None]:
        self.calls.append(("get_many", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return [b"cached-profile", None]

    def set(self, *args: Any, **kwargs: Any) -> bool:
        self.calls.append(("set", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return True

    def delete_many(self, *args: Any, **kwargs: Any) -> list[str]:
        self.calls.append(("delete_many", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return ["private:user:42", "private:user:99"]


class NestedGetManyFlaskCache(StubFlaskCache):
    def get_many(self, *args: Any, **kwargs: Any) -> list[bytes | None]:
        self.calls.append(("get_many", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return [self.get(args[0], **kwargs), None]


def assert_flask_cache_calls(test_case: unittest.TestCase, cache: StubFlaskCache) -> None:
    test_case.assertEqual(
        cache.calls,
        [
            ("get", ("private:user:42",), {}),
            ("get_many", ("private:user:42", "private:user:99"), {}),
            ("set", ("private:user:42", "sensitive-profile"), {"timeout": 60}),
            ("delete_many", ("private:user:42", "private:user:99"), {}),
        ],
    )


def assert_flask_cache_payload(test_case: unittest.TestCase, logbrew_client: LogBrewClient) -> None:
    payload = json.loads(logbrew_client.preview_json())
    test_case.assertEqual(
        [event["attributes"]["name"] for event in payload["events"]],
        [
            "flask-caching GET",
            "flask-caching GET_MANY",
            "flask-caching SET",
            "flask-caching DELETE_MANY",
        ],
    )
    get_metadata = payload["events"][0]["attributes"]["metadata"]
    many_metadata = payload["events"][1]["attributes"]["metadata"]
    set_metadata = payload["events"][2]["attributes"]["metadata"]
    delete_many_metadata = payload["events"][3]["attributes"]["metadata"]
    test_case.assertEqual(get_metadata["source"], "cache")
    test_case.assertEqual(get_metadata["framework"], "flask-caching")
    test_case.assertEqual(get_metadata["cacheSystem"], "flask-caching")
    test_case.assertEqual(get_metadata["cacheOperation"], "GET")
    test_case.assertEqual(get_metadata["cacheOperationKind"], "read")
    test_case.assertEqual(get_metadata["cacheName"], "profiles")
    test_case.assertTrue(get_metadata["cacheHit"])
    test_case.assertEqual(get_metadata["itemSizeBytes"], len(b"cached-profile"))
    test_case.assertEqual(many_metadata["cacheOperation"], "GET_MANY")
    test_case.assertEqual(many_metadata["itemCount"], 1)
    test_case.assertTrue(many_metadata["cacheHit"])
    test_case.assertEqual(set_metadata["cacheOperationKind"], "write")
    test_case.assertEqual(set_metadata["itemSizeBytes"], len("sensitive-profile"))
    test_case.assertEqual(delete_many_metadata["cacheOperationKind"], "delete")
    test_case.assertEqual(delete_many_metadata["itemCount"], 2)


def assert_flask_cache_privacy(test_case: unittest.TestCase, serialized: str) -> None:
    test_case.assertNotIn("private:user:42", serialized)
    test_case.assertNotIn("private:user:99", serialized)
    test_case.assertNotIn("sensitive-profile", serialized)
    test_case.assertNotIn("cacheKey", serialized)
    test_case.assertNotIn("cache.example.invalid", serialized)
    test_case.assertNotIn("timeout", serialized)


class FlaskCacheInstrumentationTests(unittest.TestCase):
    def test_flask_cache_instrumentation_queues_privacy_bounded_spans_and_uninstalls(self) -> None:
        logbrew_client = sample_client()
        cache = StubFlaskCache()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        span_ids = iter(
            [
                "b7ad6b7169203411",
                "b7ad6b7169203412",
                "b7ad6b7169203413",
                "b7ad6b7169203414",
            ]
        )
        clock_values = iter([700.0, 700.006, 701.0, 701.009, 702.0, 702.004, 703.0, 703.002])

        with use_logbrew_trace(parent_trace):
            instrumentation = instrument_flask_cache_with_logbrew_spans(
                cache,
                client=logbrew_client,
                event_id_factory=iter(
                    [
                        "evt_python_flask_cache_get",
                        "evt_python_flask_cache_get_many",
                        "evt_python_flask_cache_set",
                        "evt_python_flask_cache_delete_many",
                    ]
                ).__next__,
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
            duplicate = instrument_flask_cache_with_logbrew_spans(cache, client=logbrew_client)
            get_result = cache.get("private:user:42")
            many_result = cache.get_many("private:user:42", "private:user:99")
            set_result = cache.set("private:user:42", "sensitive-profile", timeout=60)
            delete_many_result = cache.delete_many("private:user:42", "private:user:99")

        self.assertIs(duplicate, instrumentation)
        self.assertEqual(get_result, b"cached-profile")
        self.assertEqual(many_result, [b"cached-profile", None])
        self.assertTrue(set_result)
        self.assertEqual(delete_many_result, ["private:user:42", "private:user:99"])
        assert_flask_cache_calls(self, cache)
        self.assertEqual(
            cache.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203414",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

        assert_flask_cache_payload(self, logbrew_client)
        serialized = logbrew_client.preview_json()
        assert_flask_cache_privacy(self, serialized)

        instrumentation.uninstall()
        self.assertFalse(hasattr(cache, "_logbrew_flask_cache_instrumentation"))
        cache.get("private:user:42")
        self.assertEqual(len(json.loads(logbrew_client.preview_json())["events"]), 4)

    def test_flask_cache_instrumentation_preserves_errors_and_capture_failures(self) -> None:
        logbrew_client = sample_client()

        class FailingFlaskCache:
            def get(self, key: str) -> object:
                raise RuntimeError(f"{key} unavailable")

        cache = FailingFlaskCache()
        instrument_flask_cache_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_flask_cache_error",
            span_id_factory=lambda: "b7ad6b7169203415",
            clock=iter([710.0, 710.003]).__next__,
        )

        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            cache.get("private:user:42")

        payload = json.loads(logbrew_client.preview_json())
        event = payload["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "RuntimeError")
        self.assertNotIn("private:user:42", logbrew_client.preview_json())

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        healthy_cache = StubFlaskCache()
        instrument_flask_cache_with_logbrew_spans(
            healthy_cache,
            client=closed_client,
            event_id_factory=lambda: "evt_python_flask_cache_capture_error",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(healthy_cache.get("private:user:42"), b"cached-profile")
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_get_many_internal_get_emits_only_outer_span(self) -> None:
        logbrew_client = sample_client()
        cache = NestedGetManyFlaskCache()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )

        instrument_flask_cache_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_flask_cache_get_many",
            timestamp="2026-06-30T12:00:00Z",
            cache_name="profiles",
            span_id_factory=lambda: "b7ad6b7169203416",
            clock=iter([720.0, 720.007]).__next__,
        )

        with use_logbrew_trace(parent_trace):
            result = cache.get_many("private:user:42", "private:user:99")

        self.assertEqual(result, [b"cached-profile", None])
        self.assertEqual(
            cache.calls,
            [
                ("get_many", ("private:user:42", "private:user:99"), {}),
                ("get", ("private:user:42",), {}),
            ],
        )
        self.assertEqual(
            cache.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203416",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

        payload = json.loads(logbrew_client.preview_json())
        self.assertEqual(len(payload["events"]), 1)
        metadata = payload["events"][0]["attributes"]["metadata"]
        self.assertEqual(payload["events"][0]["attributes"]["name"], "flask-caching GET_MANY")
        self.assertEqual(metadata["cacheOperation"], "GET_MANY")
        self.assertEqual(metadata["itemCount"], 1)

    def test_method_reference_created_before_uninstall_stops_tracing_after_uninstall(self) -> None:
        logbrew_client = sample_client()
        cache = StubFlaskCache()
        instrumentation = instrument_flask_cache_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_flask_cache_after_uninstall",
            span_id_factory=lambda: "b7ad6b7169203417",
        )
        wrapped_get = cache.get

        instrumentation.uninstall()
        result = wrapped_get("private:user:42")

        self.assertEqual(result, b"cached-profile")
        self.assertIsNone(cache.active_trace)
        self.assertEqual(json.loads(logbrew_client.preview_json())["events"], [])
