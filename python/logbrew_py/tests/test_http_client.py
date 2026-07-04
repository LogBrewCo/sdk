from __future__ import annotations

import asyncio
import json
import unittest

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    async_httpx_request_with_logbrew_span,
    get_active_logbrew_trace,
    httpx_request_with_logbrew_span,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class HttpxSpanTests(unittest.TestCase):
    def test_httpx_request_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        client = sample_client()
        request_active_trace: LogBrewTraceContext | None = None
        caller_headers = {"Traceparent": "spoofed", "x-caller": "checkout"}
        calls: list[dict[str, object]] = []
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([50.0, 50.061])

        class StubHttpxResponse:
            status_code = 202

        def request(method: str, url: str, **kwargs: object) -> StubHttpxResponse:
            nonlocal request_active_trace
            calls.append({"method": method, "url": url, **kwargs})
            request_active_trace = get_active_logbrew_trace()
            return StubHttpxResponse()

        with use_logbrew_trace(parent_trace):
            response = httpx_request_with_logbrew_span(
                "put",
                "https://api.example.test/payments/123?coupon=summer#receipt",
                client=client,
                event_id="evt_python_httpx_client",
                timestamp="2026-06-19T09:00:00Z",
                request=request,
                timeout=4.5,
                headers=caller_headers,
                json={"card": "private"},
                route_template="/payments/:payment_id",
                span_id_factory=lambda: "b7ad6b7169203337",
                clock=lambda: next(clock_values),
                metadata={"service": "checkout", "headers": {"authorization": "private"}},
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(caller_headers["Traceparent"], "spoofed")
        call = calls[0]
        self.assertEqual(call["method"], "put")
        self.assertEqual(call["url"], "https://api.example.test/payments/123?coupon=summer#receipt")
        self.assertEqual(call["timeout"], 4.5)
        sent_headers = call["headers"]
        self.assertIsInstance(sent_headers, dict)
        assert isinstance(sent_headers, dict)
        self.assertIsNot(sent_headers, caller_headers)
        self.assertEqual(sent_headers["x-caller"], "checkout")
        self.assertEqual(
            sent_headers["traceparent"],
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203337-01",
        )
        self.assertNotIn("Traceparent", sent_headers)
        self.assertEqual(
            request_active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203337",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "PUT /payments/:payment_id")
        self.assertEqual(event["attributes"]["durationMs"], 61.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "httpx")
        self.assertEqual(metadata["method"], "PUT")
        self.assertEqual(metadata["statusCode"], 202)
        serialized = client.preview_json()
        self.assertNotIn("coupon=summer", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("traceparent", serialized)
        self.assertNotIn("card", serialized)

    def test_httpx_request_with_logbrew_span_preserves_errors_and_capture_failures(self) -> None:
        client = sample_client()

        class StubHttpxResponse:
            status_code = 502

        class StubHttpxError(RuntimeError):
            def __init__(self) -> None:
                super().__init__("connection failed for redacted-url")
                self.response = StubHttpxResponse()

        original_error = StubHttpxError()

        with self.assertRaises(StubHttpxError) as raised:
            httpx_request_with_logbrew_span(
                "GET",
                "https://api.example.test/payments/123?coupon=summer",
                client=client,
                event_id="evt_python_httpx_failure",
                timestamp="2026-06-19T09:00:01Z",
                request=lambda _method, _url, **_kwargs: (_ for _ in ()).throw(original_error),
                span_id_factory=lambda: "b7ad6b7169203338",
                clock=lambda: 60.0,
            )

        self.assertIs(raised.exception, original_error)
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["source"], "httpx")
        self.assertEqual(event["attributes"]["metadata"]["statusCode"], 502)
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "StubHttpxError")
        serialized_failure = client.preview_json()
        self.assertNotIn("errorMessage", event["attributes"]["metadata"])
        self.assertNotIn("connection failed for redacted-url", serialized_failure)
        self.assertNotIn("coupon=summer", serialized_failure)

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        response = httpx_request_with_logbrew_span(
            "GET",
            "https://api.example.test/health",
            client=closed_client,
            event_id="evt_python_httpx_capture_error",
            timestamp="2026-06-19T09:00:02Z",
            request=lambda _method, _url, **_kwargs: StubHttpxResponse(),
            span_id_factory=lambda: "b7ad6b7169203339",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_async_httpx_request_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        async def run() -> None:
            client = sample_client()
            request_active_trace: LogBrewTraceContext | None = None
            caller_headers = {"Traceparent": "spoofed", "x-caller": "checkout"}
            calls: list[dict[str, object]] = []
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            clock_values = iter([70.0, 70.074])

            class StubHttpxResponse:
                status_code = 204

            async def request(method: str, url: str, **kwargs: object) -> StubHttpxResponse:
                nonlocal request_active_trace
                calls.append({"method": method, "url": url, **kwargs})
                request_active_trace = get_active_logbrew_trace()
                return StubHttpxResponse()

            with use_logbrew_trace(parent_trace):
                response = await async_httpx_request_with_logbrew_span(
                    "delete",
                    "https://api.example.test/payments/123?coupon=summer#receipt",
                    client=client,
                    event_id="evt_python_httpx_async_client",
                    timestamp="2026-06-19T09:00:03Z",
                    request=request,
                    timeout=5.5,
                    headers=caller_headers,
                    route_template="/payments/:payment_id",
                    span_id_factory=lambda: "b7ad6b7169203340",
                    clock=lambda: next(clock_values),
                    metadata={"service": "checkout", "headers": {"authorization": "private"}},
                )

            self.assertEqual(response.status_code, 204)
            self.assertEqual(caller_headers["Traceparent"], "spoofed")
            sent_headers = calls[0]["headers"]
            self.assertIsInstance(sent_headers, dict)
            assert isinstance(sent_headers, dict)
            self.assertEqual(
                sent_headers["traceparent"],
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203340-01",
            )
            self.assertEqual(
                request_active_trace,
                LogBrewTraceContext(
                    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                    span_id="b7ad6b7169203340",
                    parent_span_id="00f067aa0ba902b7",
                    sampled=True,
                ),
            )
            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["attributes"]["name"], "DELETE /payments/:payment_id")
            self.assertEqual(event["attributes"]["durationMs"], 74.0)
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["source"], "httpx.async")
            self.assertEqual(metadata["method"], "DELETE")
            self.assertEqual(metadata["statusCode"], 204)
            serialized = client.preview_json()
            self.assertNotIn("coupon=summer", serialized)
            self.assertNotIn("authorization", serialized)
            self.assertNotIn("traceparent", serialized)

        asyncio.run(run())

    def test_async_httpx_request_with_logbrew_span_preserves_errors_without_message_metadata(self) -> None:
        async def run() -> None:
            client = sample_client()

            class StubHttpxResponse:
                status_code = 504

            class StubHttpxError(RuntimeError):
                def __init__(self) -> None:
                    super().__init__("async connection failed for redacted-url")
                    self.response = StubHttpxResponse()

            original_error = StubHttpxError()

            async def request(_method: str, _url: str, **_kwargs: object) -> object:
                raise original_error

            with self.assertRaises(StubHttpxError) as raised:
                await async_httpx_request_with_logbrew_span(
                    "GET",
                    "https://api.example.test/payments/123?coupon=summer",
                    client=client,
                    event_id="evt_python_httpx_async_failure",
                    timestamp="2026-06-19T09:00:06Z",
                    request=request,
                    span_id_factory=lambda: "b7ad6b7169203341",
                    clock=lambda: 80.0,
                )

            self.assertIs(raised.exception, original_error)
            event = json.loads(client.preview_json())["events"][0]
            metadata = event["attributes"]["metadata"]
            self.assertEqual(event["attributes"]["status"], "error")
            self.assertEqual(metadata["source"], "httpx.async")
            self.assertEqual(metadata["statusCode"], 504)
            self.assertEqual(metadata["errorType"], "StubHttpxError")
            serialized_failure = client.preview_json()
            self.assertNotIn("errorMessage", metadata)
            self.assertNotIn("async connection failed for redacted-url", serialized_failure)
            self.assertNotIn("coupon=summer", serialized_failure)

        asyncio.run(run())
