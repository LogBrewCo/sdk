from __future__ import annotations

import json
import logging
import re
import unittest

from flask import Flask
from logbrew_flask import add_logbrew_middleware, get_active_logbrew_trace
from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport, SdkError


def make_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-flask",
        sdk_version="0.1.0",
    )


class FlaskIntegrationTests(unittest.TestCase):
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
        self.assertEqual(attributes["metadata"]["path"], "/trace")

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
        self.assertEqual(attributes["metadata"]["path"], "/bad")
        self.assertNotIn("traceparent", json.dumps(attributes))
        self.assertEqual(span_id_calls, 1)

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
        self.assertEqual(issue["metadata"]["exception_type"], "RuntimeError")
        self.assertEqual(span["name"], "GET /orders/<int:order_id>/boom")
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 500)
        self.assertEqual(span["metadata"]["routeTemplate"], "/orders/<int:order_id>/boom")
        self.assertEqual(issue["metadata"]["traceId"], span["traceId"])
        self.assertEqual(issue["metadata"]["spanId"], span["spanId"])
        self.assertNotIn("/orders/42", json.dumps(payload))
        self.assertNotIn("debug", json.dumps(payload))

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
