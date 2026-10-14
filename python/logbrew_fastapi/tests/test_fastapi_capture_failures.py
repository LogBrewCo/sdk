from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import AsyncIterator
from unittest.mock import patch

from fastapi import BackgroundTasks, FastAPI
from logbrew_fastapi import LogBrewFastAPIMiddleware
from logbrew_sdk import (
    RecordingTransport,
    SdkError,
    TransportResponse,
    create_logbrew_trace_context,
    get_active_logbrew_trace,
    use_logbrew_trace,
)
from starlette.responses import StreamingResponse
from starlette.types import Message
from test_fastapi_integration import make_client


class FailingTransport:
    def send(self, api_key: str, body: str) -> TransportResponse:
        raise RuntimeError("private transport failure")


def failed_response_app(stage: str, failure: RuntimeError) -> FastAPI:
    app = FastAPI()

    async def body() -> AsyncIterator[bytes]:
        yield b"first"
        raise failure

    @app.get("/health")
    async def health() -> StreamingResponse:
        if stage == "view":
            raise failure
        return StreamingResponse(body())

    return app


async def run_request(middleware: LogBrewFastAPIMiddleware, messages: list[Message]) -> None:
    received = False
    disconnected = asyncio.Event()

    async def receive() -> Message:
        nonlocal received
        if received:
            await disconnected.wait()
        received = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        messages.append(message)

    await middleware({
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": "GET", "scheme": "http", "path": "/health",
        "raw_path": b"/health", "root_path": "", "query_string": b"", "headers": [],
        "server": ("testserver", 80), "client": ("127.0.0.1", 12345),
    }, receive, send)


class FastAPICaptureFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_success_survives_each_capture_failure(self) -> None:
        for method in ["span", "metric"]:
            with self.subTest(method=method):
                client = make_client()
                transport = RecordingTransport.always_accept()
                app = FastAPI()

                async def body() -> AsyncIterator[bytes]:
                    yield b"first "
                    yield b"last"

                @app.get("/health")
                async def health() -> StreamingResponse:
                    return StreamingResponse(body())

                middleware = LogBrewFastAPIMiddleware(
                    app, client=client, transport=transport, capture_request_metrics=True,
                )
                messages: list[Message] = []
                outer = create_logbrew_trace_context()
                with use_logbrew_trace(outer), patch.object(
                    client, method, side_effect=SdkError("queue_full", "capture unavailable"),
                ):
                    await run_request(middleware, messages)
                    self.assertIs(get_active_logbrew_trace(), outer)
                self.assertIsNone(get_active_logbrew_trace())
                self.assertEqual(messages[0]["status"], 200)
                self.assertEqual(b"".join(message.get("body", b"") for message in messages), b"first last")
                events = json.loads(transport.sent_bodies[0])["events"]
                self.assertEqual([event["type"] for event in events], ["metric" if method == "span" else "span"])

    async def test_background_error_survives_each_capture_failure(self) -> None:
        for method in ["issue", "span", "metric"]:
            with self.subTest(method=method):
                client = make_client()
                transport = RecordingTransport.always_accept()
                app = FastAPI()
                failure = RuntimeError("private background failure")

                def fail(error: RuntimeError = failure) -> None:
                    raise error

                @app.get("/health")
                async def health(tasks: BackgroundTasks) -> dict[str, bool]:
                    tasks.add_task(fail)
                    return {"ok": True}

                middleware = LogBrewFastAPIMiddleware(
                    app, client=client, transport=transport, capture_request_metrics=True,
                )
                messages: list[Message] = []
                outer = create_logbrew_trace_context()
                with use_logbrew_trace(outer), patch.object(
                    client, method, side_effect=SdkError("queue_full", "capture unavailable"),
                ):
                    with self.assertRaises(RuntimeError) as raised:
                        await run_request(middleware, messages)
                    self.assertIs(raised.exception, failure)
                    self.assertIs(get_active_logbrew_trace(), outer)
                self.assertIsNone(get_active_logbrew_trace())
                self.assertEqual(messages[0]["status"], 200)
                events = json.loads(transport.sent_bodies[0])["events"]
                self.assertEqual([event["type"] for event in events], [
                    kind for kind in ["issue", "span", "metric"] if kind != method
                ])
                for event in events:
                    metadata = event["attributes"]["metadata"]
                    status = metadata["statusCode"] if event["type"] == "metric" else metadata["status_code"]
                    self.assertEqual(status, 200)
                self.assertNotIn("private background failure", json.dumps(events))

    async def test_delivery_error_opt_in_preserves_original_background_error(self) -> None:
        client = make_client()
        transport = RecordingTransport([{"status_code": 401}])
        app = FastAPI()
        failure = RuntimeError("private background failure")

        def fail() -> None:
            raise failure

        @app.get("/health")
        async def health(tasks: BackgroundTasks) -> dict[str, bool]:
            tasks.add_task(fail)
            return {"ok": True}

        middleware = LogBrewFastAPIMiddleware(
            app, client=client, transport=transport, capture_request_metrics=True, raise_flush_errors=True,
        )
        messages: list[Message] = []
        outer = create_logbrew_trace_context()
        with use_logbrew_trace(outer):
            with self.assertRaises(RuntimeError) as raised:
                await run_request(middleware, messages)
            self.assertIs(raised.exception, failure)
            self.assertIs(get_active_logbrew_trace(), outer)
        self.assertIsNone(get_active_logbrew_trace())
        self.assertEqual(messages[0]["status"], 200)
        self.assertEqual(client.pending_events(), 3)
        events = json.loads(transport.sent_bodies[0])["events"]
        self.assertEqual([event["type"] for event in events], ["issue", "span", "metric"])
        issue, span, metric = [event["attributes"] for event in events]
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])

    async def test_unexpected_delivery_failure_preserves_success_by_default(self) -> None:
        client = make_client()
        app = FastAPI()

        @app.get("/health")
        async def health() -> dict[str, bool]:
            return {"ok": True}

        middleware = LogBrewFastAPIMiddleware(app, client=client, transport=FailingTransport())
        messages: list[Message] = []
        await run_request(middleware, messages)
        self.assertEqual(messages[0]["status"], 200)
        self.assertEqual(client.pending_events(), 1)
        self.assertIsNone(get_active_logbrew_trace())

    async def test_closed_client_preserves_stream_success(self) -> None:
        client = make_client()
        client.shutdown(RecordingTransport.always_accept())
        app = FastAPI()

        async def body() -> AsyncIterator[bytes]:
            yield b"complete"

        @app.get("/health")
        async def health() -> StreamingResponse:
            return StreamingResponse(body())

        middleware = LogBrewFastAPIMiddleware(
            app, client=client, transport=RecordingTransport.always_accept(), capture_request_metrics=True,
        )
        messages: list[Message] = []
        await run_request(middleware, messages)
        self.assertEqual(messages[0]["status"], 200)
        self.assertEqual(b"".join(message.get("body", b"") for message in messages), b"complete")
        self.assertIsNone(get_active_logbrew_trace())

    async def test_failed_response_keeps_original_view_and_stream_errors(self) -> None:
        for stage in ["view", "stream"]:
            with self.subTest(stage=stage):
                client = make_client()
                transport = RecordingTransport([{"status_code": 401}])
                failure = RuntimeError("private application failure")
                app = failed_response_app(stage, failure)

                middleware = LogBrewFastAPIMiddleware(
                    app, client=client, transport=transport, capture_request_metrics=True, raise_flush_errors=True,
                )
                messages: list[Message] = []
                outer = create_logbrew_trace_context()
                with use_logbrew_trace(outer), patch.object(
                    client, "issue", side_effect=SdkError("queue_full", "capture unavailable"),
                ):
                    with self.assertRaises(Exception) as raised:
                        await run_request(middleware, messages)
                    errors = [raised.exception]
                    while errors:
                        error = errors.pop()
                        if error is failure:
                            break
                        errors.extend(getattr(error, "exceptions", ()))
                    else:
                        self.fail("The original application exception was replaced")
                    self.assertIs(get_active_logbrew_trace(), outer)
                self.assertIsNone(get_active_logbrew_trace())
                self.assertEqual(messages[0]["status"], 500 if stage == "view" else 200)
                self.assertEqual(client.pending_events(), 2)
                events = json.loads(transport.sent_bodies[0])["events"]
                self.assertEqual([event["type"] for event in events], ["span", "metric"])
                span, metric = [event["attributes"] for event in events]
                self.assertEqual(span["status"], "error")
                self.assertEqual(span["metadata"]["status_code"], messages[0]["status"])
                self.assertEqual(metric["metadata"]["statusCode"], messages[0]["status"])
                self.assertEqual(metric["context"]["trace"]["spanId"], span["spanId"])
