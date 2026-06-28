from __future__ import annotations

import json
import unittest
from typing import ClassVar

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    rq_operation_with_logbrew_span,
    use_logbrew_trace,
)


class StubRqJob:
    func_name = "checkout.send_email"
    origin = "emails"
    args = ("raw-order-id",)
    kwargs: ClassVar[dict[str, str]] = {"payload": "raw job body"}


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class RqOperationSpanTests(unittest.TestCase):
    def test_rq_operation_with_logbrew_span_derives_safe_job_metadata(self) -> None:
        client = sample_client()
        job = StubRqJob()
        active_trace: LogBrewTraceContext | None = None
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([400.0, 400.014])

        def enqueue_job() -> str:
            nonlocal active_trace
            active_trace = get_active_logbrew_trace()
            return "queued"

        with use_logbrew_trace(parent_trace):
            result = rq_operation_with_logbrew_span(
                client=client,
                event_id="evt_python_rq_publish",
                timestamp="2026-06-19T14:00:00Z",
                job=job,
                operation=enqueue_job,
                operation_kind="publish",
                metadata={
                    "service": "checkout-worker",
                    "jobArgs": "raw args",
                    "headers": "raw headers",
                },
                span_events=[
                    {
                        "name": "rq.job.started",
                        "metadata": {
                            "worker": "worker-a",
                            "jobArgs": "raw args",
                        },
                    }
                ],
                span_id_factory=lambda: "b7ad6b7169203365",
                clock=lambda: next(clock_values),
            )

        self.assertEqual(result, "queued")
        self.assertEqual(
            active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203365",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "rq publish checkout.send_email")
        self.assertEqual(event["attributes"]["durationMs"], 14.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "queue")
        self.assertEqual(metadata["queueSystem"], "rq")
        self.assertEqual(metadata["queueOperation"], "publish checkout.send_email")
        self.assertEqual(metadata["queueOperationKind"], "publish")
        self.assertEqual(metadata["queueName"], "emails")
        self.assertEqual(metadata["taskName"], "checkout.send_email")
        self.assertEqual(metadata["messageCount"], 1)
        self.assertEqual(metadata["service"], "checkout-worker")
        self.assertTrue(metadata["sampled"])
        self.assertEqual(
            event["attributes"]["events"],
            [{"name": "rq.job.started", "metadata": {"worker": "worker-a"}}],
        )
        serialized = client.preview_json()
        self.assertNotIn("raw-order-id", serialized)
        self.assertNotIn("raw job body", serialized)
        self.assertNotIn("raw args", serialized)
        self.assertNotIn("raw headers", serialized)
        self.assertNotIn("jobArgs", serialized)
        self.assertNotIn("headers", serialized)

    def test_rq_operation_with_logbrew_span_accepts_explicit_queue_and_task_names(self) -> None:
        client = sample_client()

        class MinimalJob:
            pass

        result = rq_operation_with_logbrew_span(
            client=client,
            event_id="evt_python_rq_process",
            timestamp="2026-06-19T14:00:01Z",
            job=MinimalJob(),
            operation=lambda: "processed",
            operation_kind="process",
            queue_name="critical",
            task_name="checkout.rebuild_index",
            span_id_factory=lambda: "b7ad6b7169203366",
            clock=lambda: 410.0,
        )

        self.assertEqual(result, "processed")
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "rq process checkout.rebuild_index")
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["queueName"], "critical")
        self.assertEqual(metadata["taskName"], "checkout.rebuild_index")


if __name__ == "__main__":
    unittest.main()
