from __future__ import annotations

import asyncio
import json
import unittest

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    async_queue_operation_with_logbrew_span,
    get_active_logbrew_trace,
    queue_operation_with_logbrew_span,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class QueueOperationSpanTests(unittest.TestCase):
    def test_queue_operation_with_logbrew_span_queues_privacy_bounded_span(self) -> None:
        client = sample_client()
        active_trace: LogBrewTraceContext | None = None
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([300.0, 300.011])

        def operation() -> str:
            nonlocal active_trace
            active_trace = get_active_logbrew_trace()
            return "queued"

        with use_logbrew_trace(parent_trace):
            result = queue_operation_with_logbrew_span(
                operation_name="publish checkout.email",
                client=client,
                event_id="evt_python_queue_publish",
                timestamp="2026-06-19T13:00:00Z",
                operation=operation,
                system="celery",
                operation_kind="publish",
                queue_name="email",
                task_name="checkout.email",
                message_count=1,
                attempt=2,
                span_id_factory=lambda: "b7ad6b7169203361",
                clock=lambda: next(clock_values),
                metadata={
                    "service": "checkout",
                    "messageBody": "raw job payload",
                    "headers": "trace headers",
                    "jobArgs": "task inputs",
                },
                span_events=[
                    {
                        "name": "queue.publish.confirmed",
                        "metadata": {
                            "brokerPartition": 4,
                            "messagePayload": "raw job payload",
                        },
                    }
                ],
            )

        self.assertEqual(result, "queued")
        self.assertEqual(
            active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203361",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "celery publish checkout.email")
        self.assertEqual(event["attributes"]["durationMs"], 11.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "queue")
        self.assertEqual(metadata["queueSystem"], "celery")
        self.assertEqual(metadata["queueOperation"], "publish checkout.email")
        self.assertEqual(metadata["queueOperationKind"], "publish")
        self.assertEqual(metadata["queueName"], "email")
        self.assertEqual(metadata["taskName"], "checkout.email")
        self.assertEqual(metadata["messageCount"], 1)
        self.assertEqual(metadata["attempt"], 2)
        self.assertEqual(metadata["service"], "checkout")
        self.assertTrue(metadata["sampled"])
        self.assertEqual(
            event["attributes"]["events"],
            [{"name": "queue.publish.confirmed", "metadata": {"brokerPartition": 4}}],
        )
        serialized = client.preview_json()
        self.assertNotIn("raw job payload", serialized)
        self.assertNotIn("trace headers", serialized)
        self.assertNotIn("task inputs", serialized)
        self.assertNotIn("messageBody", serialized)
        self.assertNotIn("headers", serialized)
        self.assertNotIn("jobArgs", serialized)
        self.assertNotIn("messagePayload", serialized)

    def test_queue_operation_with_logbrew_span_preserves_errors_and_capture_failures(self) -> None:
        client = sample_client()

        class StubQueueError(RuntimeError):
            pass

        original_error = StubQueueError("broker refused raw job payload")

        with self.assertRaises(StubQueueError) as raised:
            queue_operation_with_logbrew_span(
                operation_name="process checkout.email",
                client=client,
                event_id="evt_python_queue_failure",
                timestamp="2026-06-19T13:00:01Z",
                operation=lambda: (_ for _ in ()).throw(original_error),
                system="rq",
                operation_kind="process",
                queue_name="email",
                task_name="checkout.email",
                span_id_factory=lambda: "b7ad6b7169203362",
                clock=lambda: 320.0,
            )

        self.assertIs(raised.exception, original_error)
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["source"], "queue")
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "StubQueueError")
        self.assertEqual(
            event["attributes"]["events"],
            [
                {
                    "name": "exception",
                    "metadata": {
                        "exceptionEscaped": True,
                        "exceptionType": "StubQueueError",
                    },
                }
            ],
        )
        self.assertNotIn("raw job payload", client.preview_json())
        self.assertNotIn("broker refused", client.preview_json())

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        result = queue_operation_with_logbrew_span(
            operation_name="publish health",
            client=closed_client,
            event_id="evt_python_queue_capture_error",
            timestamp="2026-06-19T13:00:02Z",
            operation=lambda: "ok",
            system="memory",
            operation_kind="publish",
            span_id_factory=lambda: "b7ad6b7169203363",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(result, "ok")
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_async_queue_operation_with_logbrew_span_queues_privacy_bounded_span(self) -> None:
        async def run() -> None:
            client = sample_client()
            active_trace: LogBrewTraceContext | None = None
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            clock_values = iter([330.0, 330.023])

            async def operation() -> dict[str, str]:
                nonlocal active_trace
                active_trace = get_active_logbrew_trace()
                return {"status": "processed"}

            with use_logbrew_trace(parent_trace):
                result = await async_queue_operation_with_logbrew_span(
                    operation_name="process checkout.email",
                    client=client,
                    event_id="evt_python_queue_async_process",
                    timestamp="2026-06-19T13:00:03Z",
                    operation=operation,
                    system="dramatiq",
                    operation_kind="process",
                    queue_name="email",
                    task_name="checkout.email",
                    attempt=1,
                    span_id_factory=lambda: "b7ad6b7169203364",
                    clock=lambda: next(clock_values),
                    metadata={"service": "worker", "kwargs": "raw task kwargs"},
                )

            self.assertEqual(result, {"status": "processed"})
            self.assertEqual(
                active_trace,
                LogBrewTraceContext(
                    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                    span_id="b7ad6b7169203364",
                    parent_span_id="00f067aa0ba902b7",
                    sampled=True,
                ),
            )
            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["attributes"]["name"], "dramatiq process checkout.email")
            self.assertEqual(event["attributes"]["durationMs"], 23.0)
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["source"], "queue")
            self.assertEqual(metadata["queueSystem"], "dramatiq")
            self.assertEqual(metadata["queueOperationKind"], "process")
            self.assertEqual(metadata["taskName"], "checkout.email")
            self.assertEqual(metadata["attempt"], 1)
            serialized = client.preview_json()
            self.assertNotIn("kwargs", serialized)
            self.assertNotIn("raw task kwargs", serialized)

        asyncio.run(run())

    def test_queue_operation_rejects_invalid_counts(self) -> None:
        client = sample_client()

        with self.assertRaises(ValueError):
            queue_operation_with_logbrew_span(
                operation_name="publish checkout.email",
                client=client,
                event_id="evt_python_queue_invalid_count",
                operation=lambda: "ok",
                system="celery",
                message_count=-1,
            )

        with self.assertRaises(ValueError):
            queue_operation_with_logbrew_span(
                operation_name="publish checkout.email",
                client=client,
                event_id="evt_python_queue_invalid_attempt",
                operation=lambda: "ok",
                system="celery",
                attempt=-1,
            )
