from __future__ import annotations

import json
import unittest

from django.test import Client, override_settings
from logbrew_django import configure_logbrew
from logbrew_sdk import RecordingTransport
from test_django_integration import make_client, setup_django, streamed


class DjangoServiceNameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    def test_configured_service_name_labels_request_events(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(
            client=sdk_client, transport=transport, service_name="checkout", capture_request_metrics=True,
        )
        response = Client().get("/health/")
        self.assertEqual(response.status_code, 200)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span", "metric"])
        for event in payload["events"]:
            self.assertEqual(event["attributes"]["metadata"]["service"], "checkout")

    def test_configured_service_name_labels_exception_and_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport, service_name="checkout")
        response = Client(raise_request_exception=False).get("/boom/")
        self.assertEqual(response.status_code, 500)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span"])
        for event in payload["events"]:
            self.assertEqual(event["attributes"]["metadata"]["service"], "checkout")

    def test_default_service_name_is_django(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=sdk_client, transport=transport)
        with override_settings(MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"]):
            response = Client().get("/health/")
        self.assertEqual(response.status_code, 200)
        attributes = json.loads(transport.sent_bodies[0])["events"][0]["attributes"]
        self.assertEqual(attributes["metadata"]["service"], "django")

    def test_stream_completion_retains_configured_service(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        configure_logbrew(
            client=sdk_client, transport=transport, service_name="checkout", capture_request_metrics=True,
        )
        with override_settings(ROOT_URLCONF="test_django_streaming"):
            response = Client().get("/streams/42/")
            self.assertEqual(transport.sent_bodies, [])
            self.assertEqual(b"".join(streamed(response)), b"first last")
        events = json.loads(transport.sent_bodies[0])["events"]
        self.assertEqual([event["type"] for event in events[-2:]], ["span", "metric"])
        for event in events[-2:]:
            self.assertEqual(event["attributes"]["metadata"]["service"], "checkout")
