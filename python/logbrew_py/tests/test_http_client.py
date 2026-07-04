from __future__ import annotations

import asyncio
import json
import unittest

from logbrew_sdk import (
    LogBrewAiohttpClientSessionInstrumentation,
    LogBrewClient,
    LogBrewTraceContext,
    aiohttp_request_with_logbrew_span,
    async_httpx_request_with_logbrew_span,
    get_active_logbrew_trace,
    httpx_request_with_logbrew_span,
    instrument_aiohttp_client_session_with_logbrew_spans,
    instrument_httpx_client_with_logbrew_spans,
    instrument_requests_session_with_logbrew_spans,
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


class HttpClientInstrumentationTests(unittest.TestCase):
    def test_aiohttp_request_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        client = sample_client()
        caller_headers = {"Traceparent": "spoofed", "x-caller": "checkout"}
        calls: list[dict[str, object]] = []
        request_active_trace: LogBrewTraceContext | None = None
        clock_values = iter([80.0, 80.044])
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )

        class StubAiohttpResponse:
            status = 202

        async def request(method: str, url: str, **kwargs: object) -> StubAiohttpResponse:
            nonlocal request_active_trace
            calls.append({"method": method, "url": url, **kwargs})
            request_active_trace = get_active_logbrew_trace()
            return StubAiohttpResponse()

        async def run() -> None:
            nonlocal request_active_trace
            response = await aiohttp_request_with_logbrew_span(
                "post",
                "https://api.example.test/payments/123?coupon=summer#receipt",
                client=client,
                event_id="evt_python_aiohttp_client",
                timestamp="2026-07-04T09:00:02Z",
                request=request,
                timeout=3.5,
                headers=caller_headers,
                json={"card": "sensitive"},
                trace=parent_trace,
                route_template="/payments/:payment_id",
                span_id_factory=lambda: "b7ad6b7169203347",
                clock=lambda: next(clock_values),
                metadata={"service": "checkout", "headers": {"authorization": "sensitive"}},
            )

            self.assertEqual(response.status, 202)
            self.assertEqual(caller_headers["Traceparent"], "spoofed")
            self.assertEqual(
                request_active_trace,
                LogBrewTraceContext(
                    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                    span_id="b7ad6b7169203347",
                    parent_span_id="00f067aa0ba902b7",
                    sampled=True,
                ),
            )
            call = calls[0]
            self.assertEqual(call["method"], "post")
            self.assertEqual(call["url"], "https://api.example.test/payments/123?coupon=summer#receipt")
            self.assertEqual(call["timeout"], 3.5)
            sent_headers = call["headers"]
            self.assertIsInstance(sent_headers, dict)
            assert isinstance(sent_headers, dict)
            self.assertEqual(sent_headers["x-caller"], "checkout")
            self.assertEqual(
                sent_headers["traceparent"],
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203347-01",
            )
            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["attributes"]["name"], "POST /payments/:payment_id")
            self.assertEqual(event["attributes"]["durationMs"], 44.0)
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["source"], "aiohttp")
            self.assertEqual(metadata["method"], "POST")
            self.assertEqual(metadata["statusCode"], 202)
            serialized = client.preview_json()
            self.assertNotIn("coupon=summer", serialized)
            self.assertNotIn("authorization", serialized)
            self.assertNotIn("traceparent", serialized)
            self.assertNotIn("card", serialized)

        asyncio.run(run())

    def test_aiohttp_client_session_instrumentation_traces_request_and_uninstalls(self) -> None:
        client = sample_client()
        calls: list[dict[str, object]] = []
        event_ids = iter(["evt_python_aiohttp_auto_get", "evt_python_aiohttp_after_uninstall"])
        span_ids = iter(["b7ad6b7169203348", "b7ad6b7169203349"])
        clock_values = iter([120.0, 120.039])

        class StubAiohttpResponse:
            status = 204

        class StubAiohttpClientSession:
            async def _request(self, method: str, url: str, **kwargs: object) -> StubAiohttpResponse:
                calls.append({"method": method, "url": url, **kwargs})
                return StubAiohttpResponse()

            async def get(self, url: str, **kwargs: object) -> StubAiohttpResponse:
                return await self._request("GET", url, **kwargs)

        session = StubAiohttpClientSession()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=False,
        )

        instrumentation = instrument_aiohttp_client_session_with_logbrew_spans(
            session,
            client=client,
            event_id_factory=lambda: next(event_ids),
            timestamp="2026-07-04T09:00:03Z",
            trace=parent_trace,
            metadata={"service": "checkout", "headers": {"authorization": "sensitive"}},
            route_template_resolver=lambda _method, _url: "/payments/:payment_id",
            span_id_factory=lambda: next(span_ids),
            clock=lambda: next(clock_values),
        )
        duplicate = instrument_aiohttp_client_session_with_logbrew_spans(session, client=client)

        async def run() -> None:
            response = await session.get(
                "https://api.example.test/payments/123?coupon=summer#receipt",
                headers={"Traceparent": "spoofed"},
                json={"card": "sensitive"},
            )

            self.assertIs(duplicate, instrumentation)
            self.assertIsInstance(instrumentation, LogBrewAiohttpClientSessionInstrumentation)
            self.assertTrue(instrumentation.installed)
            self.assertEqual(response.status, 204)
            sent_headers = calls[0]["headers"]
            self.assertIsInstance(sent_headers, dict)
            assert isinstance(sent_headers, dict)
            self.assertEqual(
                sent_headers["traceparent"],
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203348-00",
            )
            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["id"], "evt_python_aiohttp_auto_get")
            self.assertEqual(event["attributes"]["name"], "GET /payments/:payment_id")
            self.assertEqual(event["attributes"]["durationMs"], 39.0)
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["source"], "aiohttp")
            self.assertEqual(metadata["method"], "GET")
            self.assertEqual(metadata["statusCode"], 204)
            serialized = client.preview_json()
            self.assertNotIn("coupon=summer", serialized)
            self.assertNotIn("authorization", serialized)
            self.assertNotIn("traceparent", serialized)
            self.assertNotIn("card", serialized)

            instrumentation.uninstall()
            self.assertFalse(instrumentation.installed)
            await session.get("https://api.example.test/after-uninstall")
            self.assertEqual(len(json.loads(client.preview_json())["events"]), 1)
            self.assertNotIn("headers", calls[-1])

        asyncio.run(run())

    def test_aiohttp_client_session_instrumentation_preserves_errors_without_message_metadata(self) -> None:
        client = sample_client()

        class StubResponse:
            status = 502

        class StubAiohttpError(RuntimeError):
            def __init__(self) -> None:
                super().__init__("upstream failed with sensitive-auth-value")
                self.status = StubResponse.status

        class StubAiohttpClientSession:
            async def _request(self, _method: str, _url: str, **_kwargs: object) -> object:
                raise original_error

        original_error = StubAiohttpError()
        session = StubAiohttpClientSession()
        instrument_aiohttp_client_session_with_logbrew_spans(
            session,
            client=client,
            event_id_factory=lambda: "evt_python_aiohttp_auto_failure",
            timestamp="2026-07-04T09:00:04Z",
            span_id_factory=lambda: "b7ad6b7169203350",
            clock=lambda: 130.0,
        )

        async def run() -> None:
            with self.assertRaises(StubAiohttpError) as raised:
                await session._request("GET", "https://api.example.test/payments/123?auth=hidden")

            self.assertIs(raised.exception, original_error)
            event = json.loads(client.preview_json())["events"][0]
            metadata = event["attributes"]["metadata"]
            self.assertEqual(event["attributes"]["status"], "error")
            self.assertEqual(metadata["source"], "aiohttp")
            self.assertEqual(metadata["statusCode"], 502)
            self.assertEqual(metadata["errorType"], "StubAiohttpError")
            serialized = client.preview_json()
            self.assertNotIn("errorMessage", metadata)
            self.assertNotIn("upstream failed with sensitive-auth-value", serialized)
            self.assertNotIn("auth=hidden", serialized)

        asyncio.run(run())

    def test_requests_session_instrumentation_traces_requests_and_uninstalls(self) -> None:
        client = sample_client()
        caller_headers = {"Traceparent": "spoofed", "x-caller": "checkout"}
        calls: list[dict[str, object]] = []
        event_ids = iter(["evt_python_requests_auto_get", "evt_python_requests_after_uninstall"])
        span_ids = iter(["b7ad6b7169203342", "b7ad6b7169203343"])
        clock_values = iter([90.0, 90.035])

        class StubResponse:
            status_code = 201

        class StubRequestsSession:
            def request(self, method: str, url: str, **kwargs: object) -> StubResponse:
                calls.append({"method": method, "url": url, **kwargs})
                return StubResponse()

            def get(self, url: str, **kwargs: object) -> StubResponse:
                return self.request("GET", url, **kwargs)

        session = StubRequestsSession()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )

        instrumentation = instrument_requests_session_with_logbrew_spans(
            session,
            client=client,
            event_id_factory=lambda: next(event_ids),
            timestamp="2026-07-04T09:00:00Z",
            trace=parent_trace,
            metadata={"service": "checkout", "headers": {"authorization": "private"}},
            route_template_resolver=lambda _method, _url: "/payments/:payment_id",
            span_id_factory=lambda: next(span_ids),
            clock=lambda: next(clock_values),
        )
        duplicate = instrument_requests_session_with_logbrew_spans(session, client=client)

        response = session.get(
            "https://api.example.test/payments/123?coupon=summer#receipt",
            timeout=2.0,
            headers=caller_headers,
            json={"card": "private"},
        )

        self.assertIs(duplicate, instrumentation)
        self.assertTrue(instrumentation.installed)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(caller_headers["Traceparent"], "spoofed")
        sent_headers = calls[0]["headers"]
        self.assertIsInstance(sent_headers, dict)
        assert isinstance(sent_headers, dict)
        self.assertEqual(sent_headers["x-caller"], "checkout")
        self.assertEqual(
            sent_headers["traceparent"],
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203342-01",
        )
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["id"], "evt_python_requests_auto_get")
        self.assertEqual(event["attributes"]["name"], "GET /payments/:payment_id")
        self.assertEqual(event["attributes"]["durationMs"], 35.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "requests")
        self.assertEqual(metadata["method"], "GET")
        self.assertEqual(metadata["statusCode"], 201)
        serialized = client.preview_json()
        self.assertNotIn("coupon=summer", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("traceparent", serialized)
        self.assertNotIn("card", serialized)

        instrumentation.uninstall()
        self.assertFalse(instrumentation.installed)
        session.get("https://api.example.test/after-uninstall")
        self.assertEqual(len(json.loads(client.preview_json())["events"]), 1)
        self.assertNotIn("headers", calls[-1])

    def test_requests_session_instrumentation_preserves_errors_without_message_metadata(self) -> None:
        client = sample_client()

        class StubResponse:
            status_code = 503

        class StubRequestsError(RuntimeError):
            def __init__(self) -> None:
                super().__init__("network failed with sensitive-auth-value")
                self.response = StubResponse()

        class StubRequestsSession:
            def request(self, _method: str, _url: str, **_kwargs: object) -> object:
                raise original_error

        original_error = StubRequestsError()
        session = StubRequestsSession()
        instrument_requests_session_with_logbrew_spans(
            session,
            client=client,
            event_id_factory=lambda: "evt_python_requests_auto_failure",
            timestamp="2026-07-04T09:00:01Z",
            span_id_factory=lambda: "b7ad6b7169203344",
            clock=lambda: 100.0,
        )

        with self.assertRaises(StubRequestsError) as raised:
            session.request("GET", "https://api.example.test/payments/123?auth=hidden")

        self.assertIs(raised.exception, original_error)
        event = json.loads(client.preview_json())["events"][0]
        metadata = event["attributes"]["metadata"]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(metadata["source"], "requests")
        self.assertEqual(metadata["statusCode"], 503)
        self.assertEqual(metadata["errorType"], "StubRequestsError")
        serialized = client.preview_json()
        self.assertNotIn("errorMessage", metadata)
        self.assertNotIn("network failed with sensitive-auth-value", serialized)
        self.assertNotIn("auth=hidden", serialized)

    def test_httpx_client_instrumentation_traces_sync_and_async_clients(self) -> None:
        client = sample_client()
        event_ids = iter(["evt_python_httpx_auto_sync", "evt_python_httpx_auto_async"])
        span_ids = iter(["b7ad6b7169203345", "b7ad6b7169203346"])
        clock_values = iter([110.0, 110.046, 111.0, 111.052])
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=False,
        )

        class StubResponse:
            status_code = 202

        class StubHttpxClient:
            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            def request(self, method: str, url: str, **kwargs: object) -> StubResponse:
                self.calls.append({"method": method, "url": url, **kwargs})
                return StubResponse()

        class StubAsyncHttpxClient:
            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            async def request(self, method: str, url: str, **kwargs: object) -> StubResponse:
                self.calls.append({"method": method, "url": url, **kwargs})
                return StubResponse()

        async def run() -> None:
            sync_client = StubHttpxClient()
            async_client = StubAsyncHttpxClient()
            instrument_httpx_client_with_logbrew_spans(
                sync_client,
                client=client,
                event_id_factory=lambda: next(event_ids),
                timestamp="2026-07-04T09:00:02Z",
                trace=parent_trace,
                route_template_resolver=lambda method, _url: f"/{method.lower()}/:id",
                span_id_factory=lambda: next(span_ids),
                clock=lambda: next(clock_values),
            )
            async_instrumentation = instrument_httpx_client_with_logbrew_spans(
                async_client,
                client=client,
                event_id_factory=lambda: next(event_ids),
                timestamp="2026-07-04T09:00:03Z",
                trace=parent_trace,
                route_template_resolver=lambda method, _url: f"/{method.lower()}/:id",
                span_id_factory=lambda: next(span_ids),
                clock=lambda: next(clock_values),
            )

            sync_response = sync_client.request(
                "POST",
                "https://api.example.test/payments/123?coupon=summer",
                headers={"traceparent": "spoofed"},
            )
            async_response = await async_client.request(
                "DELETE",
                "https://api.example.test/refunds/456?coupon=summer",
                headers={"x-caller": "checkout"},
            )

            self.assertTrue(async_instrumentation.installed)
            self.assertEqual(sync_response.status_code, 202)
            self.assertEqual(async_response.status_code, 202)
            self.assertEqual(
                sync_client.calls[0]["headers"]["traceparent"],  # type: ignore[index]
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203345-00",
            )
            self.assertEqual(
                async_client.calls[0]["headers"]["traceparent"],  # type: ignore[index]
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203346-00",
            )

        asyncio.run(run())

        events = json.loads(client.preview_json())["events"]
        self.assertEqual(
            [event["id"] for event in events],
            ["evt_python_httpx_auto_sync", "evt_python_httpx_auto_async"],
        )
        self.assertEqual(events[0]["attributes"]["name"], "POST /post/:id")
        self.assertEqual(events[1]["attributes"]["name"], "DELETE /delete/:id")
        self.assertEqual(events[0]["attributes"]["metadata"]["source"], "httpx")
        self.assertEqual(events[1]["attributes"]["metadata"]["source"], "httpx.async")
        serialized = client.preview_json()
        self.assertNotIn("coupon=summer", serialized)
        self.assertNotIn("spoofed", serialized)

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
