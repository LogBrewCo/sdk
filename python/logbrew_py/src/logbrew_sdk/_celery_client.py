"""Celery convenience helpers built on explicit LogBrew queue spans."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from typing import Any, TypeVar

from logbrew_sdk import _instrumentation
from logbrew_sdk._queue_client import Operation, queue_operation_with_logbrew_span
from logbrew_sdk._trace_context import LogBrewTraceContext

T = TypeVar("T")


def celery_operation_with_logbrew_span(
    *,
    client: Any,
    event_id: str,
    task: Any,
    operation: Operation[T],
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    operation_kind: str = "process",
    operation_name: str | None = None,
    queue_name: str | None = None,
    task_name: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run an app-owned Celery operation under a privacy-bounded LogBrew span.

    The helper duck-types common Celery task fields but never imports,
    registers signals, or patches Celery.
    """

    normalized_kind = _instrumentation.required_label("operation_kind", operation_kind)
    normalized_task_name = _instrumentation.optional_label(task_name) or _safe_task_label(task, "name")
    normalized_queue_name = _instrumentation.optional_label(queue_name) or _safe_celery_queue_name(task)
    normalized_operation_name = _instrumentation.optional_label(operation_name) or _celery_operation_name(
        operation_kind=normalized_kind,
        task_name=normalized_task_name,
    )

    return queue_operation_with_logbrew_span(
        normalized_operation_name,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        operation=operation,
        system="celery",
        trace=trace,
        operation_kind=normalized_kind,
        queue_name=normalized_queue_name,
        task_name=normalized_task_name,
        message_count=1,
        metadata=metadata,
        span_events=span_events,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
    )


def _celery_operation_name(*, operation_kind: str, task_name: str | None) -> str:
    if task_name is not None:
        return f"{operation_kind} {task_name}"
    return operation_kind


def _safe_task_label(task: Any, field: str) -> str | None:
    with suppress(Exception):
        return _instrumentation.optional_label(getattr(task, field, None))
    return None


def _safe_celery_queue_name(task: Any) -> str | None:
    with suppress(Exception):
        request = getattr(task, "request", None)
        if isinstance(request, Mapping):
            delivery_info = request.get("delivery_info")
        else:
            delivery_info = getattr(request, "delivery_info", None)
        if isinstance(delivery_info, Mapping):
            return _instrumentation.optional_label(delivery_info.get("routing_key"))
        return _instrumentation.optional_label(getattr(delivery_info, "routing_key", None))
    return None
