from __future__ import annotations

import asyncio
import json
import logging
import unittest
from collections.abc import AsyncIterator, Iterator
from typing import cast

from django.http import HttpRequest, StreamingHttpResponse
from django.test import AsyncClient, Client, override_settings
from django.urls import path
from logbrew_django import configure_logbrew, get_active_logbrew_trace, get_logbrew_config
from logbrew_sdk import (
    LogBrewLoggingHandler,
    RecordingTransport,
    cache_operation_with_logbrew_span,
    create_logbrew_trace_context,
    use_logbrew_trace,
)
from test_django_integration import async_streamed, make_client, setup_django, streamed


def stream(request: HttpRequest, stream_id: int) -> StreamingHttpResponse:
    def body() -> Iterator[bytes]:
        try:
            logger = logging.getLogger("django.stream")
            logger.info("stream started")
            yield b"first "
            if request.GET.get("fail"):
                raise RuntimeError("private body failure")
            client = request.META["stream.client"]
            cache_operation_with_logbrew_span(
                "GET inventory", client=client, event_id="evt_django_stream_cache",
                operation=lambda: True, system="memory-cache", cache_name="inventory-cache", cache_hit=True,
            )
            yield b"last"
        finally:
            logging.getLogger("django.stream").info("stream closed")

    request.META["stream.client"] = get_logbrew_config().client
    return StreamingHttpResponse(body())


def async_stream(request: HttpRequest, stream_id: int) -> StreamingHttpResponse:
    async def body() -> AsyncIterator[bytes]:
        try:
            logging.getLogger("django.stream").info("async stream started")
            yield b"first "
            if request.GET.get("fail"):
                raise RuntimeError("private async body failure")
            yield b"last"
        finally:
            logging.getLogger("django.stream").info("async stream closed")

    return StreamingHttpResponse(body())


urlpatterns = [
    path("streams/<int:stream_id>/", stream),
    path("async-streams/<int:stream_id>/", async_stream),
]


class DjangoStreamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    def setUp(self) -> None:
        self.settings_override = override_settings(ROOT_URLCONF=__name__)
        self.settings_override.enable()
        self.client = make_client()
        self.transport = RecordingTransport.always_accept()
        configure_logbrew(client=self.client, transport=self.transport, capture_request_metrics=True)
        self.logger = logging.getLogger("django.stream")
        self.logger.handlers = []
        self.logger.propagate = False
        self.logger.setLevel(logging.INFO)
        self.handler = LogBrewLoggingHandler(self.client)
        self.logger.addHandler(self.handler)

    def tearDown(self) -> None:
        self.logger.removeHandler(self.handler)
        self.settings_override.disable()

    def test_stream_is_lazy_and_children_share_request_trace(self) -> None:
        response = Client().get("/streams/42/?private=query")
        self.assertEqual(self.transport.sent_bodies, [])
        outer = create_logbrew_trace_context()
        with use_logbrew_trace(outer):
            self.assertEqual(b"".join(streamed(response)), b"first last")
            self.assertIs(get_active_logbrew_trace(), outer)
        response.close()
        self.assertEqual(len(self.transport.sent_bodies), 1)
        payload = json.loads(self.transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "span", "log", "span", "metric"])
        log, child, close_log, span, metric = [event["attributes"] for event in payload["events"]]
        self.assertEqual(child["parentSpanId"], span["spanId"])
        self.assertEqual(child["traceId"], span["traceId"])
        for captured in [log, close_log, metric]:
            self.assertEqual(captured["context"]["trace"]["spanId"], span["spanId"])
        self.assertNotEqual(span["spanId"], outer.span_id)
        self.assertNotIn("/streams/42", json.dumps(payload))
        self.assertNotIn("private", json.dumps(payload))
        self.assertIsNone(get_active_logbrew_trace())

    def test_late_failure_keeps_sent_status_and_redacts_issue(self) -> None:
        response = Client().get("/streams/42/?fail=true")
        with self.assertRaisesRegex(RuntimeError, "private body failure"):
            b"".join(streamed(response))
        response.close()
        self.assertEqual(len(self.transport.sent_bodies), 1)
        payload = json.loads(self.transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "log", "issue", "span", "metric"])
        issue, span, metric = [event["attributes"] for event in payload["events"][-3:]]
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertEqual(issue["metadata"]["status_code"], 200)
        self.assertEqual(metric["metadata"]["statusCode"], 200)
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertNotIn("private body failure", json.dumps(payload))
        self.assertNotIn("fail=true", json.dumps(payload))
        self.assertIsNone(get_active_logbrew_trace())

    def test_partial_close_captures_finalizer_once_and_resets_trace(self) -> None:
        response = Client().get("/streams/42/")
        iterator = iter(streamed(response))
        outer = create_logbrew_trace_context()
        with use_logbrew_trace(outer):
            self.assertEqual(next(iterator), b"first ")
            self.assertIs(get_active_logbrew_trace(), outer)
            response.close()
            self.assertIs(get_active_logbrew_trace(), outer)
        response.close()
        self.assertEqual(len(self.transport.sent_bodies), 1)
        payload = json.loads(self.transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "log", "span", "metric"])
        close_log, span, metric = [event["attributes"] for event in payload["events"][-3:]]
        self.assertEqual(close_log["metadata"]["spanId"], span["spanId"])
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        self.assertIsNone(get_active_logbrew_trace())

    def test_close_before_iteration_finishes_once_without_consuming_body(self) -> None:
        response = Client().get("/streams/42/")
        self.assertEqual(self.transport.sent_bodies, [])
        response.close()
        response.close()
        self.assertEqual(len(self.transport.sent_bodies), 1)
        payload = json.loads(self.transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span", "metric"])

    def test_async_stream_success_resets_context_between_chunks(self) -> None:
        async def consume() -> None:
            response = await AsyncClient().get("/async-streams/42/?private=query")
            self.assertTrue(cast("StreamingHttpResponse", response).is_async)
            self.assertEqual(self.transport.sent_bodies, [])
            outer = create_logbrew_trace_context()
            with use_logbrew_trace(outer):
                chunks = []
                async for chunk in async_streamed(response):
                    self.assertIs(get_active_logbrew_trace(), outer)
                    chunks.append(chunk)
                self.assertEqual(b"".join(chunks), b"first last")
                self.assertIs(get_active_logbrew_trace(), outer)
            response.close()

        asyncio.run(consume())
        self.assertEqual(len(self.transport.sent_bodies), 1)
        payload = json.loads(self.transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "log", "span", "metric"])
        log, close_log, span, metric = [event["attributes"] for event in payload["events"]]
        for captured in [log, close_log, metric]:
            self.assertEqual(captured["context"]["trace"]["spanId"], span["spanId"])
        self.assertNotIn("/async-streams/42", json.dumps(payload))
        self.assertNotIn("private", json.dumps(payload))

    def test_async_stream_failure_is_correlated_and_redacted(self) -> None:
        async def consume() -> None:
            response = await AsyncClient().get("/async-streams/42/?fail=true")
            with self.assertRaisesRegex(RuntimeError, "private async body failure"):
                async for _chunk in async_streamed(response):
                    pass
            response.close()

        asyncio.run(consume())
        self.assertEqual(len(self.transport.sent_bodies), 1)
        payload = json.loads(self.transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "log", "issue", "span", "metric"])
        issue, span, metric = [event["attributes"] for event in payload["events"][-3:]]
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        self.assertNotIn("private async body failure", json.dumps(payload))
