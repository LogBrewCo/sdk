from __future__ import annotations

import json
import logging
import re
import time
import unittest
from collections.abc import Callable
from importlib.metadata import version
from pathlib import Path

from flask import Flask
from logbrew_flask import (
    LOGBREW_FLASK_SDK_VERSION,
    add_logbrew_middleware,
    get_active_logbrew_trace,
    init_logbrew,
)
from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport, SdkError


def make_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-flask",
        sdk_version="0.1.0",
    )


def wait_until(predicate: Callable[[], bool], *, timeout_seconds: float = 1.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("timed out waiting for LogBrew delivery")
        time.sleep(0.01)


class FlaskIntegrationTests(unittest.TestCase):
    def test_readme_requires_hosted_readback_for_end_to_end_confirmation(self) -> None:
        readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(
            encoding="utf-8"
        )
        normalized_readme = " ".join(readme.split())

        for expected in (
            "logbrew status --json",
            "logbrew projects --json",
            "logbrew projects keys create <project_id>",
            "--kind server",
            "logbrew read traces",
            "logbrew explain trace <trace_id> --json",
            "https://docs.logbrew.co/guides/flask",
        ):
            self.assertIn(expected, readme)

        self.assertIn(
            "It does not confirm that LogBrew accepted, stored, and indexed the event.",
            normalized_readme,
        )
        self.assertIn(
            "never use the CLI account session for ingestion", normalized_readme
        )

    def test_init_logbrew_uses_app_configuration_and_delivers_in_background(self) -> None:
        transport = RecordingTransport.always_accept()
        app = Flask("checkout_api")
        app.config.update(
            LOGBREW_SERVER_API_KEY="LOGBREW_SERVER_API_KEY",
            LOGBREW_SERVICE_NAME="checkout-api",
            LOGBREW_ENVIRONMENT="test",
            LOGBREW_RELEASE="checkout@1.2.3",
        )

        config = init_logbrew(app, transport=transport)
        self.assertIs(init_logbrew(app, transport=transport), config)
        self.assertEqual(LOGBREW_FLASK_SDK_VERSION, version("logbrew-flask"))

        @app.get("/orders/<int:order_id>")
        def order_detail(order_id: int) -> dict[str, int]:
            return {"orderId": order_id}

        response = app.test_client().get("/orders/42?private=drop")
        self.assertEqual(response.status_code, 200)
        wait_until(lambda: len(transport.sent_bodies) == 1)

        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span"])
        event = payload["events"][0]
        self.assertEqual(event["attributes"]["name"], "GET /orders/<int:order_id>")
        resource = event["attributes"]["context"]["resource"]
        self.assertEqual(resource["service"]["name"], "checkout-api")
        self.assertEqual(resource["deployment"]["environment"], "test")
        self.assertEqual(resource["deployment"]["release"], "checkout@1.2.3")
        self.assertEqual(resource["framework"]["name"], "flask")
        self.assertNotIn("/orders/42", transport.sent_bodies[0])
        self.assertNotIn("private", transport.sent_bodies[0])
        config.client.shutdown()

    def test_init_logbrew_requires_a_server_ingest_key_without_reflecting_values(self) -> None:
        app = Flask(__name__)
        app.config["LOGBREW_SERVER_API_KEY"] = ""

        with self.assertRaises(SdkError) as raised:
            init_logbrew(app)

        self.assertEqual(raised.exception.code, "configuration_error")
        self.assertIn("LOGBREW_SERVER_API_KEY", str(raised.exception))
        self.assertNotIn("api key value", str(raised.exception).lower())

    def test_successful_request_captures_and_flushes_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = Flask(__name__)
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        response = app.test_client().get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span"])
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET /health")
        self.assertEqual(attributes["status"], "ok")
        self.assertEqual(attributes["metadata"]["framework"], "flask")
        self.assertEqual(attributes["metadata"]["status_code"], 200)

    def test_repeated_middleware_install_is_idempotent(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = Flask(__name__)

        first = add_logbrew_middleware(app, client=sdk_client, transport=transport)
        second = add_logbrew_middleware(app, client=sdk_client, transport=transport)

        self.assertIs(second, first)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        response = app.test_client().get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["span"])

    def test_request_metrics_can_be_captured_without_request_spans(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = Flask(__name__)
        add_logbrew_middleware(
            app,
            client=sdk_client,
            transport=transport,
            capture_successful_requests=False,
            capture_request_metrics=True,
        )

        @app.get("/orders/<int:order_id>")
        def order_detail(order_id: int) -> dict[str, int]:
            return {"orderId": order_id}

        response = app.test_client().get("/orders/42?debug=true#receipt")

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
        self.assertEqual(metadata["framework"], "flask")
        self.assertEqual(metadata["method"], "GET")
        self.assertEqual(metadata["routeTemplate"], "/orders/<int:order_id>")
        self.assertEqual(metadata["statusCode"], 200)
        self.assertEqual(metadata["statusCodeClass"], "2xx")
        self.assertNotIn("debug", json.dumps(metadata))

    def test_valid_traceparent_continues_request_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = Flask(__name__)
        add_logbrew_middleware(
            app,
            client=sdk_client,
            transport=transport,
            span_id_factory=lambda: "b7ad6b7169203331",
        )

        @app.get("/trace")
        def trace() -> dict[str, bool]:
            return {"ok": True}

        response = app.test_client().get(
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
        self.assertNotIn("path", attributes["metadata"])

    def test_malformed_traceparent_uses_safe_local_trace_without_raw_header(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        span_id_calls = 0
        app = Flask(__name__)

        def span_id_factory() -> str:
            nonlocal span_id_calls
            span_id_calls += 1
            return "b7ad6b7169203331"

        add_logbrew_middleware(app, client=sdk_client, transport=transport, span_id_factory=span_id_factory)

        @app.get("/bad")
        def bad() -> dict[str, bool]:
            return {"ok": True}

        response = app.test_client().get("/bad?debug=true", headers={"traceparent": "not-a-valid-traceparent"})

        self.assertEqual(response.status_code, 200)
        payload = json.loads(transport.sent_bodies[0])
        attributes = payload["events"][0]["attributes"]
        self.assertNotIn("parentSpanId", attributes)
        self.assertRegex(attributes["traceId"], re.compile(r"^[0-9a-f]{32}$"))
        self.assertEqual(attributes["spanId"], "b7ad6b7169203331")
        self.assertNotIn("path", attributes["metadata"])
        self.assertNotIn("traceparent", json.dumps(attributes))
        self.assertEqual(span_id_calls, 1)

    def test_unmatched_route_does_not_capture_the_concrete_path(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = Flask(__name__)
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        response = app.test_client().get("/accounts/example-person@example.test?debug_marker=drop")

        self.assertEqual(response.status_code, 404)
        payload = json.loads(transport.sent_bodies[0])
        attributes = payload["events"][0]["attributes"]
        self.assertEqual(attributes["name"], "GET <unmatched>")
        serialized = json.dumps(attributes)
        self.assertNotIn("example-person", serialized)
        self.assertNotIn("debug_marker", serialized)
        self.assertNotIn("path", attributes["metadata"])

    def test_handler_logs_share_active_request_trace(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        handler = LogBrewLoggingHandler(sdk_client, metadata={"service": "checkout"})
        logger = logging.getLogger("flask.checkout")
        logger.handlers = []
        logger.propagate = False
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        app = Flask(__name__)
        add_logbrew_middleware(
            app,
            client=sdk_client,
            transport=transport,
            span_id_factory=lambda: "b7ad6b7169203331",
        )

        @app.get("/orders/<int:order_id>")
        def order_detail(order_id: int) -> dict[str, str | None]:
            trace = get_active_logbrew_trace()
            logger.info("loading order", extra={"order_id": order_id})
            return {"traceId": trace.trace_id if trace else None, "spanId": trace.span_id if trace else None}

        try:
            response = app.test_client().get(
                "/orders/42?debug=true",
                headers={
                    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                },
            )
        finally:
            logger.removeHandler(handler)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {"traceId": "4bf92f3577b34da6a3ce929d0e0e4736", "spanId": "b7ad6b7169203331"},
        )
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["log", "span"])
        log = payload["events"][0]["attributes"]
        span = payload["events"][1]["attributes"]
        self.assertEqual(span["name"], "GET /orders/<int:order_id>")
        self.assertEqual(span["metadata"]["routeTemplate"], "/orders/<int:order_id>")
        self.assertEqual(log["metadata"]["traceId"], span["traceId"])
        self.assertEqual(log["metadata"]["spanId"], span["spanId"])
        self.assertEqual(log["metadata"]["parentSpanId"], span["parentSpanId"])
        self.assertIs(log["metadata"]["sampled"], True)
        self.assertNotIn("/orders/42", json.dumps(span))
        self.assertNotIn("debug", json.dumps(payload))

    def test_exception_captures_issue_and_error_span(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport.always_accept()
        app = Flask(__name__)
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.get("/orders/<int:order_id>/boom")
        def dynamic_order_boom(order_id: int) -> dict[str, int]:
            raise RuntimeError(f"broken order {order_id}")

        response = app.test_client().get("/orders/42/boom?debug=true")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(sdk_client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["type"] for event in payload["events"]], ["issue", "span"])
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
        for private_value in ("/orders/42", "broken order 42", "debug"):
            self.assertNotIn(private_value, json.dumps(payload))

    def test_flush_errors_do_not_break_application_by_default(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport([{"status_code": 401}])
        app = Flask(__name__)
        add_logbrew_middleware(app, client=sdk_client, transport=transport)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        response = app.test_client().get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sdk_client.pending_events(), 1)

    def test_flush_errors_can_be_raised_for_test_environments(self) -> None:
        sdk_client = make_client()
        transport = RecordingTransport([{"status_code": 401}])
        app = Flask(__name__)
        app.testing = True
        add_logbrew_middleware(app, client=sdk_client, transport=transport, raise_flush_errors=True)

        @app.get("/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        with self.assertRaises(SdkError):
            app.test_client().get("/health")
        self.assertEqual(sdk_client.pending_events(), 1)
        self.assertEqual(sdk_client.events[0]["type"], "span")


if __name__ == "__main__":
    unittest.main()
