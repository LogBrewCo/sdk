# Copyright (c) 2026 LogBrew
"""Verify Flask capture, correlation, privacy, delivery, and request isolation."""

from __future__ import annotations

import json
import logging
import runpy
import sqlite3
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http import HTTPStatus
from importlib.metadata import version
from inspect import signature
from io import StringIO
from itertools import product
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, cast, get_type_hints
from unittest.mock import Mock, patch

from flask import Flask, Response, abort, stream_with_context
from logbrew_sdk import (
    LogBrewClient,
    LogBrewLoggingHandler,
    LogBrewTraceContext,
    RecordingTransport,
    SdkError,
    create_logbrew_trace_context,
    set_logbrew_user,
    use_logbrew_trace,
)
from typing_extensions import override
from werkzeug.test import EnvironBuilder

import logbrew_flask
from logbrew_flask import (
    LOGBREW_FLASK_SDK_VERSION,
    add_logbrew_middleware,
    create_request_trace_context,
    get_active_logbrew_trace,
    init_logbrew,
    request_logbrew_trace,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from unittest.mock import MagicMock

_ORDER_FAILURE = "private order failure"
_PREPARATION_FAILURE = "private preparation failure"
_RESPONSE_FAILURE = "private response failure"
_INNER_FAILURE = "inner request failed"
_CONTEXT_FAILURE = "not dispatched"
_DELIVERY_TIMEOUT = "timed out waiting for LogBrew delivery"


def _make_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-flask",
        sdk_version="0.1.0",
    )


def _wait_until(predicate: Callable[[], bool], *, timeout_seconds: float = 1.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError(_DELIVERY_TIMEOUT)
        time.sleep(0.01)


def configure_lifecycle_hooks(app: Flask, mode: str, status: int, clock: MagicMock, timestamp: MagicMock) -> None:
    """Install the application's controlled failure and response-processing hooks."""

    @app.after_request
    def finish(response: Response) -> Response:
        clock.return_value = 2.0
        timestamp.return_value = "2026-01-01T00:00:01.000Z"
        if mode == "after_request" and response.status_code == HTTPStatus.OK:
            raise RuntimeError(_RESPONSE_FAILURE)
        return response

    @app.before_request
    def prepare() -> Response | None:
        if mode == "before_response":
            return Response(status=202)
        if mode == "before_abort":
            abort(403)
        if mode == "before_exception":
            raise RuntimeError(_PREPARATION_FAILURE)
        return None

    @app.get("/orders/<int:order_id>")
    def order(order_id: int) -> dict[str, int]:
        clock.return_value = 1.5
        timestamp.return_value = "2026-01-01T00:00:00.500Z"
        if mode in {"unhandled", "handler", "propagated", "handled"}:
            raise RuntimeError(_ORDER_FAILURE)
        return {"id": order_id}

    if mode in {"handler", "handled"}:
        app.register_error_handler(
            500 if mode == "handler" else RuntimeError,
            lambda _error: ("unavailable", status),
        )


class _FlaskTestCase(unittest.TestCase):
    """Create an isolated application and check recorded delivery."""

    @override
    def setUp(self) -> None:
        self.sdk_client = _make_client()
        self.transport = RecordingTransport.always_accept()
        self.app = Flask(__name__)
        self.app.add_url_rule("/health", view_func=lambda: {"ok": True})

    def _recorded_batch(self, *kinds: str, client: LogBrewClient | None = None) -> dict[str, Any]:
        """Check delivery and event order before inspecting a recorded batch.

        Returns:
            The only recorded batch, after checking its event order.

        """
        self.assertEqual((self.sdk_client if client is None else client).pending_events(), 0)
        self.assertEqual(len(self.transport.sent_bodies), 1)
        payload = json.loads(self.transport.sent_bodies[0])
        if not isinstance(payload, dict):
            self.fail("recorded batch must be an object")
        self.assertEqual([event["type"] for event in payload["events"]], list(kinds))
        return payload


class FlaskIntegrationTests(_FlaskTestCase):
    """Exercise capture through Flask's dispatch and app-owned integrations."""

    def test_readme_requires_hosted_readback_for_end_to_end_confirmation(self) -> None:
        """Require a hosted investigation after local capture is demonstrated."""
        readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
        normalized_readme = " ".join(readme.split())

        for expected in (
            "logbrew status --json",
            "logbrew projects --json",
            "logbrew projects keys create '<project_id>'",
            "--project '<project_id>'",
            "--kind server",
            "logbrew read traces",
            "logbrew explain trace '<trace_id>' --json",
            "https://docs.logbrew.co/guides/flask",
        ):
            self.assertIn(expected, readme)

        self.assertIn(
            "It does not confirm that LogBrew accepted, stored, and indexed the event.",
            normalized_readme,
        )
        self.assertIn("never use the CLI account session for ingestion", normalized_readme)

    def test_public_call_contracts_and_runtime_annotations_remain_compatible(self) -> None:
        """Preserve released keyword-only APIs and runtime type-hint resolution."""
        signatures = {
            "init_logbrew": (
                "(app: 'Flask', *, api_key: 'str | None' = None, service_name: 'str | None' = None, "
                "environment: 'str | None' = None, release: 'str | None' = None, transport: 'Transport | None' = None, "
                "capture_successful_requests: 'bool' = True, capture_request_metrics: 'bool' = False, "
                "capture_exceptions: 'bool' = True, flush_on_response: 'bool' = False, "
                "raise_flush_errors: 'bool' = False, request_metric_name: 'str' = 'http.server.duration', "
                "span_id_factory: 'Callable[[], str] | None' = None) "
                "-> 'LogBrewFlaskConfig'"
            ),
            "add_logbrew_middleware": (
                "(app: 'Flask', *, client: 'LogBrewClient', transport: 'Transport | None' = None, "
                "capture_successful_requests: 'bool' = True, capture_request_metrics: 'bool' = False, "
                "capture_exceptions: 'bool' = True, flush_on_response: 'bool' = True, "
                "raise_flush_errors: 'bool' = False, "
                "service_name: 'str' = 'flask', request_metric_name: 'str' = 'http.server.duration', "
                "span_id_factory: 'Callable[[], str] | None' = None) -> 'LogBrewFlaskConfig'"
            ),
            "capture_request_metric": (
                "(client: 'LogBrewClient', *, status_code: 'int', duration_ms: 'float', event_id: 'str | None' = None, "
                "timestamp: 'str | None' = None, metric_name: 'str' = 'http.server.duration') -> 'str'"
            ),
            "capture_request_span": (
                "(client: 'LogBrewClient', *, status_code: 'int', duration_ms: 'float', event_id: 'str | None' = None, "
                "timestamp: 'str | None' = None, span_id_factory: 'Callable[[], str] | None' = None, "
                "trace: 'LogBrewTraceContext | None' = None) -> 'str'"
            ),
        }
        for name, expected in signatures.items():
            with self.subTest(api=name):
                function = getattr(logbrew_flask, name)
                self.assertEqual(str(signature(function)), expected)
                self.assertEqual(set(get_type_hints(function)), {*signature(function).parameters, "return"})
        self.assertEqual(
            set(get_type_hints(logbrew_flask.LogBrewFlaskConfig)),
            {
                "client",
                "transport",
                "capture_successful_requests",
                "capture_request_metrics",
                "capture_exceptions",
                "flush_on_response",
                "raise_flush_errors",
                "service_name",
                "request_metric_name",
                "span_id_factory",
            },
        )

    def test_packaged_examples_identify_the_installed_integration(self) -> None:
        """Bind examples to installed bytes without leaking logger or DB state."""
        logger = logging.getLogger("flask.checkout.example")
        handlers = [logging.NullHandler()]
        for name in ("readme_example", "real_user_smoke", "outbound_http", "dependency_spans"):
            with (
                self.subTest(example=name),
                redirect_stdout(StringIO()) as output,
                redirect_stderr(StringIO()),
                patch.multiple(logger, handlers=handlers, level=logging.WARNING, propagate=True),
            ):
                namespace = runpy.run_module(f"logbrew_flask.examples.{name}", run_name="__main__", alter_sys=True)
                self.assertIs(logger.handlers, handlers)
                self.assertEqual(logger.level, logging.WARNING)
                self.assertTrue(logger.propagate)
                self.assertEqual(
                    json.loads(output.getvalue())["sdk"],
                    {"name": "logbrew-flask", "language": "python", "version": version("logbrew-flask")},
                )
                if name == "dependency_spans":
                    with self.assertRaises(sqlite3.ProgrammingError):
                        namespace["database"].execute("SELECT 1")

    def test_init_logbrew_uses_app_configuration_and_delivers_in_background(self) -> None:
        """Resolve deployment settings and drain telemetry off the response path."""
        self.app = Flask("checkout_api")
        self.app.config.update(
            LOGBREW_SERVER_API_KEY="LOGBREW_SERVER_API_KEY",
            LOGBREW_SERVICE_NAME="checkout-api",
            LOGBREW_ENVIRONMENT="test",
            LOGBREW_RELEASE="checkout@1.2.3",
        )

        config = init_logbrew(self.app, transport=self.transport)
        self.assertIs(init_logbrew(self.app, transport=self.transport), config)
        self.assertEqual(LOGBREW_FLASK_SDK_VERSION, version("logbrew-flask"))

        @self.app.get("/orders/<int:order_id>")
        def order_detail(order_id: int) -> dict[str, int]:
            return {"orderId": order_id}

        response = self.app.test_client().get("/orders/42?private=drop")
        self.assertEqual(response.status_code, 200)
        _wait_until(lambda: len(self.transport.sent_bodies) == 1)

        payload = self._recorded_batch("span", client=config.client)
        event = payload["events"][0]
        self.assertEqual(event["attributes"]["name"], "GET /orders/<int:order_id>")
        resource = event["attributes"]["context"]["resource"]
        self.assertEqual(resource["service"]["name"], "checkout-api")
        self.assertEqual(resource["deployment"]["environment"], "test")
        self.assertEqual(resource["deployment"]["release"], "checkout@1.2.3")
        self.assertEqual(resource["framework"]["name"], "flask")
        self.assertNotIn("/orders/42", self.transport.sent_bodies[0])
        self.assertNotIn("private", self.transport.sent_bodies[0])
        config.client.shutdown()

    def test_init_logbrew_requires_a_server_ingest_key_without_reflecting_values(self) -> None:
        """Reject an empty key without placing its value in the error."""
        self.app.config["LOGBREW_SERVER_API_KEY"] = ""

        with self.assertRaises(SdkError) as raised:
            init_logbrew(self.app)

        self.assertEqual(raised.exception.code, "configuration_error")
        self.assertIn("LOGBREW_SERVER_API_KEY", str(raised.exception))
        self.assertNotIn("api key value", str(raised.exception).lower())

    def test_successful_request_captures_and_flushes_span(self) -> None:
        """Capture one healthy request with its final status and route."""
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)

        response = self.app.test_client().get("/health")

        self.assertEqual(response.status_code, 200)
        payload = self._recorded_batch("span")
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET /health")
        self.assertEqual(attributes["status"], "ok")
        self.assertEqual(attributes["metadata"]["framework"], "flask")
        self.assertEqual(attributes["metadata"]["status_code"], 200)

    def test_missing_service_fallback_returns_configuration_error(self) -> None:
        """Report missing framework identity without depending on assertions."""
        with (
            patch.dict("os.environ", {}, clear=True),
            patch.object(self.app, "import_name", None),
            self.assertRaises(SdkError) as raised,
        ):
            init_logbrew(self.app, api_key="LOGBREW_API_KEY", transport=self.transport)
        self.assertEqual(raised.exception.code, "configuration_error")
        self.assertIn("LOGBREW_SERVICE_NAME", str(raised.exception))
        self.assertEqual(self.transport.sent_bodies, [])

    def test_repeated_middleware_install_is_idempotent(self) -> None:
        """Reuse identical configuration without duplicate or cross-app capture."""
        first = add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)
        second = add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)

        self.assertIs(second, first)

        response = self.app.test_client().get("/health")
        self.assertEqual(response.status_code, 200)
        self._recorded_batch("span")

        Flask("uninstrumented").test_client().get("/health")
        self.assertEqual(len(self.transport.sent_bodies), 1)

    def test_request_metrics_can_be_captured_without_request_spans(self) -> None:
        """Keep duration metrics when healthy-span capture is disabled."""
        add_logbrew_middleware(
            self.app,
            client=self.sdk_client,
            transport=self.transport,
            capture_successful_requests=False,
            capture_request_metrics=True,
            span_id_factory=lambda: "b7ad6b7169203331",
        )

        @self.app.get("/orders/<int:order_id>")
        def order_detail(order_id: int) -> dict[str, int]:
            return {"orderId": order_id}

        response = self.app.test_client().get(
            "/orders/42?debug=true#receipt",
            headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"},
        )

        self.assertEqual(response.status_code, 200)
        payload = self._recorded_batch("metric")
        metric = payload["events"][0]["attributes"]
        self.assertEqual(metric["name"], "http.server.duration")
        self.assertEqual(metric["description"], "Duration of one completed server request.")
        self.assertEqual(metric["kind"], "histogram")
        self.assertGreaterEqual(metric["value"], 0)
        self.assertEqual(metric["unit"], "ms")
        self.assertEqual(metric["temporality"], "delta")
        self.assertEqual(
            metric["context"]["trace"],
            {
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "b7ad6b7169203331",
                "parentSpanId": "00f067aa0ba902b7",
                "sampled": False,
            },
        )
        metadata = metric["metadata"]
        self.assertEqual(metadata["framework"], "flask")
        self.assertEqual(metadata["method"], "GET")
        self.assertEqual(metadata["routeTemplate"], "/orders/<int:order_id>")
        self.assertEqual(metadata["statusCode"], 200)
        self.assertEqual(metadata["statusCodeClass"], "2xx")
        self.assertNotIn("debug", json.dumps(metadata))

    def test_valid_traceparent_continues_request_span(self) -> None:
        """Continue the inbound parent with exactly one fresh request span ID."""
        self._check_request_trace(
            "/trace",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "00f067aa0ba902b7",
        )

    def test_malformed_traceparent_uses_safe_local_trace_without_raw_header(self) -> None:
        """Replace invalid inbound context without retaining its raw value."""
        self._check_request_trace("/bad", "not-a-valid-traceparent")

    def _check_request_trace(
        self,
        path: str,
        traceparent: str,
        trace_id: str | None = None,
        parent_id: str | None = None,
    ) -> None:
        span_id_calls = 0

        def span_id_factory() -> str:
            nonlocal span_id_calls
            span_id_calls += 1
            return "b7ad6b7169203331"

        add_logbrew_middleware(
            self.app,
            client=self.sdk_client,
            transport=self.transport,
            span_id_factory=span_id_factory,
        )
        self.app.add_url_rule(path, endpoint=path, view_func=lambda: {"ok": True})
        response = self.app.test_client().get(f"{path}?debug=true", headers={"traceparent": traceparent})
        self.assertEqual(response.status_code, 200)
        payload = self._recorded_batch("span")
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], f"GET {path}")
        self.assertRegex(attributes["traceId"], r"^[0-9a-f]{32}$")
        if trace_id is not None:
            self.assertEqual(attributes["traceId"], trace_id)
            self.assertEqual(attributes["parentSpanId"], parent_id)
        else:
            self.assertNotIn("parentSpanId", attributes)
        self.assertEqual(attributes["spanId"], "b7ad6b7169203331")
        self.assertNotIn("path", attributes["metadata"])
        self.assertNotIn("traceparent", json.dumps(attributes))
        self.assertNotIn("debug", json.dumps(payload))
        self.assertEqual(span_id_calls, 1)

    def test_unmatched_route_does_not_capture_the_concrete_path(self) -> None:
        """Use a fixed unmatched name instead of a private concrete path."""
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)

        response = self.app.test_client().get("/accounts/example-person@example.test?debug_marker=drop", buffered=True)

        self.assertEqual(response.status_code, 404)
        payload = self._recorded_batch("span")
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET <unmatched>")
        serialized = json.dumps(attributes)
        self.assertNotIn("example-person", serialized)
        self.assertNotIn("debug_marker", serialized)
        self.assertNotIn("path", attributes["metadata"])

    def test_handler_logs_share_active_request_trace(self) -> None:
        """Correlate before-request and handler logs, then reset the logger."""
        handler = LogBrewLoggingHandler(self.sdk_client, metadata={"service": "checkout"})
        logger = logging.getLogger("flask.checkout")
        previous = (logger.handlers, logger.level, logger.propagate)

        @self.app.before_request
        def prepare() -> None:
            logger.info("preparing request")

        add_logbrew_middleware(
            self.app,
            client=self.sdk_client,
            transport=self.transport,
            span_id_factory=lambda: "b7ad6b7169203331",
        )

        @self.app.get("/orders/<int:order_id>")
        def order_detail(order_id: int) -> dict[str, str | None]:
            trace = get_active_logbrew_trace()
            logger.info("loading order", extra={"order_id": order_id})
            return {"traceId": trace.trace_id if trace else None, "spanId": trace.span_id if trace else None}

        with patch.multiple(logger, handlers=[handler], level=logging.INFO, propagate=False):
            response = self.app.test_client().get(
                "/orders/42?debug=true",
                headers={
                    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                },
            )

        self.assertEqual((logger.handlers, logger.level, logger.propagate), previous)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {"traceId": "4bf92f3577b34da6a3ce929d0e0e4736", "spanId": "b7ad6b7169203331"},
        )
        payload = self._recorded_batch("log", "log", "span")
        span = payload["events"][2]["attributes"]
        self.assertEqual(span["name"], "GET /orders/<int:order_id>")
        self.assertEqual(span["metadata"]["routeTemplate"], "/orders/<int:order_id>")
        for event in payload["events"][:2]:
            log = event["attributes"]
            self.assertEqual(log["metadata"]["traceId"], span["traceId"])
            self.assertEqual(log["metadata"]["spanId"], span["spanId"])
            self.assertEqual(log["metadata"]["parentSpanId"], span["parentSpanId"])
            self.assertIs(log["metadata"]["sampled"], expr2=True)
        self.assertNotIn("/orders/42", json.dumps(span))
        self.assertNotIn("debug", json.dumps(payload))

    def test_set_logbrew_user_tags_only_its_own_request(self) -> None:
        """A user set in one request reaches that request's issue and span, and no other request."""
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)

        @self.app.get("/account/boom")
        def account_boom() -> dict[str, int]:
            self.assertTrue(set_logbrew_user("user-42"))
            raise RuntimeError(_ORDER_FAILURE)

        @self.app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        self.app.test_client().get("/account/boom", buffered=True)
        payload = self._recorded_batch("issue", "span")
        for event in payload["events"]:
            self.assertEqual(event["attributes"]["context"]["subject"], {"id": "user-42", "kind": "user"})
        self.app.test_client().get("/health", buffered=True)
        self.assertNotIn("subject", json.dumps(json.loads(self.transport.sent_bodies[-1])))

    def test_exception_captures_issue_and_error_span(self) -> None:
        """Link the issue, error span, and metric while redacting exception text."""
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport, capture_request_metrics=True)

        @self.app.get("/orders/<int:order_id>/boom")
        def dynamic_order_boom(order_id: int) -> dict[str, int]:
            message = f"broken order {order_id}"
            raise RuntimeError(message)

        response = self.app.test_client().get("/orders/42/boom?debug=true", buffered=True)

        self.assertEqual(response.status_code, 500)
        payload = self._recorded_batch("issue", "span", "metric")
        self.assertEqual(payload["events"][2]["attributes"]["metadata"]["statusCode"], 500)
        issue = payload["events"][0]["attributes"]
        span = payload["events"][1]["attributes"]
        self.assertEqual(issue["title"], "GET /orders/<int:order_id>/boom failed")
        self.assertEqual(issue["message"], "Unhandled exception")
        self.assertEqual(
            issue["exception"],
            {
                "type": "RuntimeError",
                "mechanism": {"type": "flask.middleware", "handled": False},
            },
        )
        self.assertEqual(issue["stackFrames"][0]["filename"], "test_flask_integration.py")
        self.assertEqual(issue["stackFrames"][0]["function"], "dynamic_order_boom")
        self.assertEqual(issue["exceptionChain"]["entries"][0]["messageState"], "redacted")
        self.assertEqual(span["name"], "GET /orders/<int:order_id>/boom")
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 500)
        self.assertEqual(span["metadata"]["routeTemplate"], "/orders/<int:order_id>/boom")
        self.assertEqual(issue["metadata"]["traceId"], span["traceId"])
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        metric_trace = payload["events"][2]["attributes"]["context"]["trace"]
        self.assertEqual(metric_trace["traceId"], span["traceId"])
        self.assertEqual(metric_trace["spanId"], span["spanId"])
        for private_value in ("/orders/42", "broken order 42", "debug"):
            self.assertNotIn(private_value, json.dumps(payload))

    def test_flush_errors_do_not_break_application_by_default(self) -> None:
        """Keep the response successful and retain rejected telemetry for retry."""
        self.transport = RecordingTransport([{"status_code": 401}])
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)

        response = self.app.test_client().get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.sdk_client.pending_events(), 1)

    def test_nested_requests_keep_separate_capture_and_outer_context(self) -> None:
        """Keep inner request completion from consuming the outer request."""
        add_logbrew_middleware(self.app, client=self.sdk_client, capture_request_metrics=True)
        observed: list[LogBrewTraceContext | None] = []
        logger = logging.getLogger("flask.nested")

        @self.app.get("/inner/<int:status>")
        def inner(status: int) -> Response:
            observed.append(request_logbrew_trace())
            logger.info("inner operation")
            if status == HTTPStatus.INTERNAL_SERVER_ERROR:
                raise RuntimeError(_INNER_FAILURE)
            return Response(status=status)

        @self.app.get("/outer/<int:status>")
        def outer(status: int) -> Response:
            observed.append(request_logbrew_trace())
            logger.info("outer operation started")
            self.app.test_client().get(f"/inner/{status}", buffered=True)
            observed.extend((request_logbrew_trace(), get_active_logbrew_trace()))
            logger.info("outer operation completed")
            return Response(status=200)

        for status in (200, 500):
            with self.subTest(inner_status=status):
                observed.clear()
                self.assertIsNone(get_active_logbrew_trace())
                with (
                    patch.multiple(
                        logger, handlers=[LogBrewLoggingHandler(self.sdk_client)], level=logging.INFO, propagate=False
                    ),
                    patch("logbrew_flask._middleware.time.perf_counter", side_effect=(1.0, 2.0, 3.0, 4.0)),
                ):
                    response = self.app.test_client().get(f"/outer/{status}", buffered=True)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(observed[2:], [observed[0], observed[0]])
                self.assertIsNotNone(observed[1])
                self.assertNotEqual(observed[0], observed[1])
                self.assertIsNone(get_active_logbrew_trace())
                self.sdk_client.flush(self.transport)
                events = json.loads(self.transport.sent_bodies[-1])["events"]
                self.assertEqual(
                    [event["type"] for event in events],
                    ["log", "log"]
                    + (["issue"] if status == HTTPStatus.INTERNAL_SERVER_ERROR else [])
                    + ["span", "metric", "log", "span", "metric"],
                )
                spans = [event["attributes"] for event in events if event["type"] == "span"]
                self.assertEqual(
                    [span["name"] for span in spans], ["GET /inner/<int:status>", "GET /outer/<int:status>"]
                )
                self.assertEqual([span["metadata"]["status_code"] for span in spans], [status, 200])
                self.assertEqual(
                    [span["traceId"] for span in spans], [trace.trace_id for trace in observed[1::-1] if trace]
                )
                self.assertEqual([span["durationMs"] for span in spans], [1000, 3000])
                metrics = [event["attributes"] for event in events if event["type"] == "metric"]
                self.assertEqual([metric["value"] for metric in metrics], [1000, 3000])
                for metric, span in zip(metrics, spans, strict=True):
                    metric_trace = metric["context"]["trace"]
                    self.assertEqual(
                        (metric_trace["traceId"], metric_trace["spanId"]), (span["traceId"], span["spanId"])
                    )
                logs = [event["attributes"]["metadata"] for event in events if event["type"] == "log"]
                for log, span in zip(logs, (spans[1], spans[0], spans[1]), strict=True):
                    self.assertEqual((log["traceId"], log["spanId"]), (span["traceId"], span["spanId"]))
                if status == HTTPStatus.INTERNAL_SERVER_ERROR:
                    self.assertEqual(events[2]["attributes"]["metadata"]["traceId"], spans[0]["traceId"])

    def test_manual_context_teardown_does_not_invent_a_request(self) -> None:
        """Allow teardown before dispatch without emitting or retaining trace state.

        Raises:
            RuntimeError: Raised and caught to exercise manual-context teardown.

        """
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)
        with self.assertRaisesRegex(RuntimeError, _CONTEXT_FAILURE), self.app.test_request_context("/health"):
            self.assertIsNone(request_logbrew_trace())
            raise RuntimeError(_CONTEXT_FAILURE)
        self.assertIsNone(request_logbrew_trace())
        self.assertIsNone(get_active_logbrew_trace())
        self.assertEqual(self.sdk_client.pending_events(), 0)
        self.assertEqual(self.transport.sent_bodies, [])

    def test_completed_requests_have_one_final_duration_across_lifecycle_paths(self) -> None:
        """Check final evidence for every lifecycle and capture-policy combination."""
        cases = (
            ("healthy", 200, 1000, False),
            ("unhandled", 500, 1000, True),
            ("handler", 503, 1000, True),
            ("propagated", 500, 500, True),
            ("after_request", 500, 1000, True),
            ("handled", 422, 1000, False),
            ("before_response", 202, 1000, False),
            ("before_abort", 403, 1000, False),
            ("before_exception", 500, 1000, True),
        )
        for (mode, status, duration, eligible_issue), metrics, exceptions in product(
            cases, (True, False), (True, False)
        ):
            with (
                self.subTest(mode=mode, metrics=metrics, exceptions=exceptions),
                patch("logbrew_flask._middleware.time.perf_counter", return_value=1.0) as clock,
                patch("logbrew_flask._middleware.utc_timestamp", return_value="2026-01-01T00:00:00.000Z") as timestamp,
            ):
                sdk_client = _make_client()
                transport = RecordingTransport.always_accept()
                app = Flask(__name__)
                app.testing = mode == "propagated"
                configure_lifecycle_hooks(app, mode, status, clock, timestamp)
                add_logbrew_middleware(
                    app,
                    client=sdk_client,
                    transport=transport,
                    capture_request_metrics=metrics,
                    capture_exceptions=exceptions,
                )
                if mode == "propagated":
                    with self.assertRaisesRegex(RuntimeError, _ORDER_FAILURE):
                        app.test_client().get("/orders/42?private_query=drop", buffered=True)
                else:
                    self.assertEqual(
                        app.test_client().get("/orders/42?private_query=drop", buffered=True).status_code, status
                    )

                events = [event for body in transport.sent_bodies for event in json.loads(body)["events"]]
                self.assertEqual(sdk_client.pending_events(), 0)
                issue_expected = exceptions and eligible_issue
                self.assertEqual(
                    [event["type"] for event in events],
                    (["issue"] if issue_expected else []) + ["span"] + (["metric"] if metrics else []),
                )
                span_event = next(event for event in events if event["type"] == "span")
                self.assertEqual(span_event["timestamp"], "2026-01-01T00:00:00.000Z")
                span = span_event["attributes"]
                self.assertEqual(span["metadata"]["status_code"], status)
                self.assertEqual(span["durationMs"], duration)
                self.assertEqual(span["name"], "GET /orders/<int:order_id>")
                if metrics:
                    metric = events[-1]["attributes"]
                    self.assertEqual(metric["metadata"]["statusCode"], status)
                    self.assertEqual(metric["value"], span["durationMs"])
                if issue_expected:
                    self.assertEqual(events[0]["attributes"]["metadata"]["traceId"], span["traceId"])
                self.assertIsNone(get_active_logbrew_trace())
                for private_value in (
                    "private order",
                    "private response",
                    "private preparation",
                    "private_query",
                    "/orders/42",
                ):
                    self.assertNotIn(private_value, json.dumps(events))

    def test_flush_errors_can_be_raised_for_test_environments(self) -> None:
        """Propagate an opted-in delivery failure once and clear request context."""
        self.transport = RecordingTransport([{"status_code": 401}])
        self.app.testing = True
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport, raise_flush_errors=True)

        with self.assertRaises(SdkError):
            self.app.test_client().get("/health")
        self.assertEqual(self.sdk_client.pending_events(), 1)
        self.assertEqual(self.sdk_client.events[0]["type"], "span")
        self.assertIsNone(get_active_logbrew_trace())


class FlaskStreamingTests(_FlaskTestCase):
    """Check capture while WSGI consumes or closes the response body."""

    def test_error_page_completes_without_waiting_for_body_close(self) -> None:
        """Deliver an unhandled error at once, although Werkzeug streams its error page."""

        def boom() -> str:
            raise RuntimeError(_RESPONSE_FAILURE)

        self.app.add_url_rule("/boom", view_func=boom)
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport)
        self.assertEqual(self.app.test_client().get("/boom").status_code, 500)
        self._recorded_batch("issue", "span")

    def test_stream_failure_finishes_capture_after_body_iteration(self) -> None:
        """Keep body logs and an unhandled stream error on the request trace."""
        observed: list[LogBrewTraceContext | None] = []
        logger = logging.getLogger("logbrew.flask.stream")
        handler = LogBrewLoggingHandler(self.sdk_client)
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        self.addCleanup(logger.setLevel, logger.level)
        logger.setLevel(logging.INFO)
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport, capture_request_metrics=True)
        with patch("logbrew_flask._middleware.time.perf_counter", return_value=1.0) as clock:

            @self.app.get("/stream/<int:order_id>")
            def streamed_order(**_: int) -> Response:
                def body() -> Iterator[str]:
                    observed.append(get_active_logbrew_trace())
                    self.assertEqual(request_logbrew_trace(), observed[-1])
                    logger.info("stream started")
                    yield "first\n"
                    clock.return_value = 3.0
                    observed.append(get_active_logbrew_trace())
                    self.assertEqual(request_logbrew_trace(), observed[-1])
                    logger.info("stream continued")
                    raise RuntimeError(_RESPONSE_FAILURE)

                return Response(stream_with_context(body()))

            response = self.app.test_client().get("/stream/42?private_query=drop")
            self.addCleanup(response.close)
            self.assertEqual(response.status_code, HTTPStatus.OK)
            self.assertEqual(self.transport.sent_bodies, [])
            self.assertIsNone(get_active_logbrew_trace())
            with self.assertRaisesRegex(RuntimeError, _RESPONSE_FAILURE):
                list(response.response)
        response.close()
        events = self._recorded_batch("log", "log", "issue", "span", "metric")["events"]
        span = events[-2]["attributes"]
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["durationMs"], 2000)
        self.assertEqual(span["metadata"]["status_code"], HTTPStatus.OK)
        self.assertEqual(span["name"], "GET /stream/<int:order_id>")
        self.assertEqual(events[-1]["attributes"]["value"], 2000)
        self.assertEqual(events[-1]["attributes"]["metadata"]["statusCode"], HTTPStatus.OK)
        self.assertIsNotNone(observed[0])
        self.assertEqual(observed[0], observed[1])
        for event in events[:3]:
            self.assertEqual(event["attributes"]["metadata"]["traceId"], span["traceId"])
        self.assertEqual(events[2]["attributes"]["metadata"]["status_code"], HTTPStatus.OK)
        self.assertIsNone(get_active_logbrew_trace())
        for private_value in ("private response", "private_query", "/stream/42"):
            self.assertNotIn(private_value, json.dumps(events))

    def test_stream_policies_preserve_sent_status_and_body_trace(self) -> None:
        """Check normal and failing bodies with and without Flask context."""
        for failing, context, successful, exceptions in product((False, True), repeat=4):
            with (
                self.subTest(failing=failing, context=context, successful=successful, exceptions=exceptions),
                patch("logbrew_flask._middleware.time.perf_counter", return_value=1.0) as clock,
            ):
                self._check_stream_policy(
                    failing=failing, context=context, successful=successful, exceptions=exceptions, clock=clock
                )

    def _check_stream_policy(
        self, *, failing: bool, context: bool, successful: bool, exceptions: bool, clock: MagicMock
    ) -> None:
        app = Flask(__name__)
        sdk_client = _make_client()
        transport = RecordingTransport.always_accept()
        observed: list[LogBrewTraceContext | None] = []
        failure = RuntimeError(_RESPONSE_FAILURE)

        @app.get("/stream")
        def streamed() -> Response:
            def body() -> Iterator[bytes]:
                observed.append(get_active_logbrew_trace())
                if context:
                    self.assertEqual(request_logbrew_trace(), observed[-1])
                yield b"first\n"
                clock.return_value = 3.0
                observed.append(get_active_logbrew_trace())
                if failing:
                    raise failure
                yield b"last\n"

            return Response(stream_with_context(body()) if context else body(), status=206)

        add_logbrew_middleware(
            app,
            client=sdk_client,
            transport=transport,
            capture_request_metrics=True,
            capture_successful_requests=successful,
            capture_exceptions=exceptions,
        )
        with app.test_client().get("/stream") as response:
            self.assertEqual(transport.sent_bodies, [])
            self.assertIsNone(get_active_logbrew_trace())
            if failing:
                with self.assertRaises(RuntimeError) as raised:
                    list(response.response)
                self.assertIs(raised.exception, failure)
            else:
                self.assertEqual(list(response.response), [b"first\n", b"last\n"])
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        events = json.loads(transport.sent_bodies[0])["events"]
        span_expected = failing or successful
        self.assertEqual(
            [event["type"] for event in events],
            (["issue"] if failing and exceptions else []) + (["span"] if span_expected else []) + ["metric"],
        )
        metric = events[-1]["attributes"]
        self.assertEqual(metric["value"], 2000)
        self.assertEqual(metric["metadata"]["statusCode"], 206)
        self.assertIsNotNone(observed[0])
        self.assertEqual(observed[0], observed[1])
        self.assertIsNone(get_active_logbrew_trace())
        if span_expected:
            span = events[-2]["attributes"]
            self.assertEqual(span["status"], "error" if failing else "ok")
            self.assertEqual(span["metadata"]["status_code"], 206)
            self.assertEqual(metric["context"]["trace"]["traceId"], span["traceId"])

    def test_wsgi_close_completes_an_unconsumed_or_partial_body_once(self) -> None:
        """Keep close behavior for ordinary, direct, and HEAD responses."""
        for mode, direct in product(("unconsumed", "partial", "exhausted", "head", "close_failure"), (False, True)):
            with (
                self.subTest(mode=mode, direct=direct),
                patch("logbrew_flask._middleware.time.perf_counter", return_value=1.0) as clock,
            ):
                self._check_wsgi_close(mode, direct=direct, clock=clock)

    def _check_wsgi_close(self, mode: str, *, direct: bool, clock: MagicMock) -> None:
        app = Flask(__name__)
        sdk_client = _make_client()
        transport = RecordingTransport.always_accept()
        close_calls: list[LogBrewTraceContext | None] = []
        body = _ClosableBody(close_calls, RuntimeError(_RESPONSE_FAILURE) if mode == "close_failure" else None)
        app.add_url_rule("/stream", view_func=lambda: Response(body, direct_passthrough=direct))
        add_logbrew_middleware(app, client=sdk_client, transport=transport, capture_request_metrics=True)
        builder = EnvironBuilder(path="/stream", method="HEAD" if mode == "head" else "GET")
        self.addCleanup(builder.close)
        statuses: list[str] = []

        def start_response(
            status: str, _headers: list[tuple[str, str]], _exc_info: object = None
        ) -> Callable[[bytes], None]:
            statuses.append(status)
            return lambda _chunk: None

        response = cast("_WSGIBody", app.wsgi_app(builder.get_environ(), start_response))
        self.assertEqual(statuses, ["200 OK"])
        self.assertEqual(body.iterations, 0)
        self.assertEqual(transport.sent_bodies, [])
        self.assertIsNone(get_active_logbrew_trace())
        clock.return_value = 3.0
        if mode == "partial":
            self.assertEqual(next(iter(response)), b"chunk\n")
        elif mode in {"exhausted", "head"}:
            self.assertEqual(list(response), [] if mode == "head" else [b"chunk\n"])
        if mode == "close_failure":
            with self.assertRaisesRegex(RuntimeError, _RESPONSE_FAILURE):
                response.close()
        else:
            response.close()
        response.close()
        self.assertEqual(len(close_calls), 1)
        self.assertIsNotNone(close_calls[0])
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        events = json.loads(transport.sent_bodies[0])["events"]
        self.assertEqual(
            [event["type"] for event in events],
            (["issue"] if mode == "close_failure" else []) + ["span", "metric"],
        )
        span = events[-2]["attributes"]
        self.assertEqual(span["durationMs"], 2000)
        self.assertEqual(span["status"], "error" if mode == "close_failure" else "ok")
        self.assertEqual(span["metadata"]["status_code"], 200)
        self.assertIsNone(get_active_logbrew_trace())

    def test_stream_failure_preserves_the_application_error_during_close(self) -> None:
        """Retain the first body error when close or opted-in delivery fails."""
        failure = RuntimeError(_RESPONSE_FAILURE)
        close_calls: list[LogBrewTraceContext | None] = []
        body = _FailingBody(close_calls, RuntimeError(_PREPARATION_FAILURE), failure)
        self.app.add_url_rule("/stream", endpoint="stream", view_func=lambda: Response(body))
        self.transport = RecordingTransport([{"status_code": 401}])
        add_logbrew_middleware(
            self.app,
            client=self.sdk_client,
            transport=self.transport,
            capture_request_metrics=True,
            raise_flush_errors=True,
        )
        with self.app.test_client().get("/stream") as response, self.assertRaises(RuntimeError) as raised:
            list(response.response)
        self.assertIs(raised.exception, failure)
        self.assertEqual(len(close_calls), 1)
        self.assertIsNotNone(close_calls[0])
        self.assertEqual(self.sdk_client.pending_events(), 3)
        self.assertEqual(len(self.transport.sent_bodies), 1)
        events = json.loads(self.transport.sent_bodies[0])["events"]
        self.assertEqual([event["type"] for event in events], ["issue", "span", "metric"])
        self.assertEqual(events[1]["attributes"]["status"], "error")
        self.assertEqual(events[1]["attributes"]["metadata"]["status_code"], 200)
        self.assertIsNone(get_active_logbrew_trace())
        for private_value in ("private response", "private preparation"):
            self.assertNotIn(private_value, json.dumps(events))

    def test_normal_stream_completion_preserves_opted_in_delivery_errors(self) -> None:
        """Propagate a requested flush error after closing a successful body."""
        close_calls: list[LogBrewTraceContext | None] = []
        body = _ClosableBody(close_calls, None)
        self.app.add_url_rule("/stream", endpoint="stream", view_func=lambda: Response(body))
        self.transport = RecordingTransport([{"status_code": 401}])
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport, raise_flush_errors=True)
        with self.app.test_client().get("/stream") as response, self.assertRaises(SdkError):
            list(response.response)
        self.assertEqual(len(close_calls), 1)
        self.assertEqual(self.sdk_client.pending_events(), 1)
        self.assertEqual(len(self.transport.sent_bodies), 1)
        self.assertIsNone(get_active_logbrew_trace())

    def test_interleaved_bodies_reinstate_the_callers_trace_between_chunks(self) -> None:
        """Keep each body on its own trace while restoring the active caller."""
        observed: list[LogBrewTraceContext | None] = []

        @self.app.get("/stream")
        def streamed() -> Response:
            def body() -> Iterator[bytes]:
                observed.append(get_active_logbrew_trace())
                yield b"first\n"
                observed.append(get_active_logbrew_trace())
                yield b"last\n"

            return Response(body())

        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport, capture_request_metrics=True)
        parent = create_logbrew_trace_context()
        with use_logbrew_trace(parent):
            first = self.app.test_client().get("/stream")
            self.addCleanup(first.close)
            self.assertEqual(get_active_logbrew_trace(), parent)
            second = self.app.test_client().get("/stream")
            self.addCleanup(second.close)
            self.assertEqual(get_active_logbrew_trace(), parent)
            self.assertEqual(list(first.response), [b"first\n", b"last\n"])
            first.close()
            self.assertEqual(get_active_logbrew_trace(), parent)
            self.assertEqual(list(second.response), [b"first\n", b"last\n"])
            second.close()
            self.assertEqual(get_active_logbrew_trace(), parent)
        self.assertIsNone(get_active_logbrew_trace())
        self.assertIsNotNone(observed[0])
        self.assertIsNotNone(observed[1])
        self.assertNotEqual(observed[0], observed[1])
        self.assertEqual(observed[:2], observed[2:])
        self.assertEqual(self.sdk_client.pending_events(), 0)
        self.assertEqual(len(self.transport.sent_bodies), 2)
        for encoded, trace in zip(self.transport.sent_bodies, observed[:2], strict=True):
            events = json.loads(encoded)["events"]
            self.assertEqual([event["type"] for event in events], ["span", "metric"])
            self.assertEqual(events[0]["attributes"]["traceId"], trace.trace_id if trace else None)
            self.assertEqual(events[1]["attributes"]["context"]["trace"]["traceId"], trace.trace_id if trace else None)


class MetricTraceFactoryTests(_FlaskTestCase):
    """Keep metric trace attributes independent of implicit core capture."""

    def test_public_factory_uses_the_active_trace_without_retaining_it(self) -> None:
        """Attach bounded trace context only while a request trace is active."""
        trace = create_logbrew_trace_context(
            traceparent="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
            span_id_factory=lambda: "b7ad6b7169203331",
        )
        with self.app.test_request_context("/health?debug=true"):
            plain = logbrew_flask.create_request_metric_attributes(status_code=200, duration_ms=1.0)
            self.assertNotIn("context", plain)
            with use_logbrew_trace(trace):
                correlated = logbrew_flask.create_request_metric_attributes(status_code=200, duration_ms=1.0)
            self.assertEqual(
                correlated["context"]["trace"],
                {
                    "traceId": trace.trace_id,
                    "spanId": trace.span_id,
                    "parentSpanId": trace.parent_span_id,
                    "sampled": False,
                },
            )
            self.assertEqual(correlated["context"]["schemaVersion"], 1)
            self.assertIsNone(get_active_logbrew_trace())
            self.assertNotIn("debug=true", json.dumps(correlated))


class _WSGIBody(Protocol):
    """WSGI response iterable that also exposes the PEP 3333 close hook."""

    def __iter__(self) -> Iterator[bytes]: ...

    def close(self) -> None: ...


class _ClosableBody:
    """Expose WSGI iteration and close calls without buffering the body."""

    def __init__(self, close_calls: list[LogBrewTraceContext | None], failure: RuntimeError | None) -> None:
        self.iterations = 0
        self.close_calls = close_calls
        self.failure = failure

    def __iter__(self) -> Iterator[bytes]:
        self.iterations += 1
        return iter((b"chunk\n",))

    def close(self) -> None:
        """Record the active trace and optionally raise a close failure."""
        self.close_calls.append(get_active_logbrew_trace())
        if self.failure is not None:
            raise self.failure


class _FailingBody(_ClosableBody):
    """Raise a body failure independently of the original close behavior."""

    def __init__(
        self, close_calls: list[LogBrewTraceContext | None], close_failure: RuntimeError, body_failure: RuntimeError
    ) -> None:
        super().__init__(close_calls, close_failure)
        self.body_failure = body_failure

    @override
    def __iter__(self) -> Iterator[bytes]:
        yield from super().__iter__()
        raise self.body_failure


if __name__ == "__main__":
    unittest.main()


class RequestTraceFactoryTests(unittest.TestCase):
    """Keep valid inbound propagation separate from local factory failures."""

    def test_valid_header_does_not_retry_failed_span_factory(self) -> None:
        """Propagate the original factory failure after exactly one invocation."""
        failure = SdkError("validation_error", "span factory failed")
        factory = Mock(side_effect=failure)
        app = Flask(__name__)
        with (
            app.test_request_context(
                "/health",
                headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
            ),
            self.assertRaises(SdkError) as raised,
        ):
            create_request_trace_context(span_id_factory=factory)
        self.assertIs(raised.exception, failure)
        factory.assert_called_once_with()
