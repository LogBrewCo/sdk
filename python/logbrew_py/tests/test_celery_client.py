from __future__ import annotations

import json
import unittest
from typing import Any, ClassVar

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    celery_operation_with_logbrew_span,
    get_active_logbrew_trace,
    use_logbrew_trace,
)


class StubCeleryTask:
    name = "checkout.send_email"
    request: ClassVar[dict[str, Any]] = {
        "delivery_info": {
            "routing_key": "email",
            "broker_url": "amqp://user:pass@broker.internal/vhost",
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


class CeleryOperationSpanTests(unittest.TestCase):
    def test_celery_operation_with_logbrew_span_derives_safe_task_metadata(self) -> None:
        client = sample_client()
        task = StubCeleryTask()
        active_trace: LogBrewTraceContext | None = None
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([500.0, 500.019])

        def apply_async() -> str:
            nonlocal active_trace
            active_trace = get_active_logbrew_trace()
            return "published"

        with use_logbrew_trace(parent_trace):
            result = celery_operation_with_logbrew_span(
                client=client,
                event_id="evt_python_celery_publish",
                timestamp="2026-06-19T15:00:00Z",
                task=task,
                operation=apply_async,
                operation_kind="publish",
                metadata={
                    "service": "checkout-worker",
                    "headers": "raw headers",
                    "kwargs": "raw kwargs",
                },
                span_events=[
                    {
                        "name": "celery.task.published",
                        "metadata": {
                            "worker": "worker-a",
                            "kwargs": "raw kwargs",
                        },
                    }
                ],
                span_id_factory=lambda: "b7ad6b7169203371",
                clock=lambda: next(clock_values),
            )

        self.assertEqual(result, "published")
        self.assertEqual(
            active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203371",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "celery publish checkout.send_email")
        self.assertEqual(event["attributes"]["durationMs"], 19.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "queue")
        self.assertEqual(metadata["queueSystem"], "celery")
        self.assertEqual(metadata["queueOperation"], "publish checkout.send_email")
        self.assertEqual(metadata["queueOperationKind"], "publish")
        self.assertEqual(metadata["queueName"], "email")
        self.assertEqual(metadata["taskName"], "checkout.send_email")
        self.assertEqual(metadata["messageCount"], 1)
        self.assertEqual(metadata["service"], "checkout-worker")
        self.assertTrue(metadata["sampled"])
        self.assertEqual(
            event["attributes"]["events"],
            [{"name": "celery.task.published", "metadata": {"worker": "worker-a"}}],
        )
        serialized = client.preview_json()
        self.assertNotIn("raw-order-id", serialized)
        self.assertNotIn("raw job body", serialized)
        self.assertNotIn("raw headers", serialized)
        self.assertNotIn("raw kwargs", serialized)
        self.assertNotIn("amqp://", serialized)
        self.assertNotIn("traceparent", serialized)
        self.assertNotIn("headers", serialized)
        self.assertNotIn("kwargs", serialized)

    def test_celery_operation_with_logbrew_span_accepts_explicit_queue_and_task_names(self) -> None:
        client = sample_client()

        class MinimalTask:
            pass

        result = celery_operation_with_logbrew_span(
            client=client,
            event_id="evt_python_celery_process",
            timestamp="2026-06-19T15:00:01Z",
            task=MinimalTask(),
            operation=lambda: "processed",
            operation_kind="process",
            queue_name="critical",
            task_name="checkout.rebuild_index",
            span_id_factory=lambda: "b7ad6b7169203372",
            clock=lambda: 510.0,
        )

        self.assertEqual(result, "processed")
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "celery process checkout.rebuild_index")
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["queueName"], "critical")
        self.assertEqual(metadata["taskName"], "checkout.rebuild_index")


if __name__ == "__main__":
    unittest.main()
