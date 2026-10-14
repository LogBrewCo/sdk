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
from typing import TYPE_CHECKING, Any, get_type_hints
from unittest.mock import Mock, patch

from flask import Flask, Response, abort
from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, LogBrewTraceContext, RecordingTransport, SdkError
from typing_extensions import override

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
    from collections.abc import Callable
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


class FlaskIntegrationTests(unittest.TestCase):
    """Exercise capture through Flask's dispatch and app-owned integrations."""

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

        response = self.app.test_client().get("/accounts/example-person@example.test?debug_marker=drop")

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

    def test_exception_captures_issue_and_error_span(self) -> None:
        """Link the issue, error span, and metric while redacting exception text."""
        add_logbrew_middleware(self.app, client=self.sdk_client, transport=self.transport, capture_request_metrics=True)

        @self.app.get("/orders/<int:order_id>/boom")
        def dynamic_order_boom(order_id: int) -> dict[str, int]:
            message = f"broken order {order_id}"
            raise RuntimeError(message)

        response = self.app.test_client().get("/orders/42/boom?debug=true")

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
            self.app.test_client().get(f"/inner/{status}")
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
                    response = self.app.test_client().get(f"/outer/{status}")
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
                        app.test_client().get("/orders/42?private_query=drop")
                else:
                    self.assertEqual(app.test_client().get("/orders/42?private_query=drop").status_code, status)

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
