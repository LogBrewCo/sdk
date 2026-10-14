from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import Awaitable, Callable

from asgiref.sync import markcoroutinefunction
from django.http import HttpRequest, HttpResponse
from django.test import AsyncClient, override_settings
from logbrew_django import configure_logbrew, get_active_logbrew_trace
from logbrew_sdk import RecordingTransport
from test_django_integration import make_client, setup_django


class AsyncFailingMiddleware:
    sync_capable = False
    async_capable = True

    def __init__(self, get_response: Callable[[HttpRequest], Awaitable[HttpResponse]]) -> None:
        self.get_response = get_response
        markcoroutinefunction(self)

    async def __call__(self, request: HttpRequest) -> HttpResponse:
        await self.get_response(request)
        raise RuntimeError("private asynchronous middleware failure")


class AsyncSelectiveMiddleware(AsyncFailingMiddleware):
    async def __call__(self, request: HttpRequest) -> HttpResponse:
        response = await self.get_response(request)
        await asyncio.sleep(0)
        if request.path == "/orders/1/":
            raise RuntimeError("private asynchronous middleware failure")
        return response


class DjangoAsyncMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    async def test_async_middleware_failure_is_captured_and_context_reset(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport, capture_request_metrics=True)
        with override_settings(MIDDLEWARE=[
            "logbrew_django.LogBrewDjangoMiddleware", f"{__name__}.AsyncFailingMiddleware",
        ]):
            response = await AsyncClient(raise_request_exception=False).get("/health/")
        self.assertEqual(response.status_code, 500)
        self.assertIsNone(get_active_logbrew_trace())
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span", "metric"])
        issue, span, metric = [event["attributes"] for event in payload["events"]]
        self.assertEqual(issue["exception"]["type"], "RuntimeError")
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        self.assertNotIn("private asynchronous middleware failure", json.dumps(payload))

    async def test_overlapping_success_and_failure_keep_separate_traces(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport, capture_request_metrics=True)
        failed_trace = "4bf92f3577b34da6a3ce929d0e0e4736"
        successful_trace = "2bf92f3577b34da6a3ce929d0e0e4736"
        with override_settings(MIDDLEWARE=[
            "logbrew_django.LogBrewDjangoMiddleware", f"{__name__}.AsyncSelectiveMiddleware",
        ]):
            failed, successful = await asyncio.gather(
                AsyncClient(raise_request_exception=False).get(
                    "/orders/1/", headers={"traceparent": f"00-{failed_trace}-00f067aa0ba902b7-01"},
                ),
                AsyncClient(raise_request_exception=False).get(
                    "/orders/2/", headers={"traceparent": f"00-{successful_trace}-00f067aa0ba902b7-01"},
                ),
            )
        self.assertEqual((failed.status_code, successful.status_code), (500, 200))
        self.assertIsNone(get_active_logbrew_trace())
        events = [event for body in transport.sent_bodies for event in json.loads(body)["events"]]
        issues = [event["attributes"] for event in events if event["type"] == "issue"]
        spans = {event["attributes"]["traceId"]: event["attributes"] for event in events if event["type"] == "span"}
        self.assertEqual(len(events), 5)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["metadata"]["traceId"], failed_trace)
        self.assertEqual(issues[0]["metadata"]["spanId"], spans[failed_trace]["spanId"])
        self.assertEqual(spans[failed_trace]["status"], "error")
        self.assertEqual(spans[successful_trace]["status"], "ok")
        for event in events:
            if event["type"] == "metric":
                trace = event["attributes"]["context"]["trace"]
                self.assertEqual(trace["spanId"], spans[trace["traceId"]]["spanId"])
