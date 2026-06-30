"""Celery convenience helpers built on explicit LogBrew queue spans."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from typing import Any, TypeVar

from logbrew_sdk import _instrumentation, create_traceparent, parse_traceparent
from logbrew_sdk._queue_client import Operation, queue_operation_with_logbrew_span
from logbrew_sdk._trace_context import LogBrewTraceContext, get_active_logbrew_trace

T = TypeVar("T")


def create_celery_trace_headers(
    trace: LogBrewTraceContext | None = None,
    *,
    span_id_factory: Callable[[], str] | None = None,
) -> dict[str, str]:
    """Create an app-owned Celery header carrier containing only W3C traceparent."""

    carrier_trace = trace if trace is not None else get_active_logbrew_trace()
    if carrier_trace is None:
        carrier_trace = _instrumentation.child_trace(None, span_id_factory)
    return {
        "traceparent": create_traceparent(
            trace_id=carrier_trace.trace_id,
            span_id=carrier_trace.span_id,
            trace_flags="01" if carrier_trace.sampled else "00",
        )
    }


def logbrew_trace_context_from_celery_headers(headers: Mapping[str, Any] | None) -> LogBrewTraceContext | None:
    """Return the upstream trace context from Celery headers, or None when invalid."""

    for traceparent in _celery_traceparent_candidates(headers):
        with suppress(Exception):
            context = parse_traceparent(traceparent)
            return LogBrewTraceContext(
                trace_id=context.trace_id,
                span_id=context.parent_span_id,
                sampled=context.sampled,
            )
    return None


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
    parent_trace = trace if trace is not None else _safe_celery_trace_context(task)
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
        trace=parent_trace,
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


def _safe_celery_trace_context(task: Any) -> LogBrewTraceContext | None:
    with suppress(Exception):
        request = getattr(task, "request", None)
        headers = request.get("headers") if isinstance(request, Mapping) else getattr(request, "headers", None)
        return logbrew_trace_context_from_celery_headers(headers)
    return None


def _celery_traceparent_candidates(headers: Mapping[str, Any] | None) -> list[str]:
    traceparents: list[str] = []
    if not isinstance(headers, Mapping):
        return traceparents
    direct = _case_insensitive_mapping_value(headers, "traceparent")
    if isinstance(direct, str):
        traceparents.append(direct)
    nested_headers = _case_insensitive_mapping_value(headers, "headers")
    if isinstance(nested_headers, Mapping):
        nested = _case_insensitive_mapping_value(nested_headers, "traceparent")
        if isinstance(nested, str):
            traceparents.append(nested)
    return traceparents


def _case_insensitive_mapping_value(headers: Mapping[str, Any], wanted_key: str) -> Any:
    for key, value in headers.items():
        if isinstance(key, str) and key.lower() == wanted_key:
            return value
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
