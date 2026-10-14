from __future__ import annotations

import io
import unittest
from urllib.error import HTTPError
from urllib.request import Request

from logbrew_sdk import HttpTransport, SdkError
from test_delivery import capture_log, create_client


class HttpErrorResponseTests(unittest.TestCase):
    def test_error_status_closes_response_without_reading_private_body(self) -> None:
        for status in (400, 401, 408, 429, 503):
            with self.subTest(status=status):
                self.check_error(status)

    def check_error(self, status: int) -> None:
        class UnreadableBody(io.BytesIO):
            def read(self, size: int = -1) -> bytes:
                raise AssertionError("error response body must not be read")

        body = UnreadableBody(b"private response body")
        error = HTTPError("https://example.com/events", status, "private reason", {}, body)

        def open_url(request: Request, *, timeout: float) -> object:
            raise error

        response = HttpTransport(open_url=open_url).send("lb_test_key", "{}")
        self.assertEqual(response.status_code, status)
        self.assertTrue(body.closed)
        self.assertNotIn("private", repr(response))

    def test_retry_closes_each_error_and_preserves_exact_event_body(self) -> None:
        failures: list[io.BytesIO] = []
        requests: list[bytes | None] = []

        def open_url(request: Request, *, timeout: float) -> object:
            requests.append(request.data)
            body = io.BytesIO(b"private response body")
            failures.append(body)
            raise HTTPError("https://example.com/events", 503, "private reason", {}, body)

        client = create_client(max_retries=1)
        capture_log(client, "evt_before", "before failure")
        with self.assertRaises(SdkError):
            client.flush(HttpTransport(open_url=open_url))
        self.assertEqual(client.pending_events(), 1)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0], requests[1])
        self.assertTrue(all(body.closed for body in failures))
