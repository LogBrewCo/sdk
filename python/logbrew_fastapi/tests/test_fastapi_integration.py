from __future__ import annotations

import json
import logging
import re
import unittest
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from unittest.mock import Mock

from fastapi import BackgroundTasks, FastAPI, Request, Response, WebSocket
from fastapi.testclient import TestClient
from logbrew_fastapi import (
    LogBrewFastAPIMiddleware,
    add_logbrew_middleware,
    create_request_trace_context,
    get_active_logbrew_trace,
    init_logbrew,
)
from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    SdkError,
    cache_operation_with_logbrew_span,
)
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import StreamingResponse


def make_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-fastapi",
        sdk_version="0.1.0",
    )


def isolated_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.handlers = []
    logger.propagate = False
    logger.setLevel(logging.INFO)
    return logger


class FastAPIIntegrationTests(unittest.TestCase):
    def test_existing_dispatch_subclass_keeps_its_hook_and_request_capture(self) -> None:
        class CustomMiddleware(LogBrewFastAPIMiddleware):
            async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
                response = await super().dispatch(request, call_next)
                response.headers["x-custom-middleware"] = "active"
                return response

        self.assertTrue(issubclass(CustomMiddleware, BaseHTTPMiddleware))
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        app.add_middleware(CustomMiddleware, client=sdk_client, transport=transport, capture_request_metrics=True)

        @app.get("/health")
        async def health() -> dict[str, bool]:
            return {"ok": True}

        with TestClient(app) as http:
            response = http.get("/health")

        self.assertEqual(response.headers["x-custom-middleware"], "active")
        payload = json.loads(transport.sent_bodies[0])
        span, metric = [event["attributes"] for event in payload["events"]]
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])

    def test_dispatch_override_keeps_late_background_failure_capture(self) -> None:
        class CustomMiddleware(LogBrewFastAPIMiddleware):
            async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
                response = await super().dispatch(request, call_next)
                response.headers["x-custom-middleware"] = "active"
                return response

        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        app.add_middleware(CustomMiddleware, client=sdk_client, transport=transport, capture_request_metrics=True)

        def background() -> None:
            raise RuntimeError("private subclass background failure")

        @app.get("/background")
        async def endpoint(tasks: BackgroundTasks) -> dict[str, bool]:
            tasks.add_task(background)
            return {"ok": True}

        with TestClient(app) as http, self.assertRaises(RuntimeError):
            http.get("/background")

        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span", "metric"])
        issue, span, metric = [event["attributes"] for event in payload["events"]]
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        self.assertNotIn("private subclass background failure", json.dumps(payload))

    def test_dispatch_override_keeps_late_stream_failure_capture(self) -> None:
        calls = []

        class CustomMiddleware(LogBrewFastAPIMiddleware):
            async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
                calls.append("dispatch")
                return await super().dispatch(request, call_next)

        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        app.add_middleware(CustomMiddleware, client=sdk_client, transport=transport)

        async def body() -> AsyncIterator[bytes]:
            yield b"first"
            raise RuntimeError("private subclass stream failure")

        @app.get("/stream")
        async def stream() -> StreamingResponse:
            return StreamingResponse(body())

        with TestClient(app) as http, self.assertRaises(Exception) as raised:
            http.get("/stream")

        self.assertIn("private subclass stream failure", str(raised.exception) + repr(raised.exception))
        self.assertEqual(calls, ["dispatch"])
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span"])
        span = payload["events"][1]["attributes"]
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertNotIn("private subclass stream failure", json.dumps(payload))

    def test_websocket_scope_passes_through_without_http_capture(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.websocket("/socket")
        async def socket(websocket: WebSocket) -> None:
            await websocket.accept()
            self.assertIsNone(get_active_logbrew_trace())
            await websocket.send_text("ready")
            await websocket.close()

        with TestClient(app) as http, http.websocket_connect("/socket") as websocket:
            self.assertEqual(websocket.receive_text(), "ready")

        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(transport.sent_bodies, [])

    def test_background_failure_respects_exception_capture_opt_out(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(
            app, client=sdk_client, transport=transport,
            capture_exceptions=False, capture_request_metrics=True,
        )

        def background() -> None:
            raise RuntimeError("private background failure")

        @app.get("/background")
        async def endpoint(tasks: BackgroundTasks) -> dict[str, bool]:
            tasks.add_task(background)
            return {"ok": True}

        with TestClient(app) as http, self.assertRaises(RuntimeError):
            http.get("/background")

        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["metric"])
        self.assertEqual(payload["events"][0]["attributes"]["metadata"]["statusCode"], 200)
        self.assertNotIn("private background failure", json.dumps(payload))

    def test_stream_and_background_children_finish_before_request_flush(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        logger = isolated_logger("fastapi.stream")
        handler = LogBrewLoggingHandler(sdk_client)
        logger.addHandler(handler)
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport)
        traces = []

        def background() -> None:
            traces.append(get_active_logbrew_trace())
            logger.info("background complete")

        async def body() -> AsyncIterator[bytes]:
            yield b"first "
            traces.append(get_active_logbrew_trace())
            cache_operation_with_logbrew_span(
                "GET inventory",
                client=sdk_client,
                event_id="evt_fastapi_stream_cache",
                operation=lambda: True,
                system="memory-cache",
                cache_name="inventory-cache",
                cache_hit=True,
            )
            logger.info("stream complete")
            yield b"last"

        @app.get("/streams/{stream_id}")
        async def stream(stream_id: int, tasks: BackgroundTasks) -> StreamingResponse:
            tasks.add_task(background)
            return StreamingResponse(body(), background=tasks)

        try:
            with TestClient(app) as http:
                response = http.get(
                    "/streams/42",
                    headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
                )
        finally:
            logger.removeHandler(handler)

        self.assertEqual(response.content, b"first last")
        self.assertEqual(len(transport.sent_bodies), 1)
        self.assertEqual(sdk_client.pending_events(), 0)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span", "log", "log", "span"])
        child, stream_log, background_log, request = [event["attributes"] for event in payload["events"]]
        self.assertEqual(request["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(request["parentSpanId"], "00f067aa0ba902b7")
        self.assertEqual(request["status"], "ok")
        self.assertEqual(child["parentSpanId"], request["spanId"])
        self.assertEqual(child["traceId"], request["traceId"])
        for log in [stream_log, background_log]:
            self.assertEqual(log["metadata"]["spanId"], request["spanId"])
            self.assertEqual(log["metadata"]["traceId"], request["traceId"])
        self.assertEqual(len(traces), 2)
        self.assertTrue(all(trace is not None and trace.span_id == request["spanId"] for trace in traces))
        self.assertIsNone(get_active_logbrew_trace())

    def test_stream_failure_captures_issue_after_response_start(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(
            app, client=sdk_client, transport=transport, capture_request_metrics=True,
        )

        async def body() -> AsyncIterator[bytes]:
            yield b"first chunk"
            raise RuntimeError("private stream failure")

        @app.get("/streams/{stream_id}")
        async def stream(stream_id: int) -> StreamingResponse:
            return StreamingResponse(body())

        # Older Starlette releases propagate task-group failures as ExceptionGroup.
        with TestClient(app) as http, self.assertRaises(Exception) as raised:
            http.get("/streams/42?private=query")

        self.assertIn("private stream failure", str(raised.exception) + repr(raised.exception))

        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span", "metric"])
        issue, span, metric = [event["attributes"] for event in payload["events"]]
        self.assertEqual(span["name"], "GET /streams/{stream_id}")
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertEqual(metric["metadata"]["statusCode"], 200)
        self.assertEqual(metric["context"]["trace"]["traceId"], span["traceId"])
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
        self.assertEqual(issue["metadata"]["status_code"], 200)
        self.assertEqual(issue["metadata"]["traceId"], span["traceId"])
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertNotIn("private", json.dumps(payload))
        self.assertNotIn("/streams/42", json.dumps(payload))
        self.assertIsNone(get_active_logbrew_trace())

    def test_background_failure_logs_flush_with_the_request(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        logger = isolated_logger("fastapi.background")
        handler = LogBrewLoggingHandler(sdk_client)
        logger.addHandler(handler)
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        def background() -> None:
            logger.info("background started")
            raise RuntimeError("private background failure")

        @app.get("/background")
        async def endpoint(tasks: BackgroundTasks) -> dict[str, bool]:
            tasks.add_task(background)
            return {"ok": True}

        try:
            with TestClient(app) as http, self.assertRaises(RuntimeError):
                http.get("/background")
        finally:
            logger.removeHandler(handler)

        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "issue", "span"])
        log, issue, span = [event["attributes"] for event in payload["events"]]
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertEqual(log["metadata"]["spanId"], span["spanId"])
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertNotIn("private background failure", json.dumps(payload))
        self.assertIsNone(get_active_logbrew_trace())

    def test_init_logbrew_owns_capture_logging_and_shutdown_delivery(self) -> None:
        api_key = "project-key-must-not-appear"
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        runtime = init_logbrew(
            app,
            api_key=api_key,
            service_name="checkout-api",
            environment="development",
            transport=transport,
            automatic_delivery=False,
            span_id_factory=lambda: "b7ad6b7169203331",
        )
        logger = isolated_logger("fastapi.bootstrap")
        logger.addHandler(runtime.logging_handler)

        @app.get("/health")
        def health() -> dict[str, bool]:
            logger.info("health request")
            return {"ok": True}

        try:
            with TestClient(app) as http:
                response = http.get("/health")
        finally:
            logger.removeHandler(runtime.logging_handler)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(runtime.client.closed)
        self.assertEqual(runtime.delivery_health().lifecycle, "closed")
        self.assertEqual(runtime.shutdown_response.status_code, 202)
        self.assertEqual(runtime.shutdown_response.accepted_events, 2)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "span"])
        for event in payload["events"]:
            self.assertEqual(event["attributes"]["metadata"]["service"], "checkout-api")
            self.assertEqual(event["attributes"]["context"]["resource"]["deployment"]["environment"], "development")
        self.assertNotIn(api_key, repr(runtime))
        self.assertNotIn(api_key, json.dumps(payload))

    def test_init_logbrew_flushes_after_custom_lifespan_teardown(self) -> None:
        logger = isolated_logger("fastapi.custom-lifespan")

        @asynccontextmanager
        async def lifespan(_: FastAPI) -> AsyncIterator[None]:
            yield
            logger.info("custom lifespan stopped")

        transport = RecordingTransport.always_accept()
        app = FastAPI(lifespan=lifespan)
        runtime = init_logbrew(
            app,
            api_key="LOGBREW_API_KEY",
            service_name="lifespan-api",
            transport=transport,
            automatic_delivery=False,
        )
        logger.addHandler(runtime.logging_handler)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        try:
            with TestClient(app) as http:
                self.assertEqual(http.get("/health").status_code, 200)
        finally:
            logger.removeHandler(runtime.logging_handler)

        self.assertTrue(runtime.client.closed)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span", "log"])
        self.assertEqual(payload["events"][1]["attributes"]["message"], "custom lifespan stopped")

    def test_init_logbrew_defaults_to_http_background_delivery(self) -> None:
        app = FastAPI()
        runtime = init_logbrew(app, api_key="LOGBREW_API_KEY")

        self.assertIsInstance(runtime.transport, HttpTransport)
        self.assertTrue(runtime.delivery_health().automatic_delivery)
        self.assertEqual(runtime.delivery_health().lifecycle, "idle")
        self.assertEqual(runtime.shutdown().status_code, 204)
        self.assertEqual(runtime.shutdown().status_code, 204)

    def test_init_logbrew_rejects_duplicate_app_ownership(self) -> None:
        app = FastAPI()
        runtime = init_logbrew(
            app,
            api_key="LOGBREW_API_KEY",
            transport=RecordingTransport.always_accept(),
            automatic_delivery=False,
        )

        with self.assertRaisesRegex(SdkError, "already initialized"):
            init_logbrew(
                app,
                api_key="different-project-key",
                transport=RecordingTransport.always_accept(),
            )

        self.assertEqual(runtime.shutdown().status_code, 204)

    def test_shutdown_delivery_failure_is_visible_without_leaking_the_key(self) -> None:
        api_key = "project-key-must-not-appear"
        app = FastAPI()
        runtime = init_logbrew(
            app,
            api_key=api_key,
            transport=RecordingTransport([{"status_code": 401}]),
            automatic_delivery=False,
        )

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        with self.assertRaises(SdkError) as raised, TestClient(app) as http:
            self.assertEqual(http.get("/health").status_code, 200)

        self.assertEqual(raised.exception.code, "unauthenticated")
        self.assertEqual(runtime.shutdown_error_code, "unauthenticated")
        self.assertEqual(runtime.client.pending_events(), 1)
        self.assertNotIn(api_key, str(raised.exception))
        self.assertNotIn(api_key, repr(runtime))

    def test_shutdown_error_opt_out_retains_events_for_explicit_retry(self) -> None:
        app = FastAPI()
        runtime = init_logbrew(
            app,
            api_key="LOGBREW_API_KEY",
            transport=RecordingTransport([{"status_code": 401}, {"status_code": 202}]),
            automatic_delivery=False,
            raise_shutdown_errors=False,
        )

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        with TestClient(app) as http:
            self.assertEqual(http.get("/health").status_code, 200)

        self.assertFalse(runtime.client.closed)
        self.assertEqual(runtime.client.pending_events(), 1)
        self.assertEqual(runtime.shutdown_error_code, "unauthenticated")
        self.assertEqual(runtime.shutdown().status_code, 202)
        self.assertTrue(runtime.client.closed)

    def test_successful_request_captures_and_flushes_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        with TestClient(app) as http:
            response = http.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span"])
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET /health")
        self.assertEqual(attributes["status"], "ok")
        self.assertEqual(attributes["metadata"]["status_code"], 200)

    def test_request_metrics_can_be_captured_without_request_spans(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(
            app,
            client=sdk_client,
            transport=transport,
            capture_successful_requests=False,
            capture_request_metrics=True,
        )

        @app.get("/orders/{order_id}")
        def order_detail(order_id: int) -> dict[str, int]:
            return {"orderId": order_id}

        with TestClient(app) as http:
            response = http.get("/orders/42?debug=true#receipt")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["metric"])
        metric = payload["events"][0]["attributes"]
        self.assertEqual(metric["name"], "http.server.duration")
        self.assertEqual(metric["description"], "Duration of one completed server request.")
        self.assertEqual(metric["kind"], "histogram")
        self.assertGreaterEqual(metric["value"], 0)
        self.assertEqual(metric["unit"], "ms")
        self.assertEqual(metric["temporality"], "delta")
        metadata = metric["metadata"]
        self.assertEqual(metadata["framework"], "fastapi")
        self.assertEqual(metadata["method"], "GET")
        self.assertEqual(metadata["routeTemplate"], "/orders/{order_id}")
        self.assertEqual(metadata["statusCode"], 200)
        self.assertEqual(metadata["statusCodeClass"], "2xx")
        self.assertNotIn("debug", json.dumps(metadata))

    def test_valid_traceparent_continues_request_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(
            app,
            client=sdk_client,
            transport=transport,
            span_id_factory=lambda: "b7ad6b7169203331",
        )

        @app.get("/trace")
        def trace() -> dict[str, bool]:
            return {"ok": True}

        with TestClient(app) as http:
            response = http.get(
                "/trace?debug=true",
                headers={
                    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = json.loads(transport.sent_bodies[0])
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET /trace")
        self.assertEqual(attributes["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(attributes["parentSpanId"], "00f067aa0ba902b7")
        self.assertEqual(attributes["spanId"], "b7ad6b7169203331")
        self.assertEqual(attributes["metadata"]["path"], "/trace")

    def test_malformed_traceparent_uses_safe_local_trace_without_raw_header(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        span_id_calls = 0
        app = FastAPI()

        def span_id_factory() -> str:
            nonlocal span_id_calls
            span_id_calls += 1
            return "b7ad6b7169203331"

        add_logbrew_middleware(app, client=sdk_client, transport=transport, span_id_factory=span_id_factory)

        @app.get("/bad")
        def bad() -> dict[str, bool]:
            return {"ok": True}

        with TestClient(app) as http:
            response = http.get("/bad?debug=true", headers={"traceparent": "not-a-valid-traceparent"})

        self.assertEqual(response.status_code, 200)
        payload = json.loads(transport.sent_bodies[0])
        attributes = payload["events"][0]["attributes"]
        self.assertNotIn("parentSpanId", attributes)
        self.assertRegex(attributes["traceId"], re.compile(r"^[0-9a-f]{32}$"))
        self.assertEqual(attributes["spanId"], "b7ad6b7169203331")
        self.assertEqual(attributes["metadata"]["path"], "/bad")
        self.assertNotIn("traceparent", json.dumps(attributes))
        self.assertEqual(span_id_calls, 1)

    def test_handler_logs_share_active_request_trace(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        handler = LogBrewLoggingHandler(sdk_client, metadata={"service": "checkout"})
        logger = isolated_logger("fastapi.checkout")
        logger.addHandler(handler)
        app = FastAPI()
        add_logbrew_middleware(
            app,
            client=sdk_client,
            transport=transport,
            span_id_factory=lambda: "b7ad6b7169203331",
        )

        @app.get("/orders/{order_id}")
        async def order_detail(order_id: int) -> dict[str, object]:
            trace = get_active_logbrew_trace()
            logger.info("loading order", extra={"order_id": order_id})
            return {"traceId": trace.trace_id if trace else None, "spanId": trace.span_id if trace else None}

        try:
            with TestClient(app) as http:
                response = http.get(
                    "/orders/42?debug=true",
                    headers={
                        "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                    },
                )
        finally:
            logger.removeHandler(handler)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"traceId": "4bf92f3577b34da6a3ce929d0e0e4736", "spanId": "b7ad6b7169203331"})
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "span"])
        log = payload["events"][0]["attributes"]
        span = payload["events"][1]["attributes"]
        self.assertEqual(span["name"], "GET /orders/{order_id}")
        self.assertEqual(span["metadata"]["routeTemplate"], "/orders/{order_id}")
        self.assertEqual(log["metadata"]["traceId"], span["traceId"])
        self.assertEqual(log["metadata"]["spanId"], span["spanId"])
        self.assertEqual(log["metadata"]["parentSpanId"], span["parentSpanId"])
        self.assertIs(log["metadata"]["sampled"], True)
        self.assertNotIn("/orders/42", json.dumps(span))
        self.assertNotIn("debug", json.dumps(payload))

    def test_exception_captures_issue_and_error_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.get("/boom")
        def boom() -> dict[str, bool]:
            raise RuntimeError("broken handler")

        with TestClient(app, raise_server_exceptions=False) as http:
            response = http.get("/boom")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span"])
        issue = payload["events"][0]["attributes"]
        span = payload["events"][1]["attributes"]
        self.assertEqual(issue["title"], "GET /boom failed")
        self.assertEqual(issue["message"], "Unhandled exception")
        self.assertEqual(
            issue["exception"],
            {
                "type": "RuntimeError",
                "mechanism": {"type": "fastapi.middleware", "handled": False},
            },
        )
        self.assertEqual(issue["stackFrames"][0]["filename"], "test_fastapi_integration.py")
        self.assertEqual(issue["stackFrames"][0]["function"], "boom")
        self.assertEqual(issue["exceptionChain"]["entries"][0]["messageState"], "redacted")
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 500)
        self.assertEqual(issue["metadata"]["traceId"], span["traceId"])
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertNotIn("broken handler", json.dumps(payload))

        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.get("/orders/{order_id}/boom")
        def dynamic_order_boom(order_id: int) -> dict[str, int]:
            raise RuntimeError(f"broken order {order_id}")

        with TestClient(app, raise_server_exceptions=False) as http:
            response = http.get("/orders/42/boom?debug=true")

        self.assertEqual(response.status_code, 500)
        payload = json.loads(transport.sent_bodies[0])
        issue = payload["events"][0]["attributes"]
        span = payload["events"][1]["attributes"]
        self.assertEqual(issue["title"], "GET /orders/{order_id}/boom failed")
        self.assertEqual(span["name"], "GET /orders/{order_id}/boom")
        self.assertEqual(span["metadata"]["routeTemplate"], "/orders/{order_id}/boom")
        self.assertNotIn("/orders/42", json.dumps(payload))

    def test_flush_errors_do_not_break_application_by_default(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport([{"status_code": 401}])
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        with TestClient(app) as http:
            response = http.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 1)

    def test_flush_errors_can_be_raised_for_test_environments(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport([{"status_code": 401}])
        app = FastAPI()
        add_logbrew_middleware(app, client=sdk_client, transport=transport, raise_flush_errors=True)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        with TestClient(app) as http, self.assertRaises(SdkError):
            http.get("/health")


class RequestTraceFactoryTests(unittest.TestCase):
    """Keep valid inbound propagation separate from local factory failures."""

    def test_valid_header_does_not_retry_failed_span_factory(self) -> None:
        """Preserve the factory failure instead of silently creating another trace."""
        failure = SdkError("validation_error", "span factory failed")
        factory = Mock(side_effect=[failure, "b7ad6b7169203331"])
        request = Request({
            "type": "http",
            "headers": [(b"traceparent", b"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")],
        })
        with self.assertRaises(SdkError) as raised:
            create_request_trace_context(request, span_id_factory=factory)
        self.assertIs(raised.exception, failure)
        factory.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
