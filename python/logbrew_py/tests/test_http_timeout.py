from __future__ import annotations

import unittest
from typing import cast
from urllib.request import Request

from logbrew_sdk import HttpTransport, SdkError
from test_sdk import StubHttpResponse


class HttpTimeoutTests(unittest.TestCase):
    def test_invalid_timeout_is_a_configuration_error_before_delivery(self) -> None:
        for timeout in (float("nan"), float("inf"), float("-inf"), 1 << 10000, 0, -1, True, "1"):
            with self.subTest(kind=type(timeout).__name__):
                with self.assertRaises(SdkError) as caught:
                    HttpTransport(timeout=cast(float, timeout), open_url=lambda request, **kwargs: None)
                self.assertEqual(caught.exception.code, "configuration_error")

    def test_valid_seconds_reach_the_transport_unchanged(self) -> None:
        for timeout in (0.01, 2, 10.0):
            with self.subTest(timeout=timeout):
                self.check_valid_timeout(timeout)

    def check_valid_timeout(self, seconds: float) -> None:
        seen: list[float] = []
        response = StubHttpResponse(202)

        def open_url(request: Request, *, timeout: float) -> StubHttpResponse:
            seen.append(timeout)
            return response

        transport = HttpTransport(timeout=seconds, open_url=open_url)
        self.assertEqual(transport.send("lb_test_key", "{}").status_code, 202)
        self.assertEqual(seen, [seconds])
        self.assertTrue(response.closed)
