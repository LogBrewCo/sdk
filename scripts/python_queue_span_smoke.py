from __future__ import annotations

import asyncio
import json

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    async_queue_operation_with_logbrew_span,
    get_active_logbrew_trace,
    queue_operation_with_logbrew_span,
    use_logbrew_trace,
)


class StubQueueError(RuntimeError):
    pass


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-queue",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
captured: dict[str, object] = {}


def queue_publish_operation() -> str:
    active = get_active_logbrew_trace()
    captured["activeSpan"] = active.span_id if active is not None else None
    return "queued"


async def async_queue_process_operation() -> dict[str, str]:
    active = get_active_logbrew_trace()
    captured["asyncActiveSpan"] = active.span_id if active is not None else None
    return {"status": "processed"}


with use_logbrew_trace(parent_trace):
    publish_result = queue_operation_with_logbrew_span(
        "publish checkout.email",
        client=client,
        event_id="evt_python_queue_publish",
        timestamp="2026-06-19T13:00:00Z",
        operation=queue_publish_operation,
        system="celery",
        operation_kind="publish",
        queue_name="email",
        task_name="checkout.email",
        message_count=1,
        attempt=1,
        span_id_factory=lambda: "b7ad6b7169203361",
        clock=iter([300.0, 300.011]).__next__,
        metadata={
            "service": "checkout",
            "messageBody": "raw job payload",
            "headers": "trace headers",
            "jobArgs": "task inputs",
        },
    )

with use_logbrew_trace(parent_trace):
    process_result = asyncio.run(
        async_queue_operation_with_logbrew_span(
            "process checkout.email",
            client=client,
            event_id="evt_python_queue_async_process",
            timestamp="2026-06-19T13:00:01Z",
            operation=async_queue_process_operation,
            system="dramatiq",
            operation_kind="process",
            queue_name="email",
            task_name="checkout.email",
            attempt=2,
            span_id_factory=lambda: "b7ad6b7169203362",
            clock=iter([310.0, 310.023]).__next__,
            metadata={"service": "worker", "kwargs": "raw task kwargs"},
        )
    )

try:
    queue_operation_with_logbrew_span(
        "process checkout.email",
        client=client,
        event_id="evt_python_queue_error",
        timestamp="2026-06-19T13:00:02Z",
        operation=lambda: (_ for _ in ()).throw(StubQueueError("raw job payload refused")),
        system="rq",
        operation_kind="process",
        queue_name="email",
        task_name="checkout.email",
        span_id_factory=lambda: "b7ad6b7169203363",
        clock=iter([320.0, 320.004]).__next__,
    )
except StubQueueError:
    pass

closed_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-queue",
    sdk_version="0.1.0",
)
closed_client.closed = True
capture_errors: list[str] = []
queue_operation_with_logbrew_span(
    "publish health",
    client=closed_client,
    event_id="evt_python_queue_capture_failure",
    timestamp="2026-06-19T13:00:03Z",
    operation=lambda: "ok",
    system="memory",
    operation_kind="publish",
    span_id_factory=lambda: "b7ad6b7169203364",
    on_capture_error=lambda error: capture_errors.append(str(error)),
)

serialized = client.preview_json()
for forbidden in (
    "raw job payload",
    '"messageBody"',
    "trace headers",
    '"headers"',
    "task inputs",
    '"jobArgs"',
    "raw task kwargs",
    '"kwargs"',
    "refused",
):
    if forbidden in serialized:
        raise SystemExit(f"queue span leaked private data: {forbidden}")

payload = json.loads(serialized)
publish_metadata = payload["events"][0]["attributes"]["metadata"]
process_metadata = payload["events"][1]["attributes"]["metadata"]
error_metadata = payload["events"][2]["attributes"]["metadata"]

print(
    json.dumps(
        {
            "activeSpan": captured["activeSpan"],
            "asyncActiveSpan": captured["asyncActiveSpan"],
            "asyncProcessed": process_result["status"],
            "captureErrors": len(capture_errors),
            "errorType": error_metadata["errorType"],
            "events": len(payload["events"]),
            "messageCount": publish_metadata["messageCount"],
            "ok": True,
            "publishResult": publish_result,
            "queueName": publish_metadata["queueName"],
            "queueSystem": publish_metadata["queueSystem"],
            "syncOperationKind": publish_metadata["queueOperationKind"],
            "taskName": process_metadata["taskName"],
        },
        sort_keys=True,
    )
)
