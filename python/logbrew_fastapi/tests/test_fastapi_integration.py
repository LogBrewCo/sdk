from __future__ import annotations

import json
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from logbrew_fastapi import add_logbrew_middleware
from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError


def make_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-fastapi",
        sdk_version="0.1.0",
    )


class FastAPIIntegrationTests(unittest.TestCase):
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

    def test_malformed_traceparent_keeps_synthetic_span_without_span_id_factory(self) -> None:
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
        self.assertTrue(attributes["traceId"].startswith("trace_evt_fastapi_span_"))
        self.assertEqual(attributes["metadata"]["path"], "/bad")
        self.assertEqual(span_id_calls, 0)

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
        self.assertEqual(issue["message"], "broken handler")
        self.assertEqual(issue["metadata"]["exception_type"], "RuntimeError")
        self.assertEqual(span["status"], "error")
        self.assertEqual(span["metadata"]["status_code"], 500)

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


if __name__ == "__main__":
    unittest.main()
