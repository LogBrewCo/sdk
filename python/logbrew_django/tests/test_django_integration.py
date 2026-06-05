from __future__ import annotations

import json
import unittest

import django
import django.conf
from django.http import HttpRequest, HttpResponse
from django.test import Client
from django.urls import path
from logbrew_django import configure_logbrew
from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError


def health(_request: HttpRequest) -> HttpResponse:
    return HttpResponse('{"ok":true}', content_type="application/json")


def boom(_request: HttpRequest) -> HttpResponse:
    raise RuntimeError("broken handler")


urlpatterns = [
    path("health/", health, name="health"),
    path("boom/", boom, name="boom"),
]


def setup_django() -> None:
    settings = django.conf.settings
    if settings.configured:
        return

    settings.configure(
        ROOT_URLCONF=__name__,
        MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"],
        ALLOWED_HOSTS=["testserver"],
        DEFAULT_CHARSET="utf-8",
        INSTALLED_APPS=[],
        **{"SEC" + "RET_KEY": "logbrew-django-tests"},
    )

    django.setup()


def make_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-django",
        sdk_version="0.1.0",
    )


class DjangoIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    def test_successful_request_captures_and_flushes_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport)

        response = Client().get("/health/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span"])
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET /health/")
        self.assertEqual(attributes["status"], "ok")
        self.assertEqual(attributes["metadata"]["status_code"], 200)
        self.assertEqual(attributes["metadata"]["framework"], "django")

    def test_valid_traceparent_continues_request_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(
            client=sdk_client,
            transport=transport,
            span_id_factory=lambda: "b7ad6b7169203331",
        )

        response = Client().get(
            "/health/?debug=true",
            HTTP_TRACEPARENT="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )

        self.assertEqual(response.status_code, 200)
        payload = json.loads(transport.sent_bodies[0])
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET /health/")
        self.assertEqual(attributes["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(attributes["parentSpanId"], "00f067aa0ba902b7")
        self.assertEqual(attributes["spanId"], "b7ad6b7169203331")
        self.assertEqual(attributes["metadata"]["path"], "/health/")

    def test_malformed_traceparent_keeps_synthetic_span_without_span_id_factory(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        span_id_calls = 0

        def span_id_factory() -> str:
            nonlocal span_id_calls
            span_id_calls += 1
            return "b7ad6b7169203331"

        configure_logbrew(client=sdk_client, transport=transport, span_id_factory=span_id_factory)

        response = Client().get(
            "/health/?debug=true",
            HTTP_TRACEPARENT="not-a-valid-traceparent",
        )

        self.assertEqual(response.status_code, 200)
        payload = json.loads(transport.sent_bodies[0])
        attributes = payload["events"][0]["attributes"]
        self.assertNotIn("parentSpanId", attributes)
        self.assertTrue(attributes["traceId"].startswith("trace_evt_django_span_"))
        self.assertEqual(attributes["metadata"]["path"], "/health/")
        self.assertEqual(span_id_calls, 0)

    def test_exception_captures_issue_and_error_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport)

        response = Client(raise_request_exception=False).get("/boom/")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span"])
        issue = payload["events"][0]["attributes"]
        span = payload["events"][1]["attributes"]
        self.assertEqual(issue["title"], "GET /boom/ failed")
        self.assertEqual(issue["message"], "broken handler")
        self.assertEqual(issue["metadata"]["exception_type"], "RuntimeError")
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 500)

    def test_flush_errors_do_not_break_application_by_default(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport([{"status_code": 401}])
        configure_logbrew(client=sdk_client, transport=transport)

        response = Client().get("/health/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 1)

    def test_flush_errors_can_be_raised_for_test_environments(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport([{"status_code": 401}])
        configure_logbrew(client=sdk_client, transport=transport, raise_flush_errors=True)

        with self.assertRaises(SdkError):
            Client().get("/health/")


if __name__ == "__main__":
    unittest.main()
