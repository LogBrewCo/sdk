"""RQ convenience helpers built on explicit LogBrew queue spans."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import suppress
from typing import Any, TypeVar

from logbrew_sdk import _instrumentation
from logbrew_sdk._queue_client import Operation, queue_operation_with_logbrew_span
from logbrew_sdk._trace_context import LogBrewTraceContext

T = TypeVar("T")


def rq_operation_with_logbrew_span(
    *,
    client: Any,
    event_id: str,
    job: Any,
    operation: Operation[T],
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    operation_kind: str = "process",
    operation_name: str | None = None,
    queue_name: str | None = None,
    task_name: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run an app-owned RQ operation under a privacy-bounded LogBrew span.

    The helper duck-types common RQ job fields but never imports or patches RQ.
    """

    normalized_kind = _instrumentation.required_label("operation_kind", operation_kind)
    normalized_task_name = _instrumentation.optional_label(task_name) or _safe_job_label(job, "func_name")
    normalized_queue_name = _instrumentation.optional_label(queue_name) or _safe_job_label(job, "origin")
    normalized_operation_name = _instrumentation.optional_label(operation_name) or _rq_operation_name(
        operation_kind=normalized_kind,
        task_name=normalized_task_name,
    )

    return queue_operation_with_logbrew_span(
        normalized_operation_name,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        operation=operation,
        system="rq",
        trace=trace,
        operation_kind=normalized_kind,
        queue_name=normalized_queue_name,
        task_name=normalized_task_name,
        message_count=1,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
    )


def _rq_operation_name(*, operation_kind: str, task_name: str | None) -> str:
    if task_name is not None:
        return f"{operation_kind} {task_name}"
    return operation_kind


def _safe_job_label(job: Any, field: str) -> str | None:
    with suppress(Exception):
        return _instrumentation.optional_label(getattr(job, field, None))
    return None
