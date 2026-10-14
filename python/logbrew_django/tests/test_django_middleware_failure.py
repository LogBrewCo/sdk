from __future__ import annotations

import json
import unittest
from collections.abc import Callable

from django.http import HttpRequest, HttpResponse
from django.test import Client, override_settings
from logbrew_django import LogBrewDjangoMiddleware, configure_logbrew
from logbrew_sdk import RecordingTransport
from test_django_integration import make_client, setup_django


class FailingMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.get_response(request)
        raise RuntimeError("private middleware failure")


class DjangoMiddlewareFailureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    def test_unhandled_middleware_failure_captures_correlated_issue(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport, capture_request_metrics=True)
        with override_settings(MIDDLEWARE=[
            "logbrew_django.LogBrewDjangoMiddleware", f"{__name__}.FailingMiddleware",
        ]):
            response = Client(raise_request_exception=False).get(
                "/orders/42/?private=query",
                HTTP_TRACEPARENT="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            )
        self.assertEqual(response.status_code, 500)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span", "metric"])
        issue, span, metric = [event["attributes"] for event in payload["events"]]
        self.assertEqual(issue["exception"]["type"], "RuntimeError")
        self.assertEqual(issue["title"], "GET /orders/<int:order_id>/ failed")
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertEqual(span["status"], "error")
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        for marker in ["private middleware failure", "/orders/42", "private=query"]:
            self.assertNotIn(marker, json.dumps(payload))

    def test_unhandled_middleware_failure_respects_capture_opt_out(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport, capture_exceptions=False)
        with override_settings(MIDDLEWARE=[
            "logbrew_django.LogBrewDjangoMiddleware", f"{__name__}.FailingMiddleware",
        ]):
            self.assertEqual(Client(raise_request_exception=False).get("/health/").status_code, 500)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span"])

    def test_signal_receiver_ignores_uninstrumented_request(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport)
        middleware = LogBrewDjangoMiddleware(lambda request: HttpResponse())
        with override_settings(MIDDLEWARE=[f"{__name__}.FailingMiddleware"]):
            self.assertEqual(Client(raise_request_exception=False).get("/health/").status_code, 500)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(transport.sent_bodies, [])
        self.assertIsNotNone(middleware)

    def test_view_failure_is_captured_once(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport)
        with override_settings(MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"]):
            self.assertEqual(Client(raise_request_exception=False).get("/boom/").status_code, 500)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span"])
