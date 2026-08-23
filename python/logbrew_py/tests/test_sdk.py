from __future__ import annotations

import json
import logging
import ssl
import unittest
from email.message import Message
from importlib.metadata import PackageNotFoundError
from typing import Any, cast
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

from logbrew_sdk import (
    HttpTransport,
    IssueAttributes,
    IssueBreadcrumb,
    IssueBreadcrumbDataValue,
    IssueDiagnosticEvidence,
    IssueException,
    IssueStackFrame,
    LogBrewClient,
    LogBrewLoggingHandler,
    LogBrewTraceContext,
    RecordingTransport,
    SdkError,
    TransportError,
    create_issue_attributes_from_exception,
    create_logbrew_trace_context,
    create_network_milestone_attributes,
    create_product_action_attributes,
    create_traceparent,
    create_traceparent_headers,
    get_active_logbrew_trace,
    logbrew_trace_context_from_open_telemetry_span,
    logbrew_trace_context_from_open_telemetry_span_context,
    parse_traceparent,
    requests_request_with_logbrew_span,
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


class FakeOpenTelemetryTraceFlags:
    def __init__(self, *, sampled: bool) -> None:
        self.sampled = sampled


class FakeOpenTelemetrySpanContext:
    def __init__(
        self,
        *,
        trace_id: int,
        span_id: int,
        trace_flags: Any,
        is_valid: bool = True,
    ) -> None:
        self.trace_id = trace_id
        self.span_id = span_id
        self.trace_flags = trace_flags
        self.is_valid = is_valid


class FakeOpenTelemetrySpan:
    def __init__(self, span_context: FakeOpenTelemetrySpanContext) -> None:
        self._span_context = span_context

    def get_span_context(self) -> FakeOpenTelemetrySpanContext:
        return self._span_context


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
        capture_runtime_context=False,
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

    def test_bounded_queue_preserves_existing_context_and_counts_drops(self) -> None:
        client = LogBrewClient.create(
            api_key="lb_test_key",
            sdk_name="logbrew-sdk",
            sdk_version="0.1.0",
            max_queue_size=2,
        )

        client.release(
            "evt_release_context",
            "2026-06-02T10:00:00Z",
            {"version": "1.0.0"},
        )
        client.environment(
            "evt_environment_context",
            "2026-06-02T10:00:01Z",
            {"name": "production"},
        )
        client.log(
            "evt_log_dropped",
            "2026-06-02T10:00:02Z",
            {"message": "queue pressure", "level": "warning"},
        )

        payload = json.loads(client.preview_json())
        self.assertEqual(client.pending_events(), 2)
        self.assertEqual(client.dropped_events(), 1)
        self.assertEqual(
            [event["id"] for event in payload["events"]],
            ["evt_release_context", "evt_environment_context"],
        )

    def test_direct_constructor_keeps_default_queue_capacity(self) -> None:
        client = LogBrewClient(
            api_key="lb_test_key",
            sdk={"name": "logbrew-sdk", "language": "python", "version": "0.1.0"},
            max_retries=1,
        )

        self.assertEqual(client.pending_events(), 0)
        self.assertEqual(client.dropped_events(), 0)

    def test_bounded_queue_rejects_invalid_capacity(self) -> None:
        with self.assertRaisesRegex(SdkError, "max_queue_size must be a positive integer"):
            LogBrewClient.create(
                api_key="lb_test_key",
                sdk_name="logbrew-sdk",
                sdk_version="0.1.0",
                max_queue_size=0,
            )

        with self.assertRaisesRegex(SdkError, "max_queue_size must be a positive integer"):
            LogBrewClient.create(
                api_key="lb_test_key",
                sdk_name="logbrew-sdk",
                sdk_version="0.1.0",
                max_queue_size=True,
            )

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

    def test_issue_diagnostics_are_bounded_validated_and_detached(self) -> None:
        client = sample_client()
        exception: IssueException = {
            "type": "CheckoutError",
            "mechanism": {"type": "python.exception", "handled": False},
        }
        stack_frames: list[IssueStackFrame] = [
            {
                "filename": "C:\\workspace\\app\\checkout.py?debug=true#frame",
                "line": 42,
                "column": 7,
                "function": "submit_checkout",
                "module": "checkout.handlers",
                "inApp": True,
            }
        ]
        breadcrumb_data: dict[str, IssueBreadcrumbDataValue] = {"attempt": 2, "cached": False}
        breadcrumbs: list[IssueBreadcrumb] = [
            {
                "timestamp": "2026-07-17T11:59:00Z",
                "type": "navigation",
                "category": "checkout.step",
                "level": "warn",
                "message": "Payment step opened",
                "data": breadcrumb_data,
            }
        ]

        client.issue(
            "evt_issue_diagnostics",
            "2026-07-17T12:00:00Z",
            {
                "title": "Checkout failed",
                "level": "error",
                "exception": exception,
                "stackFrames": stack_frames,
                "breadcrumbs": breadcrumbs,
                "breadcrumbsTruncated": True,
            },
        )
        exception["type"] = "CallerMutation"
        stack_frames[0]["filename"] = "caller-mutation.py"
        breadcrumbs[0]["message"] = "caller mutation"
        breadcrumb_data["attempt"] = 99

        attributes = json.loads(client.preview_json())["events"][0]["attributes"]
        self.assertEqual(
            attributes["exception"],
            {
                "type": "CheckoutError",
                "mechanism": {"type": "python.exception", "handled": False},
            },
        )
        self.assertEqual(
            attributes["stackFrames"],
            [
                {
                    "filename": "checkout.py",
                    "line": 42,
                    "column": 7,
                    "function": "submit_checkout",
                    "module": "checkout.handlers",
                    "inApp": True,
                }
            ],
        )
        self.assertEqual(
            attributes["breadcrumbs"],
            [
                {
                    "timestamp": "2026-07-17T11:59:00Z",
                    "type": "navigation",
                    "category": "checkout.step",
                    "level": "warning",
                    "message": "Payment step opened",
                    "data": {"attempt": 2, "cached": False},
                }
            ],
        )
        self.assertIs(attributes["breadcrumbsTruncated"], True)

    def test_issue_diagnostic_evidence_survives_the_client_boundary(self) -> None:
        client = sample_client()
        evidence: IssueDiagnosticEvidence = {
            "likelyRootCause": "The payment provider exhausted its retry budget.",
            "likelyFixArea": {
                "component": "checkout-api",
                "module": "payments.gateway",
                "function": "charge_order",
                "file": "src/payments/gateway.py",
                "line": 42,
                "column": 7,
                "inApp": True,
            },
            "impact": {
                "affectedUserSegment": "checkout-users",
                "failedAction": "checkout.submit",
                "userVisibleOutcome": "The order was not confirmed.",
            },
            "capturedFields": ["provider.status", "retry.count"],
            "missingFields": ["provider.request_id"],
            "redactedFields": ["provider.message"],
            "truncatedFields": ["breadcrumbs"],
        }
        client.issue(
            "evt_issue_evidence",
            "2026-07-17T12:00:00Z",
            cast(
                IssueAttributes,
                {"title": "Checkout failed", "level": "error", "evidence": evidence},
            ),
        )
        evidence["likelyFixArea"]["file"] = "mutated.py"
        evidence["capturedFields"].append("mutated")

        attributes = json.loads(client.preview_json())["events"][0]["attributes"]
        self.assertEqual(attributes["evidence"]["likelyFixArea"]["file"], "src/payments/gateway.py")
        self.assertEqual(attributes["evidence"]["capturedFields"], ["provider.status", "retry.count"])

    def test_issue_diagnostics_reject_unsafe_shapes(self) -> None:
        invalid_diagnostics: list[dict[str, Any]] = [
            {"exception": {"type": "CheckoutError", "mechanism": {"type": "python.exception"}}},
            {"exception": {"type": "Checkout?Error"}},
            {"exception": {"type": "CheckoutError", "private": "unsupported"}},
            {"stackFrames": []},
            {"stackFrames": [{"filename": "checkout.py", "line": 0, "column": 1}]},
            {
                "stackFrames": [
                    {"filename": "checkout.py", "line": 1, "column": 1}
                    for _ in range(33)
                ]
            },
            {"breadcrumbs": []},
            {
                "breadcrumbs": [
                    {"timestamp": "2026-07-17T12:00:00Z", "category": "checkout"}
                    for _ in range(65)
                ]
            },
            {"breadcrumbs": [{"timestamp": "not-a-date", "category": "checkout"}]},
            {
                "breadcrumbs": [
                    {
                        "timestamp": "2026-07-17T12:00:00Z",
                        "category": "checkout",
                        "data": {"nested": {}},
                    }
                ]
            },
            {
                "breadcrumbs": [
                    {
                        "timestamp": "2026-07-17T12:00:00Z",
                        "category": "checkout",
                        "data": {"duration": float("nan")},
                    }
                ]
            },
            {"breadcrumbsTruncated": "yes"},
            {"evidence": {}},
            {"evidence": {"likelyFixArea": {"inApp": True}}},
            {"evidence": {"likelyFixArea": {"file": "/srv/example/app.py"}}},
            {"evidence": {"likelyFixArea": {"file": " /srv/example/app.py"}}},
            {
                "evidence": {
                    "capturedFields": ["provider.status"],
                    "missingFields": ["provider.status"],
                }
            },
            {"evidence": {"capturedFields": ["bad field"]}},
        ]

        for diagnostics in invalid_diagnostics:
            with self.subTest(diagnostics=diagnostics):
                client = sample_client()
                with self.assertRaisesRegex(SdkError, "issue"):
                    client.issue(
                        "evt_invalid_diagnostics",
                        "2026-07-17T12:00:00Z",
                        cast(
                            IssueAttributes,
                            {
                                "title": "Invalid diagnostics",
                                "level": "error",
                                **diagnostics,
                            },
                        ),
                    )

    def test_create_issue_attributes_from_exception_sanitizes_traceback(self) -> None:
        evidence: IssueDiagnosticEvidence = {
            "likelyFixArea": {"file": "src/payments/gateway.py", "line": 42},
            "missingFields": ["provider.request_id"],
        }

        def fail_checkout() -> None:
            raise LookupError("payment method is unavailable")

        try:
            fail_checkout()
        except LookupError as error:
            attributes = create_issue_attributes_from_exception(
                error,
                title="Checkout failed",
                mechanism="python.framework",
                handled=False,
                evidence=evidence,
                metadata={"framework": "example"},
            )

        self.assertEqual(attributes["title"], "Checkout failed")
        self.assertEqual(attributes["message"], "payment method is unavailable")
        self.assertEqual(
            attributes["exception"],
            {
                "type": "LookupError",
                "mechanism": {"type": "python.framework", "handled": False},
            },
        )
        self.assertEqual(attributes["stackFrames"][0]["filename"], "test_sdk.py")
        self.assertEqual(attributes["stackFrames"][0]["function"], "fail_checkout")
        self.assertEqual(attributes["stackFrames"][0]["module"], __name__)
        self.assertEqual(
            attributes["exceptionChain"],
            {
                "entries": [
                    {
                        "id": 0,
                        "relationship": "reported",
                        "type": "LookupError",
                        "message": "payment method is unavailable",
                        "messageState": "captured",
                        "mechanism": {"type": "python.framework", "handled": False},
                        "stackFrames": attributes["stackFrames"],
                        "stackFramesState": "captured",
                    }
                ],
                "truncated": False,
            },
        )
        self.assertNotIn("workspace", json.dumps(attributes))
        self.assertEqual(attributes["evidence"], evidence)

        UnsafeError = type("Unsafe/Error", (Exception,), {})
        unsafe_attributes = create_issue_attributes_from_exception(
            UnsafeError("safe message"),
            include_stack_frames=False,
        )
        self.assertEqual(unsafe_attributes["exception"]["type"], "Exception")
        self.assertEqual(
            unsafe_attributes["exceptionChain"]["entries"][0]["stackFramesState"],
            "not_captured",
        )
        self.assertNotIn("Unsafe/Error", json.dumps(unsafe_attributes))

    def test_create_issue_attributes_preserves_cause_tree_and_explicit_states(self) -> None:
        def fail_payment() -> None:
            raise TimeoutError("payment provider timed out")

        def submit_checkout() -> None:
            try:
                fail_payment()
            except TimeoutError as cause:
                raise RuntimeError("checkout failed") from cause

        try:
            submit_checkout()
        except RuntimeError as error:
            attributes = create_issue_attributes_from_exception(
                error,
                mechanism="python.framework",
                handled=False,
            )

        chain = attributes["exceptionChain"]
        self.assertFalse(chain["truncated"])
        self.assertEqual(2, len(chain["entries"]))
        reported, cause = chain["entries"]
        self.assertEqual(
            (reported["id"], reported["relationship"], reported["type"]),
            (0, "reported", "RuntimeError"),
        )
        self.assertEqual(reported["messageState"], "captured")
        self.assertEqual(reported["stackFramesState"], "captured")
        self.assertEqual(
            (cause["id"], cause["parentId"], cause["relationship"], cause["type"]),
            (1, 0, "cause", "TimeoutError"),
        )
        self.assertEqual(cause["message"], "payment provider timed out")
        self.assertEqual(cause["messageState"], "captured")
        self.assertEqual(cause["mechanism"], {"type": "python.cause", "handled": True})
        self.assertEqual(cause["stackFrames"][0]["function"], "fail_payment")

    def test_exception_chain_caps_cycles_and_messages_without_hiding_state(self) -> None:
        first = RuntimeError("a" * 1_100)
        second = LookupError("underlying")
        first.__cause__ = second
        second.__cause__ = first

        attributes = create_issue_attributes_from_exception(first, include_stack_frames=False)

        chain = attributes["exceptionChain"]
        self.assertTrue(chain["truncated"])
        self.assertEqual(2, len(chain["entries"]))
        self.assertEqual(chain["entries"][0]["messageState"], "truncated")
        self.assertEqual(len(chain["entries"][0]["message"]), 1_024)
        self.assertEqual(chain["entries"][0]["stackFramesState"], "not_captured")
        self.assertNotIn("stackFrames", chain["entries"][0])

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

    def test_span_events_are_privacy_bounded_and_capped(self) -> None:
        client = sample_client()
        attributes: Any = {
            "name": "POST /checkout",
            "traceId": "trace_001",
            "spanId": "span_001",
            "status": "ok",
            "durationMs": 42.5,
            "events": [
                {
                    "name": "db.query.started",
                    "timestamp": "2026-06-02T10:00:04.010Z",
                    "metadata": {
                        "rowCount": 3,
                        "statementParams": {"email": "private@example.test"},
                    },
                },
                *[
                    {"name": f"milestone.{index}", "metadata": {"index": index}}
                    for index in range(10)
                ],
            ],
        }

        client.span(
            "evt_span_events_001",
            "2026-06-02T10:00:04Z",
            attributes,
        )

        event = json.loads(client.preview_json())["events"][0]
        span_events = event["attributes"]["events"]
        self.assertEqual(len(span_events), 8)
        self.assertEqual(
            span_events[0],
            {
                "name": "db.query.started",
                "timestamp": "2026-06-02T10:00:04.010Z",
                "metadata": {"rowCount": 3},
            },
        )
        self.assertEqual(span_events[-1]["name"], "milestone.6")
        serialized = client.preview_json()
        self.assertNotIn("private@example.test", serialized)
        self.assertNotIn("statementParams", serialized)

    def test_span_events_reject_invalid_shape(self) -> None:
        client = sample_client()

        with self.assertRaisesRegex(SdkError, "span event name must be non-empty"):
            client.span(
                "evt_span_events_invalid",
                "2026-06-02T10:00:04Z",
                {
                    "name": "POST /checkout",
                    "traceId": "trace_001",
                    "spanId": "span_001",
                    "status": "ok",
                    "events": [{"name": ""}],
                },
            )

        with self.assertRaisesRegex(SdkError, "timestamp must include a timezone offset"):
            client.span(
                "evt_span_events_invalid_timestamp",
                "2026-06-02T10:00:04Z",
                {
                    "name": "POST /checkout",
                    "traceId": "trace_001",
                    "spanId": "span_001",
                    "status": "ok",
                    "events": [{"name": "db.query", "timestamp": "2026-06-02T10:00:04"}],
                },
            )

    def test_metric_event_validates_explicit_contract(self) -> None:
        client = sample_client()

        client.metric(
            "evt_metric_001",
            "2026-06-02T10:00:06Z",
            {
                "name": "queue.depth",
                "description": "  Number of items waiting in the checkout queue.  ",
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
                "description": "Number of items waiting in the checkout queue.",
                "kind": "gauge",
                "value": -2,
                "unit": "{items}",
                "temporality": "instant",
                "metadata": {"service": "worker", "queue": "critical"},
            },
        )

    def test_metric_rejects_unsafe_description(self) -> None:
        descriptions = (
            None,
            42,
            "",
            "   ",
            "M" * 1_025,
            "request\u0085count",
            "request\u2028count",
            "request\ud800count",
        )
        for description in descriptions:
            with self.subTest(description=description), self.assertRaisesRegex(
                SdkError,
                "metric description must be a non-blank string of at most 1024 non-control characters",
            ):
                sample_client().metric(
                    "evt_metric_001",
                    "2026-06-02T10:00:06Z",
                    {
                        "name": "queue.depth",
                        "description": description,  # type: ignore[typeddict-item]
                        "kind": "gauge",
                        "value": 2,
                        "unit": "{items}",
                        "temporality": "instant",
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
                "metadata": {
                    "service": "checkout",
                    "payload": {"card": "private"},
                    "analyticsSchemaVersion": 99,
                    "analyticsKind": "page_view",
                    "analyticsSurface": "/spoofed",
                },
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
                    "analyticsSchemaVersion": 1,
                    "analyticsKind": "interaction",
                    "analyticsSurface": "/checkout/:step",
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

    def test_open_telemetry_span_context_creates_child_logbrew_trace(self) -> None:
        otel_context = FakeOpenTelemetrySpanContext(
            trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
            span_id=int("00f067aa0ba902b7", 16),
            trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
        )

        trace = logbrew_trace_context_from_open_telemetry_span_context(
            otel_context,
            span_id="b7ad6b7169203331",
        )

        self.assertEqual(
            trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203331",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )

    def test_open_telemetry_span_creates_child_logbrew_trace_from_int_flags(self) -> None:
        otel_context = FakeOpenTelemetrySpanContext(
            trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
            span_id=int("00f067aa0ba902b7", 16),
            trace_flags=1,
        )

        trace = logbrew_trace_context_from_open_telemetry_span(
            FakeOpenTelemetrySpan(otel_context),
            span_id="b7ad6b7169203331",
        )

        self.assertIsNotNone(trace)
        assert trace is not None
        self.assertEqual(trace.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(trace.span_id, "b7ad6b7169203331")
        self.assertEqual(trace.parent_span_id, "00f067aa0ba902b7")
        self.assertIs(trace.sampled, True)

    def test_open_telemetry_helpers_return_none_for_invalid_contexts(self) -> None:
        invalid_contexts = [
            FakeOpenTelemetrySpanContext(
                trace_id=0,
                span_id=int("00f067aa0ba902b7", 16),
                trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
            ),
            FakeOpenTelemetrySpanContext(
                trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
                span_id=0,
                trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
            ),
            FakeOpenTelemetrySpanContext(
                trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
                span_id=int("00f067aa0ba902b7", 16),
                trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
                is_valid=False,
            ),
        ]

        for invalid_context in invalid_contexts:
            self.assertIsNone(
                logbrew_trace_context_from_open_telemetry_span_context(
                    invalid_context,
                    span_id="b7ad6b7169203331",
                )
            )
            self.assertIsNone(
                logbrew_trace_context_from_open_telemetry_span(
                    FakeOpenTelemetrySpan(invalid_context),
                    span_id="b7ad6b7169203331",
                )
            )

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

        with patch("logbrew_sdk.distribution_version", return_value="9.8.7"):
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
        self.assertEqual(headers["user-agent"], "logbrew-sdk-python/9.8.7")
        self.assertEqual(headers["x-logbrew-source"], "unit-test")

    def test_http_transport_preserves_custom_user_agent_case_insensitively(self) -> None:
        requests: list[Request] = []

        def open_url(request: Request, *, timeout: float) -> StubHttpResponse:
            requests.append(request)
            return StubHttpResponse(202)

        with (
            patch(
                "logbrew_sdk.distribution_version",
                side_effect=AssertionError("custom user agent must skip package lookup"),
            ),
            patch(
                "logbrew_sdk._default_http_ssl_context",
                side_effect=AssertionError("custom opener must skip default TLS setup"),
            ),
        ):
            transport = HttpTransport(
                endpoint="http://127.0.0.1:9/v1/events",
                headers={"User-Agent": "checkout-api/2.0"},
                open_url=open_url,
            )
            transport.send("LOGBREW_API_KEY", '{"events":[]}')

        headers = {key.lower(): value for key, value in requests[0].header_items()}
        self.assertEqual(headers["user-agent"], "checkout-api/2.0")

    def test_http_transport_uses_stable_user_agent_without_package_metadata(self) -> None:
        requests: list[Request] = []

        def open_url(request: Request, *, timeout: float) -> StubHttpResponse:
            requests.append(request)
            return StubHttpResponse(202)

        with patch(
            "logbrew_sdk.distribution_version",
            side_effect=PackageNotFoundError,
        ):
            transport = HttpTransport(
                endpoint="http://127.0.0.1:9/v1/events",
                open_url=open_url,
            )
            transport.send("LOGBREW_API_KEY", '{"events":[]}')

        headers = {key.lower(): value for key, value in requests[0].header_items()}
        self.assertEqual(headers["user-agent"], "logbrew-sdk-python")

    def test_http_transport_uses_native_and_portable_trust_by_default(self) -> None:
        requests: list[tuple[Request, float, object]] = []
        tls_context = object()

        def open_url(
            request: Request,
            *,
            timeout: float,
            context: object,
        ) -> StubHttpResponse:
            requests.append((request, timeout, context))
            return StubHttpResponse(202)

        with (
            patch("logbrew_sdk.urlopen", side_effect=open_url),
            patch(
                "logbrew_sdk._default_http_ssl_context",
                return_value=tls_context,
            ) as create_context,
        ):
            transport = HttpTransport(
                endpoint="https://api.example.test/v1/events",
                timeout=2.5,
            )
            response = transport.send("LOGBREW_API_KEY", '{"events":[]}')

        self.assertEqual(response.status_code, 202)
        create_context.assert_called_once_with()
        self.assertEqual(len(requests), 1)
        request, timeout, context = requests[0]
        self.assertEqual(request.full_url, "https://api.example.test/v1/events")
        self.assertEqual(timeout, 2.5)
        self.assertIs(context, tls_context)

    def test_http_transport_combines_native_and_portable_trust_roots(self) -> None:
        tls_context = MagicMock()

        def open_url(
            _request: Request,
            *,
            timeout: float,
            context: object,
        ) -> StubHttpResponse:
            self.assertEqual(timeout, 10.0)
            self.assertIs(context, tls_context)
            return StubHttpResponse(202)

        with (
            patch("logbrew_sdk.urlopen", side_effect=open_url),
            patch(
                "logbrew_sdk.truststore.SSLContext",
                return_value=tls_context,
            ) as create_native_context,
            patch(
                "logbrew_sdk.certifi.where",
                return_value="CERTIFI_CA_BUNDLE",
            ) as certifi_bundle,
        ):
            response = HttpTransport(
                endpoint="https://api.example.test/v1/events",
            ).send("LOGBREW_API_KEY", '{"events":[]}')

        self.assertEqual(response.status_code, 202)
        create_native_context.assert_called_once_with(ssl.PROTOCOL_TLS_CLIENT)
        certifi_bundle.assert_called_once_with()
        tls_context.load_verify_locations.assert_called_once_with("CERTIFI_CA_BUNDLE")

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
        serialized_failure = client.preview_json()
        self.assertNotIn("errorMessage", event["attributes"]["metadata"])
        self.assertNotIn("retry later", serialized_failure)
        self.assertNotIn("coupon=summer", serialized_failure)

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

    def test_requests_request_with_logbrew_span_injects_child_trace_and_queues_span(self) -> None:
        client = sample_client()
        request_active_trace: LogBrewTraceContext | None = None
        caller_headers = {"Traceparent": "spoofed", "x-caller": "checkout"}
        calls: list[dict[str, object]] = []
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([30.0, 30.052])

        class StubRequestsResponse:
            status_code = 201

        def request(method: str, url: str, **kwargs: object) -> StubRequestsResponse:
            nonlocal request_active_trace
            calls.append({"method": method, "url": url, **kwargs})
            request_active_trace = get_active_logbrew_trace()
            return StubRequestsResponse()

        with use_logbrew_trace(parent_trace):
            response = requests_request_with_logbrew_span(
                "post",
                "https://api.example.test/payments/123?coupon=summer#receipt",
                client=client,
                event_id="evt_python_requests_client",
                timestamp="2026-06-19T08:00:03Z",
                request=request,
                timeout=3.5,
                headers=caller_headers,
                json={"card": "private"},
                route_template="/payments/:payment_id",
                span_id_factory=lambda: "b7ad6b7169203334",
                clock=lambda: next(clock_values),
                metadata={"service": "checkout", "headers": {"authorization": "private"}},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(caller_headers["Traceparent"], "spoofed")
        call = calls[0]
        self.assertEqual(call["method"], "post")
        self.assertEqual(call["url"], "https://api.example.test/payments/123?coupon=summer#receipt")
        self.assertEqual(call["timeout"], 3.5)
        sent_headers = call["headers"]
        self.assertIsInstance(sent_headers, dict)
        assert isinstance(sent_headers, dict)
        self.assertIsNot(sent_headers, caller_headers)
        self.assertEqual(sent_headers["x-caller"], "checkout")
        self.assertEqual(
            sent_headers["traceparent"],
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203334-01",
        )
        self.assertNotIn("Traceparent", sent_headers)
        self.assertEqual(request_active_trace, LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="b7ad6b7169203334",
            parent_span_id="00f067aa0ba902b7",
            sampled=True,
        ))

        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(
            event["attributes"],
            {
                "name": "POST /payments/:payment_id",
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "b7ad6b7169203334",
                "parentSpanId": "00f067aa0ba902b7",
                "status": "ok",
                "durationMs": 52.0,
                "metadata": {
                    "source": "requests",
                    "service": "checkout",
                    "routeTemplate": "/payments/:payment_id",
                    "method": "POST",
                    "statusCode": 201,
                    "sampled": True,
                },
            },
        )
        serialized = client.preview_json()
        self.assertNotIn("coupon=summer", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("traceparent", serialized)
        self.assertNotIn("card", serialized)

    def test_requests_request_with_logbrew_span_preserves_errors_and_capture_failures(self) -> None:
        client = sample_client()

        class StubRequestsResponse:
            status_code = 503

        class StubRequestsError(RuntimeError):
            def __init__(self) -> None:
                super().__init__("connection failed for redacted-url")
                self.response = StubRequestsResponse()

        original_error = StubRequestsError()

        with self.assertRaises(StubRequestsError) as raised:
            requests_request_with_logbrew_span(
                "GET",
                "https://api.example.test/payments/123?coupon=summer",
                client=client,
                event_id="evt_python_requests_failure",
                timestamp="2026-06-19T08:00:04Z",
                request=lambda _method, _url, **_kwargs: (_ for _ in ()).throw(original_error),
                span_id_factory=lambda: "b7ad6b7169203335",
                clock=lambda: 40.0,
            )

        self.assertIs(raised.exception, original_error)
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["source"], "requests")
        self.assertEqual(event["attributes"]["metadata"]["statusCode"], 503)
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "StubRequestsError")
        serialized_failure = client.preview_json()
        self.assertNotIn("errorMessage", event["attributes"]["metadata"])
        self.assertNotIn("connection failed for redacted-url", serialized_failure)
        self.assertNotIn("coupon=summer", serialized_failure)

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        response = requests_request_with_logbrew_span(
            "GET",
            "https://api.example.test/health",
            client=closed_client,
            event_id="evt_python_requests_capture_error",
            timestamp="2026-06-19T08:00:05Z",
            request=lambda _method, _url, **_kwargs: StubRequestsResponse(),
            span_id_factory=lambda: "b7ad6b7169203336",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(response.status_code, 503)
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
