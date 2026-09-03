from __future__ import annotations

import json
import unittest
from collections.abc import Callable
from typing import Any, ClassVar

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
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


class StubCache:
    django = False

    def __init__(self, *, nested: bool = False) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.active_trace: LogBrewTraceContext | None = None
        self.nested = nested

    def _record(self, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
        self.calls.append((name, args, kwargs))
        self.active_trace = get_active_logbrew_trace()

    def get(self, *args: Any, **kwargs: Any) -> bytes:
        self._record("get", args, kwargs)
        return b"cached-profile"

    def get_many(self, *args: Any, **kwargs: Any) -> Any:
        self._record("get_many", args, kwargs)
        if self.django:
            key = args[0][0]
            return (
                {key: self.get(key, default=None, **kwargs)}
                if self.nested
                else {key: b"cached-profile"}
            )
        return (
            [self.get(args[0], **kwargs), None]
            if self.nested
            else [b"cached-profile", None]
        )

    def set(self, *args: Any, **kwargs: Any) -> bool:
        self._record("set", args, kwargs)
        return True

    def set_many(self, *args: Any, **kwargs: Any) -> bool:
        self._record("set_many", args, kwargs)
        return True

    def delete_many(self, *args: Any, **kwargs: Any) -> Any:
        self._record("delete_many", args, kwargs)
        return 2 if self.django else list(args)


class CacheInstrumentationContract(unittest.TestCase):
    django: ClassVar[bool]
    system: ClassVar[str]
    framework: ClassVar[str]
    attr: ClassVar[str]
    instrument: ClassVar[Callable[..., Any]]

    def cache(self, *, nested: bool = False) -> StubCache:
        cache = StubCache(nested=nested)
        cache.django = self.django
        return cache

    def many_args(self) -> tuple[Any, ...]:
        keys = ("private:user:42", "private:user:99")
        return (list(keys),) if self.django else keys

    def test_cache_spans_are_correlated_bounded_and_reversible(self) -> None:
        client, cache = sample_client(), self.cache()
        parent = LogBrewTraceContext(
            "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", sampled=True
        )
        span_ids = iter(f"b7ad6b71692034{index:02d}" for index in range(11, 16))
        clock = iter(
            [
                700.0,
                700.006,
                701.0,
                701.009,
                702.0,
                702.004,
                703.0,
                703.005,
                704.0,
                704.002,
            ]
        )
        with use_logbrew_trace(parent):
            instrumentation = self.instrument(
                cache,
                client=client,
                event_id_factory=iter(
                    f"evt_cache_{index}" for index in range(5)
                ).__next__,
                timestamp="2026-06-30T12:00:00Z",
                cache_name="profiles",
                span_id_factory=span_ids.__next__,
                clock=clock.__next__,
                metadata={
                    "service": "checkout",
                    "cacheKey": "private:user:42",
                    "connection": "redis://cache.example.invalid:6379/0",
                },
            )
            duplicate = self.instrument(cache, client=client)
            get_kwargs = {"default": None, "version": 7} if self.django else {}
            results = (
                cache.get("private:user:42", **get_kwargs),
                cache.get_many(
                    *self.many_args(), **({"version": 7} if self.django else {})
                ),
                cache.set("private:user:42", "sensitive-profile", timeout=60),
                cache.set_many({"private:user:42": "sensitive-profile"}, timeout=60),
                cache.delete_many(*self.many_args()),
            )

        self.assertIs(duplicate, instrumentation)
        self.assertEqual(results[0], b"cached-profile")
        expected_many = (
            {"private:user:42": b"cached-profile"}
            if self.django
            else [b"cached-profile", None]
        )
        self.assertEqual(results[1], expected_many)
        self.assertEqual(results[2], True)
        self.assertEqual(results[3], True)
        events = json.loads(client.preview_json())["events"]
        expected_names = [
            f"{self.system} {name}"
            for name in ("GET", "GET_MANY", "SET", "SET_MANY", "DELETE_MANY")
        ]
        self.assertEqual(
            [event["attributes"]["name"] for event in events], expected_names
        )
        metadata = [event["attributes"]["metadata"] for event in events]
        self.assertEqual(
            {
                key: metadata[0][key]
                for key in (
                    "source",
                    "framework",
                    "cacheSystem",
                    "cacheOperation",
                    "cacheOperationKind",
                    "cacheName",
                    "cacheHit",
                    "itemSizeBytes",
                )
            },
            {
                "source": "cache",
                "framework": self.framework,
                "cacheSystem": self.system,
                "cacheOperation": "GET",
                "cacheOperationKind": "read",
                "cacheName": "profiles",
                "cacheHit": True,
                "itemSizeBytes": len(b"cached-profile"),
            },
        )
        self.assertEqual((metadata[1]["itemCount"], metadata[1]["cacheHit"]), (1, True))
        self.assertEqual(
            (metadata[2]["cacheOperationKind"], metadata[2]["itemSizeBytes"]),
            ("write", 17),
        )
        self.assertEqual(
            (metadata[3]["cacheOperationKind"], metadata[3]["itemCount"]), ("write", 1)
        )
        self.assertEqual(
            (metadata[4]["cacheOperationKind"], metadata[4]["itemCount"]), ("delete", 2)
        )
        expected_trace = LogBrewTraceContext(
            parent.trace_id, "b7ad6b7169203415", parent.span_id, True
        )
        self.assertEqual(cache.active_trace, expected_trace)
        private_values = (
            "private:user:42",
            "private:user:99",
            "sensitive-profile",
            "cacheKey",
            "cache.example.invalid",
            "timeout",
        )
        for private in private_values:
            self.assertNotIn(private, client.preview_json())
        instrumentation.uninstall()
        self.assertFalse(hasattr(cache, self.attr))
        cache.get("private:user:42")
        self.assertEqual(len(json.loads(client.preview_json())["events"]), 5)

    def test_errors_and_capture_failures_preserve_cache_behavior(self) -> None:
        client = sample_client()

        class FailingCache:
            def get(self, key: str) -> object:
                raise RuntimeError(f"{key} unavailable")

        failing = FailingCache()
        self.instrument(
            failing,
            client=client,
            event_id_factory=lambda: "evt_cache_error",
            span_id_factory=lambda: "b7ad6b7169203415",
            clock=iter([710.0, 710.003]).__next__,
        )
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            failing.get("private:user:42")
        event = json.loads(client.preview_json())["events"][0]["attributes"]
        self.assertEqual(
            (event["status"], event["metadata"]["errorType"]), ("error", "RuntimeError")
        )
        self.assertNotIn("private:user:42", client.preview_json())

        closed, errors, healthy = sample_client(), [], self.cache()
        closed.closed = True
        self.instrument(
            healthy,
            client=closed,
            on_capture_error=lambda error: errors.append(str(error)),
        )
        self.assertEqual(healthy.get("private:user:42"), b"cached-profile")
        self.assertEqual(len(errors), 1)
        self.assertIn("client is already shut down", errors[0])

    def test_nested_get_many_emits_only_the_outer_span(self) -> None:
        client, cache = sample_client(), self.cache(nested=True)
        parent = LogBrewTraceContext(
            "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", sampled=True
        )
        self.instrument(
            cache,
            client=client,
            event_id_factory=lambda: "evt_cache_get_many",
            cache_name="profiles",
            span_id_factory=lambda: "b7ad6b7169203416",
            clock=iter([720.0, 720.007]).__next__,
        )
        with use_logbrew_trace(parent):
            cache.get_many(*self.many_args(), **({"version": 7} if self.django else {}))
        events = json.loads(client.preview_json())["events"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["attributes"]["name"], f"{self.system} GET_MANY")
        self.assertEqual(events[0]["attributes"]["metadata"]["itemCount"], 1)
        expected_trace = LogBrewTraceContext(
            parent.trace_id, "b7ad6b7169203416", parent.span_id, True
        )
        self.assertEqual(cache.active_trace, expected_trace)

    def test_wrapped_reference_stops_tracing_after_uninstall(self) -> None:
        client, cache = sample_client(), self.cache()
        instrumentation = self.instrument(cache, client=client)
        wrapped_get = cache.get
        instrumentation.uninstall()
        self.assertEqual(wrapped_get("private:user:42"), b"cached-profile")
        self.assertIsNone(cache.active_trace)
        self.assertEqual(json.loads(client.preview_json())["events"], [])
