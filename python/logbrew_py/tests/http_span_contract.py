"""Shared assertions for app-owned synchronous and asynchronous HTTP helpers."""

from __future__ import annotations

import asyncio
import inspect
import json
import unittest
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import AsyncMock

from logbrew_sdk import LogBrewClient, LogBrewTraceContext, get_active_logbrew_trace, use_logbrew_trace

_URL = "https://api.example.test/payments/123?coupon=summer#receipt"
_ROUTE = "/payments/:payment_id"
_PARENT = LogBrewTraceContext("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", sampled=True)


async def _await_result(result: Awaitable[object]) -> object:
    return await result


@dataclass(frozen=True)
class HttpSpanCase:
    """Keep each adapter's original inputs and assertion strength explicit."""

    operation: Callable[..., object]
    source: str
    status: int
    span_id: str
    method: str = "GET"
    duration_ms: float = 0
    timeout: float = 3.5
    asynchronous: bool = False
    status_attribute: str = "status_code"
    explicit_trace: bool = False
    exact_attributes: bool = False
    error_message: str = "connection failed for redacted-url"

    def call(self, client: LogBrewClient, request: Callable[..., object], **options: object) -> object:
        """Call the public helper using a real coroutine for asynchronous requests."""
        result = self.operation(
            self.method,
            _URL,
            client=client,
            event_id=f"evt_python_{self.source.replace('.', '_')}_client",
            timestamp="2026-06-19T09:00:00Z",
            request=AsyncMock(side_effect=request) if self.asynchronous else request,
            span_id_factory=lambda: self.span_id,
            **options,
        )
        return asyncio.run(_await_result(result)) if inspect.isawaitable(result) else result


def assert_success(test: unittest.TestCase, client: LogBrewClient, case: HttpSpanCase) -> None:
    """Check response identity, trace propagation, forwarding, timing, and privacy."""
    caller_headers = {"Traceparent": "spoofed", "x-caller": "checkout"}
    calls: list[dict[str, object]] = []
    traces: list[LogBrewTraceContext | None] = []
    response = SimpleNamespace(**{case.status_attribute: case.status})

    def request(method: str, url: str, **kwargs: object) -> SimpleNamespace:
        calls.append({"method": method, "url": url, **kwargs})
        traces.append(get_active_logbrew_trace())
        return response

    with use_logbrew_trace(None if case.explicit_trace else _PARENT):
        result = case.call(
            client,
            request,
            trace=_PARENT if case.explicit_trace else None,
            timeout=case.timeout,
            headers=caller_headers,
            json={"card": "private"},
            route_template=_ROUTE,
            clock=iter([10.0, 10.0 + case.duration_ms / 1000]).__next__,
            metadata={"service": "checkout", "headers": {"authorization": "private"}},
        )

    test.assertIs(result, response)
    test.assertEqual(getattr(response, case.status_attribute), case.status)
    test.assertIsNone(get_active_logbrew_trace())
    test.assertEqual(caller_headers, {"Traceparent": "spoofed", "x-caller": "checkout"})
    test.assertEqual(len(calls), 1)
    sent_headers = calls[0]["headers"]
    test.assertIsInstance(sent_headers, dict)
    test.assertIsNot(sent_headers, caller_headers)
    test.assertEqual(
        sent_headers,
        {
            "x-caller": "checkout",
            "traceparent": f"00-{_PARENT.trace_id}-{case.span_id}-01",
        },
    )
    test.assertEqual(
        calls[0],
        {
            "method": case.method,
            "url": _URL,
            "timeout": case.timeout,
            "headers": sent_headers,
            "json": {"card": "private"},
        },
    )
    test.assertEqual(traces, [LogBrewTraceContext(_PARENT.trace_id, case.span_id, _PARENT.span_id, True)])
    events = json.loads(client.preview_json())["events"]
    test.assertEqual(len(events), 1)
    test.assertEqual(events[0]["type"], "span")
    test.assertEqual(events[0]["id"], f"evt_python_{case.source.replace('.', '_')}_client")
    attributes = events[0]["attributes"]
    expected = {
        "name": f"{case.method.upper()} {_ROUTE}",
        "traceId": _PARENT.trace_id,
        "spanId": case.span_id,
        "parentSpanId": _PARENT.span_id,
        "status": "ok",
        "durationMs": case.duration_ms,
        "metadata": {
            "source": case.source,
            "service": "checkout",
            "routeTemplate": _ROUTE,
            "method": case.method.upper(),
            "statusCode": case.status,
            "sampled": True,
        },
    }
    test.assertEqual(attributes if case.exact_attributes else {key: attributes[key] for key in expected}, expected)
    for private in ("coupon=summer", "authorization", "traceparent", "card"):
        test.assertNotIn(private, client.preview_json())


class HttpRequestError(RuntimeError):
    """A dependency failure with a status-bearing response and private message."""

    def __init__(self, response: SimpleNamespace, message: str) -> None:
        super().__init__(message)
        self.response = response


def assert_failure(test: unittest.TestCase, client: LogBrewClient, case: HttpSpanCase) -> None:
    """Check original exceptions and fail-open delivery without losing privacy."""
    response = SimpleNamespace(**{case.status_attribute: case.status})
    original_error = HttpRequestError(response, case.error_message)

    def request(_method: str, _url: str, **_kwargs: object) -> object:
        raise original_error

    with test.assertRaises(HttpRequestError) as raised:
        case.call(client, request, clock=lambda: 20.0)
    test.assertIs(raised.exception, original_error)
    attributes = json.loads(client.preview_json())["events"][0]["attributes"]
    metadata = attributes["metadata"]
    test.assertEqual(attributes["status"], "error")
    test.assertEqual(metadata["source"], case.source)
    test.assertEqual(metadata["statusCode"], case.status)
    test.assertEqual(metadata["errorType"], "HttpRequestError")
    test.assertNotIn("errorMessage", metadata)
    for private in (case.error_message, "coupon=summer"):
        test.assertNotIn(private, client.preview_json())

    client.closed = True
    capture_errors: list[str] = []
    result = case.call(
        client,
        lambda *_args, **_kwargs: response,
        on_capture_error=lambda error: capture_errors.append(str(error)),
    )
    test.assertIs(result, response)
    test.assertEqual(getattr(response, case.status_attribute), case.status)
    test.assertEqual(len(capture_errors), 1)
    test.assertIn("client is already shut down", capture_errors[0])
