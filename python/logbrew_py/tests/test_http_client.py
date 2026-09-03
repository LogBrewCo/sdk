from __future__ import annotations

import asyncio
import importlib
import json
import unittest
from functools import partial
from itertools import product
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import http_span_contract as http_contract
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
    requests_request_with_logbrew_span,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class HttpxSpanTests(unittest.TestCase):
    def test_optional_http_dependencies_preserve_selection_and_errors(self) -> None:
        for operation, dependency in (
            (requests_request_with_logbrew_span, "requests"),
            (httpx_request_with_logbrew_span, "httpx"),
        ):
            with self.subTest(dependency=dependency):
                client = sample_client()
                request = Mock(return_value=SimpleNamespace(status_code=204))
                call = partial(
                    operation, "GET", "https://example.test/", client=client,
                    event_id="evt_dependency_selection",
                )

                with patch("logbrew_sdk._http_client.import_module") as importer:
                    importer.return_value = SimpleNamespace(request=request)
                    self.assertIs(call(), request.return_value)
                    importer.assert_called_once_with(dependency)
                    self.assertEqual(request.call_args.args, ("GET", "https://example.test/"))
                    self.assertIn("traceparent", request.call_args.kwargs["headers"])
                    self.assertEqual(len(json.loads(client.preview_json())["events"]), 1)
                    importer.reset_mock()
                    for explicit in ({"request": request}, {"session": SimpleNamespace(request=request)}):
                        self.assertIs(
                            call(**explicit), request.return_value,
                        )
                    importer.assert_not_called()
                    prior_events = client.preview_json()
                    missing = ImportError("dependency unavailable")
                    cases: tuple[tuple[Any, ...], ...] = (
                        (None, missing, {}, ImportError,
                         f"{dependency}_request_with_logbrew_span requires {dependency} to be installed "
                         "or a request callable/session"),
                        (SimpleNamespace(request=None), None, {}, TypeError, f"{dependency}.request must be callable"),
                        (None, None, {"request": request, "session": object()}, TypeError,
                         "pass either request or session, not both"),
                        (None, None, {"session": object()}, TypeError,
                         f"{dependency} session must expose a callable request method"),
                    )
                    for module, error, overrides, expected_type, message in cases:
                        with self.subTest(message=message):
                            importer.reset_mock()
                            importer.return_value, importer.side_effect = module, error
                            with self.assertRaises(expected_type) as raised:
                                call(**overrides)
                            self.assertEqual(str(raised.exception), message)
                            self.assertIs(raised.exception.__cause__, error)
                            self.assertEqual(client.preview_json(), prior_events)
                            if overrides:
                                importer.assert_not_called()
                            else:
                                importer.assert_called_once_with(dependency)

    def test_httpx_request_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        http_contract.assert_success(
            self,
            sample_client(),
            http_contract.HttpSpanCase(
                operation=httpx_request_with_logbrew_span,
                source="httpx",
                status=202,
                span_id="b7ad6b7169203337",
                method="put",
                duration_ms=61.0,
                timeout=4.5,
            ),
        )

    def test_httpx_request_with_logbrew_span_preserves_errors_and_capture_failures(self) -> None:
        http_contract.assert_failure(
            self,
            sample_client(),
            http_contract.HttpSpanCase(
                operation=httpx_request_with_logbrew_span,
                source="httpx",
                status=502,
                span_id="b7ad6b7169203338",
            ),
        )

    def test_async_httpx_request_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        http_contract.assert_success(
            self,
            sample_client(),
            http_contract.HttpSpanCase(
                operation=async_httpx_request_with_logbrew_span,
                source="httpx.async",
                status=204,
                span_id="b7ad6b7169203340",
                method="delete",
                duration_ms=74.0,
                timeout=5.5,
                asynchronous=True,
            ),
        )


class HttpClientInstrumentationTests(unittest.TestCase):
    def test_instrumentation_registry_handles_missing_or_replaced_marker(self) -> None:
        class SlottedSession:
            __slots__ = ("_request", "request")

        for factory, marker, method in (
            (instrument_requests_session_with_logbrew_spans, "_logbrew_requests_session_instrumentation", "request"),
            (instrument_httpx_client_with_logbrew_spans, "_logbrew_httpx_client_instrumentation", "request"),
            (instrument_aiohttp_client_session_with_logbrew_spans,
             "_logbrew_aiohttp_client_session_instrumentation", "_request"),
        ):
            for session_type, replace_request in product((SlottedSession, SimpleNamespace), (False, True)):
                with self.subTest(factory=factory.__name__, session=session_type.__name__, replace=replace_request):
                    session = session_type()
                    original = AsyncMock() if method == "_request" else Mock()
                    setattr(session, method, original)
                    client = sample_client()
                    instrumentation = factory(session, client=client)
                    if isinstance(session, SimpleNamespace):
                        setattr(session, marker, "another owner's marker")
                    self.assertIs(factory(session, client=client), instrumentation)
                    self.assertIsNot(getattr(session, method), original)
                    expected = Mock() if replace_request else original
                    if replace_request:
                        setattr(session, method, expected)
                    instrumentation.uninstall()
                    self.assertIs(getattr(session, method), expected)
                    if isinstance(session, SimpleNamespace):
                        self.assertEqual(getattr(session, marker), "another owner's marker")
                    replacement = factory(session, client=client)
                    self.assertIsNot(replacement, instrumentation)
                    replacement.uninstall()

    def test_aiohttp_request_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        http_contract.assert_success(
            self,
            sample_client(),
            http_contract.HttpSpanCase(
                operation=aiohttp_request_with_logbrew_span,
                source="aiohttp",
                status=202,
                span_id="b7ad6b7169203347",
                method="post",
                duration_ms=44.0,
                asynchronous=True,
                status_attribute="status",
                explicit_trace=True,
            ),
        )

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
                calls[-1]["activeTrace"] = get_active_logbrew_trace()
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
        self.assertEqual(getattr(calls[0]["activeTrace"], "span_id", None), "b7ad6b7169203342")
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
        self.assertIsNone(calls[-1]["activeTrace"])

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
                self.calls[-1]["activeTrace"] = get_active_logbrew_trace()
                return StubResponse()

        class StubAsyncHttpxClient:
            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            async def request(self, method: str, url: str, **kwargs: object) -> StubResponse:
                self.calls.append({"method": method, "url": url, **kwargs})
                self.calls[-1]["activeTrace"] = get_active_logbrew_trace()
                return StubResponse()

        async def run() -> None:
            sync_client = StubHttpxClient()
            async_client = StubAsyncHttpxClient()
            sync_instrumentation = instrument_httpx_client_with_logbrew_spans(
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
            self.assertEqual(getattr(sync_client.calls[0]["activeTrace"], "span_id", None), "b7ad6b7169203345")
            self.assertEqual(getattr(async_client.calls[0]["activeTrace"], "span_id", None), "b7ad6b7169203346")
            self.assertEqual(
                sync_client.calls[0]["headers"]["traceparent"],  # type: ignore[index]
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203345-00",
            )
            self.assertEqual(
                async_client.calls[0]["headers"]["traceparent"],  # type: ignore[index]
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203346-00",
            )
            sync_instrumentation.uninstall()
            async_instrumentation.uninstall()
            self.assertFalse(sync_instrumentation.installed)
            self.assertFalse(async_instrumentation.installed)
            sync_client.request("GET", "https://api.example.test/after-uninstall")
            await async_client.request("GET", "https://api.example.test/after-uninstall")
            self.assertNotIn("headers", sync_client.calls[-1])
            self.assertNotIn("headers", async_client.calls[-1])
            self.assertIsNone(sync_client.calls[-1]["activeTrace"])
            self.assertIsNone(async_client.calls[-1]["activeTrace"])

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
        http_contract.assert_failure(
            self,
            sample_client(),
            http_contract.HttpSpanCase(
                operation=async_httpx_request_with_logbrew_span,
                source="httpx.async",
                status=504,
                span_id="b7ad6b7169203341",
                asynchronous=True,
                error_message="async connection failed for redacted-url",
            ),
        )


class AiohttpIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        try:
            self.aiohttp = importlib.import_module("aiohttp")
            self.web = importlib.import_module("aiohttp.web")
            self.test_utils = importlib.import_module("aiohttp.test_utils")
        except ImportError:
            self.skipTest("aiohttp is not installed")

    async def test_real_requests_preserve_trace_errors_privacy_and_uninstall(
        self,
    ) -> None:
        aiohttp, web, test_utils = self.aiohttp, self.web, self.test_utils
        received: list[dict[str, str | None]] = []

        async def record(request: Any) -> Any:
            received.append(
                {
                    "caller": request.headers.get("x-caller"),
                    "traceparent": request.headers.get("traceparent"),
                }
            )
            if request.path.startswith("/failures/"):
                return web.Response(status=503, text="private upstream body")
            return web.Response(status=204 if request.path == "/after-uninstall" else 202)

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", record)
        client = sample_client()
        event_ids = iter(["evt_python_aiohttp_client", "evt_python_aiohttp_failure"])
        span_ids = iter(["b7ad6b7169203342", "b7ad6b7169203343"])
        clock_values = iter([80.0, 80.031, 81.0, 81.012])
        options: dict[str, Any] = {
            "client": client,
            "event_id_factory": lambda: next(event_ids),
            "span_id_factory": lambda: next(span_ids),
            "clock": lambda: next(clock_values),
            "timestamp": "2026-07-04T09:00:11Z",
            "trace": LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736", span_id="00f067aa0ba902b7", sampled=True
            ),
            "route_template_resolver": lambda _method, url: (
                "/failures/:failure_id" if "/failures/" in url else "/payments/:payment_id"
            ),
            "metadata": {
                "service": "checkout",
                "headers": {"authorization": "private"},
            },
        }
        async with (
            test_utils.TestServer(app) as server,
            aiohttp.ClientSession() as session,
        ):
            instrumentation = instrument_aiohttp_client_session_with_logbrew_spans(session, **options)
            self.assertIs(
                instrument_aiohttp_client_session_with_logbrew_spans(session, client=client),
                instrumentation,
            )
            async with session.get(
                str(server.make_url("/payments/123?coupon=summer#receipt")),
                headers={"Traceparent": "spoofed", "x-caller": "checkout"},
            ) as response:
                self.assertEqual(response.status, 202)
                await response.read()
            self.assertEqual(
                received[-1],
                {
                    "caller": "checkout",
                    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203342-01",
                },
            )
            instrumentation.uninstall()
            self.assertFalse(instrumentation.installed)
            async with session.get(str(server.make_url("/after-uninstall"))) as response:
                self.assertEqual(response.status, 204)
                await response.read()
            self.assertIsNone(received[-1]["traceparent"])
            instrumentation = instrument_aiohttp_client_session_with_logbrew_spans(session, **options)
            with self.assertRaises(aiohttp.ClientResponseError) as raised:
                await session.get(
                    str(server.make_url("/failures/123?debug=redacted")),
                    raise_for_status=True,
                )
            self.assertEqual(raised.exception.status, 503)
            instrumentation.uninstall()
            self.assertFalse(instrumentation.installed)
        events = json.loads(client.preview_json())["events"]
        self.assertEqual(len(events), 2)
        self.assertEqual([event["type"] for event in events], ["span", "span"])
        success, failure = (event["attributes"] for event in events)
        self.assertEqual(success["spanId"], "b7ad6b7169203342")
        self.assertEqual(success["metadata"]["method"], "GET")
        self.assertEqual(success["metadata"]["routeTemplate"], "/payments/:payment_id")
        self.assertEqual(failure["metadata"]["errorType"], "ClientResponseError")
        self.assertEqual(failure["metadata"]["statusCode"], 503)
        self.assertNotIn("errorMessage", failure["metadata"])
        for forbidden in (
            "coupon=summer",
            "debug=redacted",
            "authorization",
            "private upstream body",
            "Traceparent",
            "traceparent",
            "spoofed",
        ):
            self.assertNotIn(forbidden, client.preview_json())
