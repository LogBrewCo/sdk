from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.request import urlopen

from django.core.exceptions import ImproperlyConfigured
from django.test import Client, override_settings
from logbrew_django import get_logbrew_config
from logbrew_sdk import HttpTransport, RecordingTransport, SdkError, TransportResponse
from test_django_integration import make_client, setup_django


class CustomTransport:
    def __init__(self, status_code: int = 202) -> None:
        self.status_code = status_code
        self.bodies: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.bodies.append(body)
        return TransportResponse(status_code=self.status_code, attempts=1)


class DjangoSettingsTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    def test_settings_http_transport_delivers_to_local_receiver(self) -> None:
        received: list[dict[str, object]] = []
        authorized: list[bool] = []

        class Intake(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                authorized.append(self.headers.get("Authorization") == "Bearer LOGBREW_API_KEY")
                length = int(self.headers.get("Content-Length", "0"))
                received.append(json.loads(self.rfile.read(length)))
                self.send_response(202 if authorized[-1] else 401)
                self.end_headers()

            def do_GET(self) -> None:
                body = json.dumps(received).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: object) -> None:
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Intake) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                sdk_client = make_client()
                transport = HttpTransport(endpoint=f"http://127.0.0.1:{server.server_port}/intake", timeout=2)
                with patch.dict("logbrew_django._configured_state", {}, clear=True), override_settings(
                    LOGBREW_CLIENT=sdk_client, LOGBREW_TRANSPORT=transport,
                    LOGBREW_CAPTURE_REQUEST_METRICS=True,
                ):
                    self.assertIs(get_logbrew_config().transport, transport)
                    response = Client().get("/orders/42/?private=query", HTTP_AUTHORIZATION="application-auth-value")
                with urlopen(f"http://127.0.0.1:{server.server_port}/readback", timeout=2) as result:
                    readback = json.loads(result.read())
            finally:
                server.shutdown()
                thread.join(timeout=2)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(authorized, [True])
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(received), 1)
        self.assertEqual(readback, received)
        payload = readback[0]
        self.assertEqual([event["type"] for event in payload["events"]], ["span", "metric"])
        span, metric = [event["attributes"] for event in payload["events"]]
        self.assertEqual(span["name"], "GET /orders/<int:order_id>/")
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        for marker in ["LOGBREW_API_KEY", "application-auth-value", "/orders/42", "private=query"]:
            self.assertNotIn(marker, json.dumps(payload))

    def test_settings_accept_custom_transport_protocol(self) -> None:
        transport = CustomTransport()
        sdk_client = make_client()
        with patch.dict("logbrew_django._configured_state", {}, clear=True), override_settings(
            LOGBREW_CLIENT=sdk_client, LOGBREW_TRANSPORT=transport,
        ):
            self.assertIs(get_logbrew_config().transport, transport)
            self.assertEqual(Client().get("/health/").status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.bodies), 1)

    def test_settings_rejection_retains_events_without_breaking_response(self) -> None:
        sdk_client = make_client()
        transport = CustomTransport(status_code=401)
        with patch.dict("logbrew_django._configured_state", {}, clear=True), override_settings(
            LOGBREW_CLIENT=sdk_client, LOGBREW_TRANSPORT=transport,
        ):
            self.assertEqual(Client().get("/health/").status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 1)

    def test_settings_flush_error_opt_in_still_raises(self) -> None:
        sdk_client = make_client()
        with patch.dict("logbrew_django._configured_state", {}, clear=True), override_settings(
            LOGBREW_CLIENT=sdk_client, LOGBREW_TRANSPORT=CustomTransport(status_code=401),
            LOGBREW_RAISE_FLUSH_ERRORS=True,
        ), self.assertRaises(SdkError):
            Client().get("/health/")
        self.assertEqual(sdk_client.pending_events(), 1)

    def test_settings_preserve_no_transport_default_and_recording_transport(self) -> None:
        sdk_client = make_client()
        with patch.dict("logbrew_django._configured_state", {}, clear=True), override_settings(
            LOGBREW_CLIENT=sdk_client, LOGBREW_TRANSPORT=None,
        ):
            self.assertIsNone(get_logbrew_config().transport)
            self.assertEqual(Client().get("/health/").status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 1)

        transport = RecordingTransport.always_accept()
        with patch.dict("logbrew_django._configured_state", {}, clear=True), override_settings(
            LOGBREW_CLIENT=sdk_client, LOGBREW_TRANSPORT=transport,
        ):
            self.assertIs(get_logbrew_config().transport, transport)

    def test_settings_reject_transport_without_callable_send(self) -> None:
        for transport in [object(), type("InvalidTransport", (), {"send": "invalid"})()]:
            with self.subTest(transport_type=type(transport).__name__), patch.dict(
                "logbrew_django._configured_state", {}, clear=True,
            ), override_settings(LOGBREW_CLIENT=make_client(), LOGBREW_TRANSPORT=transport), self.assertRaises(
                ImproperlyConfigured,
            ):
                get_logbrew_config()
