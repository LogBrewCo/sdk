from __future__ import annotations

import json
import unittest
from typing import Any

import queue_framework_contract as contract
from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    celery_operation_with_logbrew_span,
    create_celery_trace_headers,
    logbrew_trace_context_from_celery_headers,
    use_logbrew_trace,
)


class StubCeleryTask:
    name = "checkout.send_email"

    def __init__(self) -> None:
        self.request: dict[str, Any] = {
            "delivery_info": {
                "routing_key": "email",
                "broker_url": "amqp://placeholder.invalid/vhost",
            },
            "args": ["raw-order-id"],
            "kwargs": {"payload": "raw job body"},
            "headers": {"traceparent": "raw trace header"},
        }


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class CeleryOperationSpanTests(contract.QueueFrameworkContract):
    framework = "celery"
    object_parameter = "task"
    queue_name = "email"
    operation = staticmethod(celery_operation_with_logbrew_span)
    entity_factory = staticmethod(StubCeleryTask)
    private_values = ("raw-order-id", "raw job body", "amqp://", "traceparent")

    def test_create_celery_trace_headers_uses_active_trace_only(self) -> None:
        active_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )

        with use_logbrew_trace(active_trace):
            headers = create_celery_trace_headers()

        self.assertEqual(
            headers,
            {
                "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            },
        )
        self.assertNotIn("baggage", headers)
        self.assertNotIn("tracestate", headers)
        self.assertNotIn("headers", headers)

    def test_celery_operation_continues_valid_task_traceparent(self) -> None:
        client = sample_client()
        task = StubCeleryTask()
        task.request = {
            "headers": {
                "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
                "baggage": "private=value",
                "headers": {
                    "traceparent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2222222222222222-01",
                },
            },
            "delivery_info": {
                "routing_key": "email",
            },
        }
        parent_trace = logbrew_trace_context_from_celery_headers(
            task.request["headers"]
        )
        self.assertEqual(
            parent_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="1111111111111111",
                sampled=True,
            ),
        )

        result = celery_operation_with_logbrew_span(
            client=client,
            event_id="evt_python_celery_process",
            timestamp="2026-06-19T15:00:02Z",
            task=task,
            operation=lambda: "processed",
            operation_kind="process",
            span_id_factory=lambda: "b7ad6b7169203373",
            clock=lambda: 520.0,
        )

        self.assertEqual(result, "processed")
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(
            event["attributes"]["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736"
        )
        self.assertEqual(event["attributes"]["spanId"], "b7ad6b7169203373")
        self.assertEqual(event["attributes"]["parentSpanId"], "1111111111111111")
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["queueName"], "email")
        self.assertEqual(metadata["taskName"], "checkout.send_email")
        serialized = client.preview_json()
        self.assertNotIn("private=value", serialized)
        self.assertNotIn("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", serialized)
        self.assertNotIn("traceparent", serialized)
        self.assertNotIn("baggage", serialized)

    def test_celery_trace_context_from_headers_ignores_malformed_traceparent(
        self,
    ) -> None:
        self.assertIsNone(
            logbrew_trace_context_from_celery_headers({"traceparent": "bad"})
        )
        self.assertIsNone(logbrew_trace_context_from_celery_headers(None))

    def test_celery_trace_context_from_headers_uses_nested_when_direct_is_malformed(
        self,
    ) -> None:
        parent_trace = logbrew_trace_context_from_celery_headers(
            {
                "traceparent": "bad",
                "headers": {
                    "TraceParent": "00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-00",
                },
            }
        )

        self.assertEqual(
            parent_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="2222222222222222",
                sampled=False,
            ),
        )


if __name__ == "__main__":
    unittest.main()
