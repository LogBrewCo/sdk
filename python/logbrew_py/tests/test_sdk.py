from __future__ import annotations

import json
import logging
import unittest
from email.message import Message
from urllib.error import HTTPError, URLError
from urllib.request import Request

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    LogBrewLoggingHandler,
    LogBrewTraceContext,
    RecordingTransport,
    SdkError,
    TransportError,
    create_logbrew_trace_context,
    create_network_milestone_attributes,
    create_product_action_attributes,
    create_traceparent,
    create_traceparent_headers,
    get_active_logbrew_trace,
    parse_traceparent,
    span_attributes_from_traceparent,
    trace_metadata,
    urlopen_with_logbrew_span,
    use_logbrew_trace,
)


class StubHttpResponse:
    def __init__(self, status: int) -> None:
        self.status = status
        self.closed = False

    def getcode(self) -> int:
        return self.status

    def close(self) -> None:
        self.closed = True


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


def enqueue_all(client: LogBrewClient) -> None:
    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        {"version": "1.2.3", "commit": "abc123def456"},
    )
    client.environment(
        "evt_environment_001",
        "2026-06-02T10:00:01Z",
        {"name": "production", "region": "global"},
    )
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        {"title": "Checkout timeout", "level": "error", "message": "Request timed out after retry budget"},
    )
    client.log(
        "evt_log_001",
        "2026-06-02T10:00:03Z",
        {"message": "worker started", "level": "info", "logger": "job-runner"},
    )
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        {
            "name": "GET /health",
            "traceId": "trace_001",
            "spanId": "span_001",
            "status": "ok",
            "durationMs": 12.5,
        },
    )
    client.action(
        "evt_action_001",
        "2026-06-02T10:00:05Z",
        {"name": "deploy", "status": "success"},
    )


class LogBrewSdkTests(unittest.TestCase):
    def test_preview_json_contains_all_supported_event_types(self) -> None:
        client = sample_client()
        enqueue_all(client)

        payload = json.loads(client.preview_json())
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )

    def test_flush_success_clears_queue(self) -> None:
        client = sample_client()
        enqueue_all(client)

        transport = RecordingTransport.always_accept()
        response = client.flush(transport)

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.attempts, 1)
        self.assertEqual(client.pending_events(), 0)
        last_body = transport.last_body()
        self.assertIsNotNone(last_body)
        assert last_body is not None
        self.assertIn('"events"', last_body)

    def test_invalid_timestamp_fails_validation(self) -> None:
        client = sample_client()

        with self.assertRaisesRegex(
            SdkError,
            "timestamp must include a timezone offset: 2026-06-02T10:00:03",
        ):
            client.log(
                "evt_log_001",
                "2026-06-02T10:00:03",
                {"message": "worker started", "level": "info"},
            )

    def test_invalid_issue_level_fails_validation(self) -> None:
        client = sample_client()

        with self.assertRaisesRegex(
            SdkError,
            "issue level must be one of: critical, debug, error, fatal, info, trace, warn, warning",
        ):
            client.issue(
                "evt_issue_001",
                "2026-06-02T10:00:02Z",
                {"title": "Checkout timeout", "level": "verbose"},
            )

    def test_severity_aliases_normalize_before_preview(self) -> None:
        client = sample_client()

        client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {"title": "Checkout timeout", "level": "fatal"})
        client.log("evt_log_001", "2026-06-02T10:00:03Z", {"message": "verbose runtime detail", "level": "debug"})
        client.log("evt_log_002", "2026-06-02T10:00:04Z", {"message": "legacy warning alias", "level": "warn"})

        payload = json.loads(client.preview_json())
        self.assertEqual(
            [event["attributes"]["level"] for event in payload["events"]],
            ["critical", "info", "warning"],
        )

    def test_negative_span_duration_fails_validation(self) -> None:
        client = sample_client()

        with self.assertRaisesRegex(SdkError, "span durationMs must be non-negative"):
            client.span(
                "evt_span_001",
                "2026-06-02T10:00:04Z",
                {
                    "name": "GET /health",
                    "traceId": "trace_001",
                    "spanId": "span_001",
                    "status": "ok",
                    "durationMs": -1,
                },
            )

    def test_metric_event_validates_explicit_contract(self) -> None:
        client = sample_client()

        client.metric(
            "evt_metric_001",
            "2026-06-02T10:00:06Z",
            {
                "name": "queue.depth",
                "kind": "gauge",
                "value": -2,
                "unit": "{items}",
                "temporality": "instant",
                "metadata": {"service": "worker", "queue": "critical"},
            },
        )

        payload = json.loads(client.preview_json())
        event = payload["events"][0]
        self.assertEqual(event["type"], "metric")
        self.assertEqual(
            event["attributes"],
            {
                "name": "queue.depth",
                "kind": "gauge",
                "value": -2,
                "unit": "{items}",
                "temporality": "instant",
                "metadata": {"service": "worker", "queue": "critical"},
            },
        )

    def test_metric_rejects_non_finite_value(self) -> None:
        client = sample_client()

        with self.assertRaisesRegex(SdkError, "metric value must be a finite number"):
            client.metric(
                "evt_metric_001",
                "2026-06-02T10:00:06Z",
                {
                    "name": "queue.depth",
                    "kind": "gauge",
                    "value": float("nan"),
                    "unit": "{items}",
                    "temporality": "instant",
                },
            )

    def test_metric_rejects_negative_counter_value(self) -> None:
        client = sample_client()

        with self.assertRaisesRegex(SdkError, "metric counter value must be non-negative"):
            client.metric(
                "evt_metric_001",
                "2026-06-02T10:00:06Z",
                {
                    "name": "jobs.completed",
                    "kind": "counter",
                    "value": -1,
                    "unit": "1",
                    "temporality": "delta",
                },
            )

    def test_metric_rejects_invalid_temporality_for_kind(self) -> None:
        client = sample_client()

        with self.assertRaisesRegex(SdkError, "metric temporality for gauge must be one of: instant"):
            client.metric(
                "evt_metric_001",
                "2026-06-02T10:00:06Z",
                {
                    "name": "queue.depth",
                    "kind": "gauge",
                    "value": 2,
                    "unit": "{items}",
                    "temporality": "delta",
                },
            )

    def test_product_action_helper_keeps_agent_readable_primitive_metadata(self) -> None:
        attributes = create_product_action_attributes(
            {
                "name": "checkout.submit",
                "status": "running",
                "sessionId": "sess_123",
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "routeTemplate": "/checkout/:step?email=private@example.test#payment",
                "screen": "checkout",
                "funnel": "checkout",
                "step": "submit",
                "metadata": {"service": "checkout", "payload": {"card": "private"}},
            },
            metadata={"release": "2026.06.02"},
        )

        self.assertEqual(
            attributes,
            {
                "name": "checkout.submit",
                "status": "running",
                "metadata": {
                    "source": "product.action",
                    "release": "2026.06.02",
                    "service": "checkout",
                    "routeTemplate": "/checkout/:step",
                    "sessionId": "sess_123",
                    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                    "screen": "checkout",
                    "funnel": "checkout",
                    "step": "submit",
                },
            },
        )

    def test_network_milestone_helper_sanitizes_route_and_infers_status(self) -> None:
        attributes = create_network_milestone_attributes(
            {
                "routeTemplate": "https://api.example.test/payments/:id?card=private#receipt",
                "method": "post",
                "statusCode": 503,
                "durationMs": 94,
                "sessionId": "sess_123",
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "metadata": {"service": "checkout", "headers": {"authorization": "private"}},
            }
        )

        self.assertEqual(
            attributes,
            {
                "name": "network.post /payments/:id",
                "status": "failure",
                "metadata": {
                    "source": "network.milestone",
                    "service": "checkout",
                    "routeTemplate": "/payments/:id",
                    "method": "POST",
                    "statusCode": 503,
                    "durationMs": 94,
                    "sessionId": "sess_123",
                    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                },
            },
        )

    def test_timeline_helpers_reject_invalid_inputs(self) -> None:
        with self.assertRaisesRegex(SdkError, "product action must be a string or object"):
            create_product_action_attributes(123)  # type: ignore[arg-type]
        with self.assertRaisesRegex(SdkError, "network milestone statusCode must be an integer from 100 to 599"):
            create_network_milestone_attributes({"routeTemplate": "/payments/:id", "statusCode": 99})
        with self.assertRaisesRegex(SdkError, "network milestone method must be a valid HTTP method"):
            create_network_milestone_attributes({"routeTemplate": "/payments/:id", "method": "POST /private"})
        with self.assertRaisesRegex(SdkError, "network milestone durationMs must be a non-negative number"):
            create_network_milestone_attributes({"routeTemplate": "/payments/:id", "durationMs": -1})

    def test_traceparent_helpers_parse_create_and_continue_w3c_trace_context(self) -> None:
        traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
        context = parse_traceparent(traceparent)

        self.assertEqual(context.version, "00")
        self.assertEqual(context.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(context.parent_span_id, "00f067aa0ba902b7")
        self.assertEqual(context.trace_flags, "01")
        self.assertTrue(context.sampled)
        self.assertEqual(
            create_traceparent(
                trace_id=context.trace_id,
                span_id="b7ad6b7169203331",
                trace_flags="00",
            ),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00",
        )
        self.assertEqual(
            create_traceparent_headers(
                trace_id=context.trace_id,
                span_id="b7ad6b7169203331",
                trace_flags="00",
            ),
            {
                "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00",
            },
        )
        self.assertEqual(
            span_attributes_from_traceparent(
                traceparent,
                name="GET /checkout",
                span_id="b7ad6b7169203331",
                status="ok",
                duration_ms=12.5,
                metadata={"service": "checkout", "skipped": {"nested": True}},
            ),
            {
                "name": "GET /checkout",
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "b7ad6b7169203331",
                "parentSpanId": "00f067aa0ba902b7",
                "status": "ok",
                "durationMs": 12.5,
                "metadata": {"service": "checkout"},
            },
        )

    def test_active_trace_context_correlates_standard_logs(self) -> None:
        trace = create_logbrew_trace_context(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            span_id="b7ad6b7169203331",
        )
        self.assertIsInstance(trace, LogBrewTraceContext)
        self.assertIsNone(get_active_logbrew_trace())

        client = sample_client()
        handler = LogBrewLoggingHandler(client, metadata={"service": "checkout"})
        logger = logging.getLogger("checkout.trace")
        logger.handlers = []
        logger.propagate = False
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)

        try:
            with use_logbrew_trace(trace):
                self.assertEqual(get_active_logbrew_trace(), trace)
                logger.info("checkout step", extra={"cart_id": "cart_123"})
        finally:
            logger.removeHandler(handler)

        self.assertIsNone(get_active_logbrew_trace())
        payload = json.loads(client.preview_json())
        metadata = payload["events"][0]["attributes"]["metadata"]
        self.assertEqual(metadata["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(metadata["spanId"], "b7ad6b7169203331")
        self.assertEqual(metadata["parentSpanId"], "00f067aa0ba902b7")
        self.assertIs(metadata["sampled"], True)
        self.assertEqual(metadata["cart_id"], "cart_123")

    def test_trace_metadata_returns_empty_without_active_trace(self) -> None:
        self.assertEqual(trace_metadata(), {})

    def test_traceparent_helpers_reject_malformed_w3c_trace_context(self) -> None:
        with self.assertRaisesRegex(SdkError, "traceparent traceId must not be all zeros"):
            parse_traceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")
        with self.assertRaisesRegex(SdkError, "traceparent version ff is not allowed"):
            parse_traceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        with self.assertRaisesRegex(SdkError, "span_id must not be all zeros"):
            create_traceparent(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="0000000000000000",
            )
        with self.assertRaisesRegex(SdkError, "traceparent must use W3C"):
            span_attributes_from_traceparent(
                "not-a-traceparent",
                name="GET /checkout",
                span_id="b7ad6b7169203331",
                status="ok",
            )

    def test_unauthenticated_response_surfaces_clean_error(self) -> None:
        client = sample_client()
        enqueue_all(client)

        transport = RecordingTransport([{"status_code": 401}])
        with self.assertRaisesRegex(SdkError, "transport rejected the API key"):
            client.flush(transport)
        self.assertEqual(client.pending_events(), 6)

    def test_network_failure_retries_before_succeeding(self) -> None:
        client = sample_client()
        enqueue_all(client)

        transport = RecordingTransport(
            [TransportError.network("temporary outage"), {"status_code": 202}]
        )
        response = client.flush(transport)

        self.assertEqual(response.attempts, 2)
        self.assertEqual(len(transport.sent_bodies), 2)

    def test_http_transport_posts_json_and_maps_status(self) -> None:
        requests: list[tuple[Request, float]] = []
        response = StubHttpResponse(202)

        def open_url(request: Request, *, timeout: float) -> StubHttpResponse:
            requests.append((request, timeout))
            return response

        transport = HttpTransport(
            endpoint="http://127.0.0.1:9/v1/events",
            headers={"x-logbrew-source": "unit-test"},
            timeout=2.5,
            open_url=open_url,
        )

        result = transport.send("LOGBREW_API_KEY", '{"events":[]}')

        self.assertEqual(result.status_code, 202)
        self.assertEqual(result.attempts, 1)
        self.assertTrue(response.closed)
        request, timeout = requests[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:9/v1/events")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, b'{"events":[]}')
        self.assertEqual(timeout, 2.5)
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["authorization"], "Bearer LOGBREW_API_KEY")
        self.assertEqual(headers["x-logbrew-source"], "unit-test")

    def test_http_transport_returns_error_status_for_client_retry_logic(self) -> None:
        calls = 0

        def open_url(_request: Request, *, timeout: float) -> StubHttpResponse:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise HTTPError(
                    url="http://127.0.0.1:9/v1/events",
                    code=503,
                    msg="retry later",
                    hdrs=Message(),
                    fp=None,
                )
            return StubHttpResponse(202)

        client = LogBrewClient.create(
            api_key="LOGBREW_API_KEY",
            sdk_name="logbrew-python",
            sdk_version="0.1.0",
            max_retries=1,
        )
        client.log(
            "evt_python_http_transport",
            "2026-06-02T10:00:06Z",
            {"message": "delivery retry", "level": "info"},
        )
        response = client.flush(
            HttpTransport(endpoint="http://127.0.0.1:9/v1/events", open_url=open_url)
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.attempts, 2)
        self.assertEqual(calls, 2)

    def test_http_transport_maps_url_errors_to_retryable_transport_error(self) -> None:
        def open_url(_request: Request, *, timeout: float) -> StubHttpResponse:
            raise URLError("offline")

        transport = HttpTransport(endpoint="http://127.0.0.1:9/v1/events", open_url=open_url)

        with self.assertRaisesRegex(TransportError, "http transport failed"):
            transport.send("LOGBREW_API_KEY", '{"events":[]}')

    def test_urlopen_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        client = sample_client()
        opener_active_trace: LogBrewTraceContext | None = None
        sent_requests: list[Request] = []
        original_request = Request(
            "https://api.example.test/payments/123?coupon=summer#receipt",
            headers={"traceparent": "spoofed", "x-caller": "checkout"},
            method="GET",
        )
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([10.0, 10.043])

        def open_url(request: Request, *, timeout: float | None = None) -> StubHttpResponse:
            nonlocal opener_active_trace
            sent_requests.append(request)
            opener_active_trace = get_active_logbrew_trace()
            self.assertEqual(timeout, 2.5)
            return StubHttpResponse(202)

        with use_logbrew_trace(parent_trace):
            response = urlopen_with_logbrew_span(
                original_request,
                client=client,
                event_id="evt_python_urlopen_client",
                timestamp="2026-06-19T08:00:00Z",
                open_url=open_url,
                timeout=2.5,
                span_id_factory=lambda: "b7ad6b7169203331",
                clock=lambda: next(clock_values),
                metadata={"service": "checkout", "headers": {"authorization": "private"}},
            )

        self.assertEqual(response.status, 202)
        self.assertIsNone(get_active_logbrew_trace())
        self.assertEqual(original_request.get_header("Traceparent"), "spoofed")
        sent_request = sent_requests[0]
        self.assertIsNot(sent_request, original_request)
        self.assertEqual(
            sent_request.get_header("Traceparent"),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
        )
        self.assertEqual(sent_request.get_header("X-caller"), "checkout")
        self.assertEqual(opener_active_trace, LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="b7ad6b7169203331",
            parent_span_id="00f067aa0ba902b7",
            sampled=True,
        ))

        payload = json.loads(client.preview_json())
        event = payload["events"][0]
        self.assertEqual(event["type"], "span")
        self.assertEqual(event["id"], "evt_python_urlopen_client")
        self.assertEqual(
            event["attributes"],
            {
                "name": "GET /payments/123",
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "b7ad6b7169203331",
                "parentSpanId": "00f067aa0ba902b7",
                "status": "ok",
                "durationMs": 43.0,
                "metadata": {
                    "source": "urllib.request",
                    "service": "checkout",
                    "routeTemplate": "/payments/123",
                    "method": "GET",
                    "statusCode": 202,
                    "sampled": True,
                },
            },
        )
        serialized = client.preview_json()
        self.assertNotIn("coupon=summer", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("traceparent", serialized)

    def test_urlopen_with_logbrew_span_preserves_http_errors_and_capture_failures(self) -> None:
        client = sample_client()
        original_error = HTTPError(
            url="https://api.example.test/payments/123?coupon=summer",
            code=503,
            msg="retry later",
            hdrs=Message(),
            fp=None,
        )

        def open_url(_request: Request, *, timeout: float | None = None) -> StubHttpResponse:
            raise original_error

        with self.assertRaises(HTTPError) as raised:
            urlopen_with_logbrew_span(
                "https://api.example.test/payments/123?coupon=summer",
                client=client,
                event_id="evt_python_urlopen_failure",
                timestamp="2026-06-19T08:00:01Z",
                open_url=open_url,
                span_id_factory=lambda: "b7ad6b7169203332",
                clock=lambda: 20.0,
            )

        self.assertIs(raised.exception, original_error)
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["statusCode"], 503)
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "HTTPError")
        self.assertNotIn("coupon=summer", client.preview_json())

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        response = urlopen_with_logbrew_span(
            "https://api.example.test/health",
            client=closed_client,
            event_id="evt_python_urlopen_capture_error",
            timestamp="2026-06-19T08:00:02Z",
            open_url=lambda _request, *, timeout=None: StubHttpResponse(204),
            span_id_factory=lambda: "b7ad6b7169203333",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(response.status, 204)
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_shutdown_flushes_and_prevents_future_events(self) -> None:
        client = sample_client()
        enqueue_all(client)
        transport = RecordingTransport.always_accept()

        response = client.shutdown(transport)
        self.assertEqual(response.status_code, 202)

        with self.assertRaisesRegex(SdkError, "client is already shut down"):
            client.action(
                "evt_action_002",
                "2026-06-02T10:00:06Z",
                {"name": "deploy", "status": "success"},
            )

    def test_logging_handler_queues_standard_log_record(self) -> None:
        client = sample_client()
        handler = LogBrewLoggingHandler(client, metadata={"service": "checkout"})
        logger = logging.getLogger("checkout.worker")
        logger.handlers = []
        logger.propagate = False
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)

        try:
            logger.info("worker started", extra={"order_id": "ord_123", "non_primitive": {"ignored": True}})
        finally:
            logger.removeHandler(handler)

        payload = json.loads(client.preview_json())
        event = payload["events"][0]
        self.assertEqual(event["type"], "log")
        self.assertEqual(event["attributes"]["message"], "worker started")
        self.assertEqual(event["attributes"]["level"], "info")
        self.assertEqual(event["attributes"]["logger"], "checkout.worker")
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["service"], "checkout")
        self.assertEqual(metadata["order_id"], "ord_123")
        self.assertEqual(metadata["levelName"], "INFO")
        self.assertEqual(metadata["threadName"], "MainThread")
        self.assertNotIn("pathname", metadata)
        self.assertNotIn("non_primitive", metadata)

    def test_logging_handler_maps_exception_metadata_without_traceback_by_default(self) -> None:
        client = sample_client()
        handler = LogBrewLoggingHandler(client)
        logger = logging.getLogger("checkout.exception")
        logger.handlers = []
        logger.propagate = False
        logger.setLevel(logging.ERROR)
        logger.addHandler(handler)

        try:
            try:
                raise RuntimeError("gateway failed")
            except RuntimeError:
                logger.exception("checkout failed")
        finally:
            logger.removeHandler(handler)

        payload = json.loads(client.preview_json())
        metadata = payload["events"][0]["attributes"]["metadata"]
        self.assertEqual(payload["events"][0]["attributes"]["level"], "error")
        self.assertEqual(metadata["exceptionName"], "RuntimeError")
        self.assertEqual(metadata["exceptionMessage"], "gateway failed")
        self.assertNotIn("exceptionText", metadata)

    def test_logging_handler_flushes_when_transport_is_configured(self) -> None:
        client = sample_client()
        transport = RecordingTransport.always_accept()
        handler = LogBrewLoggingHandler(client, transport, flush_on_emit=True)
        record = logging.LogRecord(
            name="checkout.flush",
            level=logging.WARNING,
            pathname="/private/app.py",
            lineno=42,
            msg="retrying checkout",
            args=(),
            exc_info=None,
        )

        handler.emit(record)

        self.assertEqual(client.pending_events(), 0)
        self.assertEqual(len(transport.sent_bodies), 1)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual(payload["events"][0]["attributes"]["level"], "warning")
        self.assertEqual(payload["events"][0]["attributes"]["metadata"]["fileName"], "app.py")

    def test_logging_handler_flush_method_sends_pending_records(self) -> None:
        client = sample_client()
        transport = RecordingTransport.always_accept()
        handler = LogBrewLoggingHandler(client, transport)
        record = logging.LogRecord(
            name="checkout.flush_method",
            level=logging.CRITICAL,
            pathname="/private/app.py",
            lineno=44,
            msg="checkout down",
            args=(),
            exc_info=None,
        )

        handler.emit(record)
        handler.flush()

        self.assertEqual(client.pending_events(), 0)
        payload = json.loads(transport.sent_bodies[0])
        self.assertEqual(payload["events"][0]["attributes"]["level"], "critical")
        self.assertEqual(payload["events"][0]["attributes"]["metadata"]["levelName"], "CRITICAL")


if __name__ == "__main__":
    unittest.main()
