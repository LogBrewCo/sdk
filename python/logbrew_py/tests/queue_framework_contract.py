from __future__ import annotations

import json
import unittest
from collections.abc import Callable
from typing import Any, ClassVar

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    use_logbrew_trace,
)


class QueueFrameworkContract(unittest.TestCase):
    framework: ClassVar[str]
    object_parameter: ClassVar[str]
    queue_name: ClassVar[str]
    operation: ClassVar[Callable[..., Any]]
    entity_factory: ClassVar[Callable[[], Any]]
    private_values: ClassVar[tuple[str, ...]]

    def client(self) -> LogBrewClient:
        return LogBrewClient.create(
            api_key="LOGBREW_API_KEY",
            sdk_name="logbrew-python",
            sdk_version="0.1.0",
            max_retries=2,
        )

    def call(self, entity: Any, **kwargs: Any) -> Any:
        return self.operation(**{self.object_parameter: entity, **kwargs})

    def test_framework_helper_derives_safe_job_metadata(self) -> None:
        client, entity = self.client(), type(self).entity_factory()
        active_trace: LogBrewTraceContext | None = None
        parent = LogBrewTraceContext(
            "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", sampled=True
        )

        def run() -> str:
            nonlocal active_trace
            active_trace = get_active_logbrew_trace()
            return "completed"

        with use_logbrew_trace(parent):
            result = self.call(
                entity,
                client=client,
                event_id=f"evt_python_{self.framework}_publish",
                timestamp="2026-06-19T14:00:00Z",
                operation=run,
                operation_kind="publish",
                metadata={
                    "service": "checkout-worker",
                    "jobArgs": "raw args",
                    "headers": "raw headers",
                },
                span_events=[
                    {
                        "name": f"{self.framework}.job.started",
                        "metadata": {"worker": "worker-a", "jobArgs": "raw args"},
                    }
                ],
                span_id_factory=lambda: "b7ad6b7169203365",
                clock=iter([400.0, 400.014]).__next__,
            )

        self.assertEqual(result, "completed")
        self.assertEqual(
            active_trace,
            LogBrewTraceContext(
                parent.trace_id, "b7ad6b7169203365", parent.span_id, True
            ),
        )
        event = json.loads(client.preview_json())["events"][0]["attributes"]
        expected_operation = "publish checkout.send_email"
        self.assertEqual(
            (event["name"], event["durationMs"]),
            (f"{self.framework} {expected_operation}", 14.0),
        )
        metadata = event["metadata"]
        self.assertEqual(
            {
                key: metadata[key]
                for key in (
                    "source",
                    "queueSystem",
                    "queueOperation",
                    "queueOperationKind",
                    "queueName",
                    "taskName",
                    "messageCount",
                    "service",
                    "sampled",
                )
            },
            {
                "source": "queue",
                "queueSystem": self.framework,
                "queueOperation": expected_operation,
                "queueOperationKind": "publish",
                "queueName": self.queue_name,
                "taskName": "checkout.send_email",
                "messageCount": 1,
                "service": "checkout-worker",
                "sampled": True,
            },
        )
        self.assertEqual(
            event["events"],
            [
                {
                    "name": f"{self.framework}.job.started",
                    "metadata": {"worker": "worker-a"},
                }
            ],
        )
        for private in (
            *self.private_values,
            "raw args",
            "raw headers",
            "jobArgs",
            "headers",
        ):
            self.assertNotIn(private, client.preview_json())

    def test_framework_helper_accepts_explicit_queue_and_task_names(self) -> None:
        client = self.client()
        result = self.call(
            object(),
            client=client,
            event_id=f"evt_python_{self.framework}_process",
            timestamp="2026-06-19T14:00:01Z",
            operation=lambda: "processed",
            operation_kind="process",
            queue_name="critical",
            task_name="checkout.rebuild_index",
            span_id_factory=lambda: "b7ad6b7169203366",
            clock=lambda: 410.0,
        )
        self.assertEqual(result, "processed")
        event = json.loads(client.preview_json())["events"][0]["attributes"]
        self.assertEqual(
            event["name"], f"{self.framework} process checkout.rebuild_index"
        )
        names = event["metadata"]["queueName"], event["metadata"]["taskName"]
        self.assertEqual(names, ("critical", "checkout.rebuild_index"))
