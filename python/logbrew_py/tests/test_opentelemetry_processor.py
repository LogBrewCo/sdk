from __future__ import annotations

import json
import unittest
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    SdkError,
    create_logbrew_open_telemetry_span_processor,
    span_attributes_from_open_telemetry_readable_span,
)


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


class FakeOpenTelemetryStatusCode:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeOpenTelemetryStatus:
    def __init__(self, name: str) -> None:
        self.status_code = FakeOpenTelemetryStatusCode(name)


class FakeOpenTelemetryResource:
    def __init__(self, attributes: dict[str, Any]) -> None:
        self.attributes = attributes


class FakeOpenTelemetryScope:
    def __init__(self, name: str, version: str) -> None:
        self.name = name
        self.version = version


class FakeOpenTelemetryEvent:
    def __init__(
        self,
        name: str,
        *,
        timestamp: int | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        self.name = name
        self.timestamp = timestamp
        self.attributes = attributes or {}


class FakeOpenTelemetryLink:
    def __init__(
        self,
        *,
        context: FakeOpenTelemetrySpanContext,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        self.context = context
        self.attributes = attributes or {}


class FakeOpenTelemetryReadableSpan:
    def __init__(
        self,
        *,
        name: str,
        context: FakeOpenTelemetrySpanContext,
        parent: FakeOpenTelemetrySpanContext | None = None,
        status_name: str = "OK",
        kind: str = "SERVER",
        attributes: dict[str, Any] | None = None,
        resource_attributes: dict[str, Any] | None = None,
        events: list[FakeOpenTelemetryEvent] | None = None,
        links: list[FakeOpenTelemetryLink] | None = None,
        start_time: int = 1_780_000_000_000_000_000,
        end_time: int = 1_780_000_000_025_000_000,
        dropped_attributes: int = 0,
        dropped_events: int = 0,
        dropped_links: int = 0,
    ) -> None:
        self.name = name
        self._context = context
        self.parent = parent
        self.status = FakeOpenTelemetryStatus(status_name)
        self.kind = kind
        self.attributes = attributes or {}
        self.resource = FakeOpenTelemetryResource(resource_attributes or {})
        self.events = events or []
        self.links = links or []
        self.start_time = start_time
        self.end_time = end_time
        self.dropped_attributes = dropped_attributes
        self.dropped_events = dropped_events
        self.dropped_links = dropped_links
        self.instrumentation_scope = FakeOpenTelemetryScope("pytest.otel", "1.2.3")

    def get_span_context(self) -> FakeOpenTelemetrySpanContext:
        return self._context


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class OpenTelemetryProcessorTests(unittest.TestCase):
    def test_open_telemetry_readable_span_attrs_are_privacy_bounded(self) -> None:
        span = FakeOpenTelemetryReadableSpan(
            name="POST /checkout",
            context=FakeOpenTelemetrySpanContext(
                trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
                span_id=int("b7ad6b7169203331", 16),
                trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
            ),
            parent=FakeOpenTelemetrySpanContext(
                trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
                span_id=int("00f067aa0ba902b7", 16),
                trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
            ),
            status_name="ERROR",
            attributes={
                "http.method": "POST",
                "http.route": "/checkout/:step",
                "http.url": "https://api.example.test/checkout?debug=blocked",
                "db.statement": "SELECT * FROM users WHERE email='blocked@example.test'",
                "http.request.header.authorization": "Bearer blocked",
                "custom.safe": "allowlisted",
                "nested": {"payload": "blocked"},
            },
            resource_attributes={
                "service.name": "checkout-api",
                "service.version": "2026.07.01",
                "deployment.environment": "production",
                "cloud.account.id": "blocked",
            },
            events=[
                FakeOpenTelemetryEvent(
                    "exception",
                    timestamp=1_780_000_000_010_000_000,
                    attributes={
                        "exception.type": "ValueError",
                        "exception.message": "card blocked@example.test failed",
                        "exception.stacktrace": "blocked stack",
                        "exception.escaped": True,
                    },
                )
            ],
            links=[
                FakeOpenTelemetryLink(
                    context=FakeOpenTelemetrySpanContext(
                        trace_id=int("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 16),
                        span_id=int("bbbbbbbbbbbbbbbb", 16),
                        trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
                    ),
                    attributes={
                        "messaging.operation.name": "process",
                        "messaging.message.id": "blocked-message-id",
                        "safe.link": "fan-in",
                    },
                ),
                FakeOpenTelemetryLink(
                    context=FakeOpenTelemetrySpanContext(
                        trace_id=int("cccccccccccccccccccccccccccccccc", 16),
                        span_id=int("dddddddddddddddd", 16),
                        trace_flags=FakeOpenTelemetryTraceFlags(sampled=False),
                    ),
                    attributes={"safe.link": "retry"},
                ),
            ],
            dropped_attributes=2,
            dropped_events=1,
            dropped_links=3,
        )

        attributes = span_attributes_from_open_telemetry_readable_span(
            span,
            attribute_keys=["custom.safe"],
            link_attribute_keys=["safe.link"],
            metadata={"team": "payments", "payload": {"card": "blocked"}},
        )

        self.assertIsNotNone(attributes)
        assert attributes is not None
        self.assertEqual(attributes["name"], "POST /checkout")
        self.assertEqual(attributes["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(attributes["spanId"], "b7ad6b7169203331")
        self.assertEqual(attributes["parentSpanId"], "00f067aa0ba902b7")
        self.assertEqual(attributes["status"], "error")
        self.assertEqual(attributes["durationMs"], 25.0)
        self.assertEqual(
            attributes["metadata"],
            {
                "source": "opentelemetry.readable_span",
                "team": "payments",
                "service.name": "checkout-api",
                "service.version": "2026.07.01",
                "deployment.environment": "production",
                "otel.kind": "server",
                "otel.scope.name": "pytest.otel",
                "otel.scope.version": "1.2.3",
                "otel.dropped_attributes_count": 2,
                "otel.dropped_events_count": 1,
                "otel.dropped_links_count": 3,
                "http.method": "POST",
                "http.route": "/checkout/:step",
                "custom.safe": "allowlisted",
            },
        )
        self.assertEqual(
            attributes["events"],
            [
                {
                    "name": "exception",
                    "timestamp": "2026-05-28T20:26:40.010Z",
                    "metadata": {
                        "exception.type": "ValueError",
                        "exception.escaped": True,
                    },
                }
            ],
        )
        self.assertEqual(
            attributes["links"],
            [
                {
                    "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "spanId": "bbbbbbbbbbbbbbbb",
                    "sampled": True,
                    "metadata": {"safe.link": "fan-in"},
                },
                {
                    "traceId": "cccccccccccccccccccccccccccccccc",
                    "spanId": "dddddddddddddddd",
                    "sampled": False,
                    "metadata": {"safe.link": "retry"},
                },
            ],
        )

        serialized = json.dumps(attributes)
        self.assertNotIn("blocked@example.test", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("db.statement", serialized)
        self.assertNotIn("http.url", serialized)
        self.assertNotIn("blocked-message-id", serialized)
        with self.assertRaisesRegex(SdkError, "cannot include sensitive key: db.statement"):
            span_attributes_from_open_telemetry_readable_span(span, attribute_keys=["db.statement"])
        with self.assertRaisesRegex(SdkError, "cannot include sensitive key: messaging.message.id"):
            span_attributes_from_open_telemetry_readable_span(span, link_attribute_keys=["messaging.message.id"])

    def test_open_telemetry_span_processor_queues_details_and_trace_summary(self) -> None:
        client = sample_client()
        root_context = FakeOpenTelemetrySpanContext(
            trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
            span_id=int("00f067aa0ba902b7", 16),
            trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
        )
        child_context = FakeOpenTelemetrySpanContext(
            trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
            span_id=int("b7ad6b7169203331", 16),
            trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
        )
        processor = create_logbrew_open_telemetry_span_processor(
            client=client,
            include_trace_summary=True,
            link_attribute_keys=["messaging.operation.name"],
            timestamp_factory=lambda: "2026-07-01T12:00:00Z",
            metadata={"release": "2026.07.01"},
        )

        processor.on_end(
            FakeOpenTelemetryReadableSpan(
                name="GET /checkout",
                context=root_context,
                status_name="ERROR",
                attributes={"http.method": "GET", "http.route": "/checkout"},
                resource_attributes={"service.name": "checkout-api", "deployment.environment": "production"},
                start_time=1_780_000_000_000_000_000,
                end_time=1_780_000_000_040_000_000,
            )
        )
        processor.on_end(
            FakeOpenTelemetryReadableSpan(
                name="redis GET",
                context=child_context,
                parent=root_context,
                attributes={"db.system": "redis", "db.operation.name": "GET"},
                links=[
                    FakeOpenTelemetryLink(
                        context=FakeOpenTelemetrySpanContext(
                            trace_id=int("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 16),
                            span_id=int("bbbbbbbbbbbbbbbb", 16),
                            trace_flags=FakeOpenTelemetryTraceFlags(sampled=True),
                        ),
                        attributes={"messaging.operation.name": "receive"},
                    )
                ],
                resource_attributes={"service.name": "checkout-api"},
                start_time=1_780_000_000_010_000_000,
                end_time=1_780_000_000_020_000_000,
            )
        )

        self.assertTrue(processor.force_flush())
        payload = json.loads(client.preview_json())
        self.assertEqual([event["id"] for event in payload["events"]], ["otel_1", "otel_2", "otel_trace_1"])
        self.assertEqual(payload["events"][0]["attributes"]["status"], "error")
        self.assertEqual(payload["events"][1]["attributes"]["parentSpanId"], "00f067aa0ba902b7")
        self.assertEqual(
            payload["events"][1]["attributes"]["links"],
            [
                {
                    "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "spanId": "bbbbbbbbbbbbbbbb",
                    "sampled": True,
                    "metadata": {"messaging.operation.name": "receive"},
                }
            ],
        )

        summary = payload["events"][2]["attributes"]
        self.assertEqual(summary["name"], "opentelemetry.trace:GET /checkout")
        self.assertEqual(summary["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(summary["status"], "error")
        self.assertEqual(summary["durationMs"], 40.0)
        self.assertEqual(
            summary["metadata"],
            {
                "source": "opentelemetry.trace_summary",
                "service.name": "checkout-api",
                "deployment.environment": "production",
                "http.method": "GET",
                "http.route": "/checkout",
                "db.system": "redis",
                "db.operation.name": "GET",
                "otel.trace.span_count": 2,
                "otel.trace.error_span_count": 1,
                "otel.trace.root_span_id": "00f067aa0ba902b7",
                "otel.trace.root_name": "GET /checkout",
                "otel.trace.root_kind": "server",
                "otel.trace.summary_kind": "rooted",
            },
        )

        self.assertTrue(processor.shutdown())
        processor.on_end(
            FakeOpenTelemetryReadableSpan(
                name="ignored after shutdown",
                context=child_context,
                parent=root_context,
            )
        )
        self.assertEqual(len(json.loads(client.preview_json())["events"]), 3)

    def test_open_telemetry_span_processor_skips_unsampled_spans_by_default(self) -> None:
        client = sample_client()
        span = FakeOpenTelemetryReadableSpan(
            name="unsampled",
            context=FakeOpenTelemetrySpanContext(
                trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
                span_id=int("b7ad6b7169203331", 16),
                trace_flags=FakeOpenTelemetryTraceFlags(sampled=False),
            ),
        )

        self.assertIsNone(span_attributes_from_open_telemetry_readable_span(span))
        create_logbrew_open_telemetry_span_processor(client=client).on_end(span)
        self.assertEqual(client.pending_events(), 0)

        capture_unsampled = create_logbrew_open_telemetry_span_processor(
            client=client,
            capture_unsampled=True,
        )
        capture_unsampled.on_end(span)
        self.assertEqual(client.pending_events(), 1)


if __name__ == "__main__":
    unittest.main()
