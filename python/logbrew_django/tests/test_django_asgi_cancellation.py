from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import AsyncIterator, Mapping
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass, field

import django
from django.core.handlers.asgi import ASGIHandler
from django.http import HttpRequest, StreamingHttpResponse
from django.test import override_settings
from django.urls import path
from logbrew_django import configure_logbrew, get_logbrew_config, request_logbrew_trace
from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    RecordingTransport,
    get_active_logbrew_trace,
    use_logbrew_trace,
)
from test_django_integration import make_client, setup_django


@dataclass
class StreamActivity:
    waiting: asyncio.Event = field(default_factory=asyncio.Event)
    disconnect: asyncio.Event = field(default_factory=asyncio.Event)
    never: asyncio.Event = field(default_factory=asyncio.Event)
    finalizer_trace: LogBrewTraceContext | None = None
    response: StreamingHttpResponse | None = None
    request_trace: LogBrewTraceContext | None = None


_activity: ContextVar[StreamActivity | None] = ContextVar("django_asgi_stream_activity", default=None)


async def stream(request: HttpRequest) -> StreamingHttpResponse:
    activity = _activity.get()
    if activity is None:
        raise RuntimeError("Stream activity is not configured")
    activity.request_trace = request_logbrew_trace(request)
    client = get_logbrew_config().client

    async def body() -> AsyncIterator[bytes]:
        try:
            yield b"first"
            activity.waiting.set()
            await activity.never.wait()
        finally:
            await asyncio.sleep(0)
            trace = get_active_logbrew_trace()
            activity.finalizer_trace = trace
            if trace is not None:
                client.log("evt_asgi_stream_finalizer", "2026-10-04T00:00:00Z", {
                    "message": "Stream finalized", "level": "info",
                    "context": {"schemaVersion": 1, "trace": {
                        "traceId": trace.trace_id, "spanId": trace.span_id, "sampled": trace.sampled,
                    }},
                })

    response = StreamingHttpResponse(body())
    activity.response = response
    return response


urlpatterns = [path("stream/", stream)]


class DjangoASGICancellationTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    async def test_source_cancellation_finishes_and_flushes_under_request_trace(self) -> None:
        await self._check_cancellation(reject_delivery=False)

    async def test_delivery_error_opt_in_preserves_cancellation(self) -> None:
        await self._check_cancellation(reject_delivery=True)

    async def _check_cancellation(self, *, reject_delivery: bool) -> None:
        activity = StreamActivity()
        reset_handle = _activity.set(activity)
        client = make_client()
        transport = (
            RecordingTransport([{"status_code": 401}]) if reject_delivery else RecordingTransport.always_accept()
        )
        configure_logbrew(
            client=client, transport=transport, capture_request_metrics=True, raise_flush_errors=reject_delivery,
        )
        received = False
        messages: list[Mapping[str, object]] = []

        async def receive() -> dict[str, object]:
            nonlocal received
            if received:
                await activity.disconnect.wait()
                return {"type": "http.disconnect"}
            received = True
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message: Mapping[str, object]) -> None:
            messages.append(message)

        outer = LogBrewTraceContext("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7")
        with override_settings(ROOT_URLCONF=__name__), use_logbrew_trace(outer):
            task = asyncio.create_task(ASGIHandler()({
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": "GET", "scheme": "http", "path": "/stream/", "raw_path": b"/stream/",
                "root_path": "", "query_string": b"", "headers": [],
                "server": ("testserver", 80), "client": ("127.0.0.1", 12345),
            }, receive, send))
            try:
                await asyncio.wait_for(activity.waiting.wait(), 2)
                if django.VERSION < (5, 0):
                    # Django 4.2 leaves application cancellation to the ASGI server.
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    activity.disconnect.set()
                    await asyncio.wait_for(task, 2)
                self.assertIs(get_active_logbrew_trace(), outer)
            finally:
                if not task.done():
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
                _activity.reset(reset_handle)
        self.assertIsNone(get_active_logbrew_trace())
        self._assert_delivery(activity, client, transport, messages, reject_delivery=reject_delivery)

    def _assert_delivery(
        self,
        activity: StreamActivity,
        client: LogBrewClient,
        transport: RecordingTransport,
        messages: list[Mapping[str, object]],
        *,
        reject_delivery: bool,
    ) -> None:
        self.assertIs(activity.finalizer_trace, activity.request_trace)
        self.assertIsNotNone(activity.finalizer_trace)
        response = activity.response
        if response is None:
            self.fail("streaming response was not created")
        self.assertTrue(response.closed)
        self.assertEqual(messages[0]["status"], 200)
        self.assertEqual(len(transport.sent_bodies), 1)
        events = json.loads(transport.sent_bodies[0])["events"]
        self.assertEqual([event["type"] for event in events], ["log", "span", "metric"])
        log, span, metric = [event["attributes"] for event in events]
        self.assertEqual(log["context"]["trace"]["spanId"], span["spanId"])
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertEqual(client.pending_events(), 3 if reject_delivery else 0)
        response.close()
        self.assertEqual(len(transport.sent_bodies), 1)
