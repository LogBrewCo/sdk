from __future__ import annotations

import json
import unittest
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    instrument_django_cache_with_logbrew_spans,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class StubDjangoCache:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.active_trace: LogBrewTraceContext | None = None

    def get(self, *args: Any, **kwargs: Any) -> bytes:
        self.calls.append(("get", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return b"cached-profile"

    def get_many(self, *args: Any, **kwargs: Any) -> dict[str, bytes]:
        self.calls.append(("get_many", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return {"private:user:42": b"cached-profile"}

    def set(self, *args: Any, **kwargs: Any) -> bool:
        self.calls.append(("set", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        return True


class NestedGetManyDjangoCache(StubDjangoCache):
    def get_many(self, *args: Any, **kwargs: Any) -> dict[str, bytes]:
        self.calls.append(("get_many", args, kwargs))
        self.active_trace = get_active_logbrew_trace()
        first_key = args[0][0]
        return {first_key: self.get(first_key, default=None, **kwargs)}


class DjangoCacheInstrumentationTests(unittest.TestCase):
    def test_django_cache_instrumentation_queues_privacy_bounded_spans_and_uninstalls(self) -> None:
        logbrew_client = sample_client()
        cache = StubDjangoCache()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        span_ids = iter(["b7ad6b7169203391", "b7ad6b7169203392", "b7ad6b7169203393"])
        clock_values = iter([400.0, 400.006, 401.0, 401.009, 402.0, 402.004])

        with use_logbrew_trace(parent_trace):
            instrumentation = instrument_django_cache_with_logbrew_spans(
                cache,
                client=logbrew_client,
                event_id_factory=iter(
                    [
                        "evt_python_django_cache_get",
                        "evt_python_django_cache_get_many",
                        "evt_python_django_cache_set",
                    ]
                ).__next__,
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
            duplicate = instrument_django_cache_with_logbrew_spans(cache, client=logbrew_client)
            get_result = cache.get("private:user:42", default=None, version=7)
            many_result = cache.get_many(["private:user:42", "private:user:99"], version=7)
            set_result = cache.set("private:user:42", "sensitive-profile", timeout=60)

        self.assertIs(duplicate, instrumentation)
        self.assertEqual(get_result, b"cached-profile")
        self.assertEqual(many_result, {"private:user:42": b"cached-profile"})
        self.assertTrue(set_result)
        self.assertEqual(
            cache.calls,
            [
                ("get", ("private:user:42",), {"default": None, "version": 7}),
                ("get_many", (["private:user:42", "private:user:99"],), {"version": 7}),
                ("set", ("private:user:42", "sensitive-profile"), {"timeout": 60}),
            ],
        )
        self.assertEqual(
            cache.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203393",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

        payload = json.loads(logbrew_client.preview_json())
        self.assertEqual(
            [event["attributes"]["name"] for event in payload["events"]],
            ["django-cache GET", "django-cache GET_MANY", "django-cache SET"],
        )
        get_metadata = payload["events"][0]["attributes"]["metadata"]
        many_metadata = payload["events"][1]["attributes"]["metadata"]
        set_metadata = payload["events"][2]["attributes"]["metadata"]
        self.assertEqual(get_metadata["source"], "cache")
        self.assertEqual(get_metadata["framework"], "django-cache")
        self.assertEqual(get_metadata["cacheSystem"], "django-cache")
        self.assertEqual(get_metadata["cacheOperation"], "GET")
        self.assertEqual(get_metadata["cacheOperationKind"], "read")
        self.assertEqual(get_metadata["cacheName"], "profiles")
        self.assertTrue(get_metadata["cacheHit"])
        self.assertEqual(get_metadata["itemSizeBytes"], len(b"cached-profile"))
        self.assertEqual(many_metadata["cacheOperation"], "GET_MANY")
        self.assertEqual(many_metadata["itemCount"], 1)
        self.assertTrue(many_metadata["cacheHit"])
        self.assertEqual(set_metadata["cacheOperationKind"], "write")
        self.assertEqual(set_metadata["itemSizeBytes"], len("sensitive-profile"))
        serialized = logbrew_client.preview_json()
        self.assertNotIn("private:user:42", serialized)
        self.assertNotIn("private:user:99", serialized)
        self.assertNotIn("sensitive-profile", serialized)
        self.assertNotIn("cacheKey", serialized)
        self.assertNotIn("cache.example.invalid", serialized)
        self.assertNotIn("timeout", serialized)
        self.assertNotIn('"version": 7', serialized)

        instrumentation.uninstall()
        self.assertFalse(hasattr(cache, "_logbrew_django_cache_instrumentation"))
        cache.get("private:user:42")
        self.assertEqual(len(json.loads(logbrew_client.preview_json())["events"]), 3)

    def test_django_cache_instrumentation_preserves_errors_and_capture_failures(self) -> None:
        logbrew_client = sample_client()

        class FailingDjangoCache:
            def get(self, key: str) -> object:
                raise RuntimeError(f"{key} unavailable")

        cache = FailingDjangoCache()
        instrument_django_cache_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_django_cache_error",
            span_id_factory=lambda: "b7ad6b7169203394",
            clock=iter([410.0, 410.003]).__next__,
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
        healthy_cache = StubDjangoCache()
        instrument_django_cache_with_logbrew_spans(
            healthy_cache,
            client=closed_client,
            event_id_factory=lambda: "evt_python_django_cache_capture_error",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(healthy_cache.get("private:user:42"), b"cached-profile")
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_get_many_internal_get_emits_only_outer_span(self) -> None:
        logbrew_client = sample_client()
        cache = NestedGetManyDjangoCache()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )

        instrument_django_cache_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_django_cache_get_many",
            timestamp="2026-06-29T19:00:00Z",
            cache_name="profiles",
            span_id_factory=lambda: "b7ad6b7169203393",
            clock=iter([600.0, 600.007]).__next__,
        )

        with use_logbrew_trace(parent_trace):
            result = cache.get_many(["private:user:42"], version=7)

        self.assertEqual(result, {"private:user:42": b"cached-profile"})
        self.assertEqual(
            cache.calls,
            [
                ("get_many", (["private:user:42"],), {"version": 7}),
                ("get", ("private:user:42",), {"default": None, "version": 7}),
            ],
        )
        self.assertEqual(
            cache.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203393",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

        payload = json.loads(logbrew_client.preview_json())
        self.assertEqual(len(payload["events"]), 1)
        metadata = payload["events"][0]["attributes"]["metadata"]
        self.assertEqual(payload["events"][0]["attributes"]["name"], "django-cache GET_MANY")
        self.assertEqual(metadata["cacheOperation"], "GET_MANY")
        self.assertEqual(metadata["itemCount"], 1)

    def test_method_reference_created_before_uninstall_stops_tracing_after_uninstall(self) -> None:
        logbrew_client = sample_client()
        cache = StubDjangoCache()
        instrumentation = instrument_django_cache_with_logbrew_spans(
            cache,
            client=logbrew_client,
            event_id_factory=lambda: "evt_python_django_cache_after_uninstall",
            span_id_factory=lambda: "b7ad6b7169203395",
        )
        wrapped_get = cache.get

        instrumentation.uninstall()
        result = wrapped_get("private:user:42")

        self.assertEqual(result, b"cached-profile")
        self.assertIsNone(cache.active_trace)
        self.assertEqual(json.loads(logbrew_client.preview_json())["events"], [])
