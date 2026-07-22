"""Explicit queue span helpers for app-owned Python queue calls."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from time import perf_counter
from typing import Any, TypeAlias, TypeVar

from logbrew_sdk import _instrumentation
from logbrew_sdk._trace_context import (
    LogBrewTraceContext,
    get_active_logbrew_trace,
    use_logbrew_trace,
)

T = TypeVar("T")
Operation: TypeAlias = Callable[[], T]
AsyncOperation: TypeAlias = Callable[[], Awaitable[T]]

_QUEUE_METADATA_DENYLIST = (
    "arg",
    "body",
    "cookie",
    "header",
    "key",
    "kwarg",
    "message",
    "param",
    "payload",
    "auth",
    "private",
    "value",
)


def queue_operation_with_logbrew_span(
    operation_name: str,
    *,
    client: Any,
    event_id: str,
    operation: Operation[T],
    system: str,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    operation_kind: str | None = None,
    queue_name: str | None = None,
    task_name: str | None = None,
    message_count: int | None = None,
    attempt: int | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run a caller-owned queue operation under a LogBrew child span."""

    _require_operation(operation)
    return _run_queue_operation(
        _queue_span_request(
            operation_name=operation_name,
            system=system,
            client=client,
            event_id=event_id,
            timestamp=timestamp,
            trace=trace,
            operation_kind=operation_kind,
            queue_name=queue_name,
            task_name=task_name,
            message_count=message_count,
            attempt=attempt,
            metadata=metadata,
            span_events=span_events,
            span_id_factory=span_id_factory,
            clock=clock,
            on_capture_error=on_capture_error,
        ),
        operation,
    )


async def async_queue_operation_with_logbrew_span(
    operation_name: str,
    *,
    client: Any,
    event_id: str,
    operation: AsyncOperation[T],
    system: str,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    operation_kind: str | None = None,
    queue_name: str | None = None,
    task_name: str | None = None,
    message_count: int | None = None,
    attempt: int | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run a caller-owned async queue operation under a LogBrew child span."""

    _require_operation(operation)
    request = _queue_span_request(
        operation_name=operation_name,
        system=system,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=trace,
        operation_kind=operation_kind,
        queue_name=queue_name,
        task_name=task_name,
        message_count=message_count,
        attempt=attempt,
        metadata=metadata,
        span_events=span_events,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
    )
    with use_logbrew_trace(request.trace):
        try:
            result = await operation()
        except Exception as error:
            request.capture("error", error=error)
            raise
    request.capture("ok")
    return result


@dataclass(slots=True)
class _QueueSpanRequest:
    operation_name: str
    system: str
    client: Any
    event_id: str
    timestamp: str | None
    trace: LogBrewTraceContext
    operation_kind: str | None
    queue_name: str | None
    task_name: str | None
    message_count: int | None
    attempt: int | None
    metadata: Mapping[str, Any] | None
    span_events: Sequence[_instrumentation.SpanEventSummary] | None
    clock: _instrumentation.Clock
    on_capture_error: Callable[[Exception], None] | None
    start: float

    def capture(
        self,
        status: str,
        *,
        error: Exception | None = None,
        error_type: str | None = None,
    ) -> None:
        normalized_error_type = (
            type(error).__name__ if error is not None else _instrumentation.optional_label(error_type)
        )
        _instrumentation.capture_client_span(
            client=self.client,
            event_id=self.event_id,
            timestamp=self.timestamp,
            trace=self.trace,
            name=f"{self.system} {self.operation_name}",
            status=status,
            duration_ms=_instrumentation.duration_ms(self.start, self.clock),
            metadata=_queue_span_metadata(
                metadata=self.metadata,
                system=self.system,
                operation_name=self.operation_name,
                operation_kind=self.operation_kind,
                queue_name=self.queue_name,
                task_name=self.task_name,
                message_count=self.message_count,
                attempt=self.attempt,
                sampled=self.trace.sampled,
                error_type=normalized_error_type,
            ),
            events=_instrumentation.span_events_with_exception_type(
                self.span_events,
                normalized_error_type,
                _QUEUE_METADATA_DENYLIST,
            ),
            on_capture_error=self.on_capture_error,
        )


def _queue_span_request(
    *,
    operation_name: str,
    system: str,
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext | None,
    operation_kind: str | None,
    queue_name: str | None,
    task_name: str | None,
    message_count: int | None,
    attempt: int | None,
    metadata: Mapping[str, Any] | None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None,
    span_id_factory: Callable[[], str] | None,
    clock: _instrumentation.Clock | None,
    on_capture_error: Callable[[Exception], None] | None,
) -> _QueueSpanRequest:
    read_clock = clock or perf_counter
    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    return _QueueSpanRequest(
        operation_name=_instrumentation.required_label("operation_name", operation_name),
        system=_instrumentation.required_label("system", system),
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=_instrumentation.child_trace(parent_trace, span_id_factory),
        operation_kind=_instrumentation.optional_label(operation_kind),
        queue_name=_instrumentation.optional_label(queue_name),
        task_name=_instrumentation.optional_label(task_name),
        message_count=_instrumentation.normalize_non_negative_int("message_count", message_count),
        attempt=_instrumentation.normalize_non_negative_int("attempt", attempt),
        metadata=metadata,
        span_events=span_events,
        clock=read_clock,
        on_capture_error=on_capture_error,
        start=read_clock(),
    )


def _run_queue_operation(request: _QueueSpanRequest, operation: Operation[T]) -> T:
    with use_logbrew_trace(request.trace):
        try:
            result = operation()
        except Exception as error:
            request.capture("error", error=error)
            raise
    request.capture("ok")
    return result


def _queue_span_metadata(
    *,
    metadata: Mapping[str, Any] | None,
    system: str,
    operation_name: str,
    operation_kind: str | None,
    queue_name: str | None,
    task_name: str | None,
    message_count: int | None,
    attempt: int | None,
    sampled: bool,
    error_type: str | None,
) -> _instrumentation.Metadata:
    span_metadata = _safe_queue_metadata(metadata)
    span_metadata.update(
        {
            "source": "queue",
            "queueSystem": system,
            "queueOperation": operation_name,
            "sampled": sampled,
        }
    )
    if operation_kind is not None:
        span_metadata["queueOperationKind"] = operation_kind
    if queue_name is not None:
        span_metadata["queueName"] = queue_name
    if task_name is not None:
        span_metadata["taskName"] = task_name
    if message_count is not None:
        span_metadata["messageCount"] = message_count
    if attempt is not None:
        span_metadata["attempt"] = attempt
    if error_type is not None:
        span_metadata["errorType"] = error_type
    return span_metadata


def _safe_queue_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    return _instrumentation.compact_metadata_without_keys(metadata, _QUEUE_METADATA_DENYLIST)


def _require_operation(operation: object) -> None:
    if not callable(operation):
        raise TypeError("operation must be callable")
