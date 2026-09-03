"""Explicit queue span helpers for app-owned Python queue calls."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from dataclasses import dataclass
from time import perf_counter, time
from typing import Any, TypeAlias, TypeVar
from uuid import uuid4

from logbrew_sdk import (
    LogBrewLoggingHandler,
    SdkError,
    _instrumentation,
    create_issue_attributes_from_exception,
    create_traceparent,
    parse_traceparent,
)
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
_QUEUE_OPERATION_SEMANTICS = (
    dict.fromkeys(("enqueue", "publish", "send"), "queue.publish")
    | {"receive": "queue.receive"}
    | dict.fromkeys(("consume", "perform", "process"), "queue.process")
)
_MAX_LOGGERS = 16
_MAX_LABEL_LENGTH = 256
_MAX_QUEUE_WAIT_MS = 86_400_000


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
    with _capture_queue_span(request):
        return operation()


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
    with _capture_queue_span(request):
        return await operation()


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
        try:
            normalized_error_type = (
                type(error).__name__
                if error is not None
                else _instrumentation.optional_label(error_type)
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
        except Exception as capture_error:
            if self.on_capture_error is not None:
                with suppress(Exception):
                    self.on_capture_error(capture_error)


@dataclass(slots=True)
class _QueueInstrumentationConfig:
    system: str
    display_name: str
    metadata: Mapping[str, Any]
    event_id_factory: Callable[[], str]
    span_id_factory: Callable[[], str] | None
    clock: _instrumentation.Clock
    wall_clock: _instrumentation.Clock
    on_capture_error: Callable[[Exception], None] | None

    @classmethod
    def create(
        cls,
        system: str,
        display_name: str,
        metadata: Mapping[str, Any] | None,
        event_id_factory: Callable[[], str] | None,
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock | None,
        wall_clock: _instrumentation.Clock | None,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> _QueueInstrumentationConfig:
        return cls(
            system,
            display_name,
            {"framework": system, **(metadata or {})},
            event_id_factory or (lambda: f"evt_python_{system}_{uuid4().hex}"),
            span_id_factory,
            clock or perf_counter,
            wall_clock or time,
            on_capture_error,
        )

    def request(
        self,
        operation_kind: str,
        client: Any,
        task_name: str | None,
        queue_name: str | None,
        trace: LogBrewTraceContext | None = None,
        *,
        attempt: int | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> _QueueSpanRequest:
        operation_name = " ".join(filter(None, (operation_kind, task_name)))
        return _queue_span_request(
            operation_name=operation_name,
            system=self.system,
            client=client,
            event_id=self.event_id_factory(),
            timestamp=None,
            trace=trace,
            operation_kind=operation_kind,
            queue_name=queue_name,
            task_name=task_name,
            message_count=1,
            attempt=attempt,
            metadata={**self.metadata, **(metadata or {})},
            span_events=None,
            span_id_factory=self.span_id_factory,
            clock=self.clock,
            on_capture_error=self.on_capture_error,
        )

    def capture_issue(
        self,
        request: _QueueSpanRequest,
        error: BaseException,
        *,
        hook_name: str | None = None,
    ) -> None:
        task_name, queue_name = request.task_name, request.queue_name
        issue_metadata = {
            **_instrumentation.compact_metadata_without_keys(
                request.metadata, _QUEUE_METADATA_DENYLIST
            ),
            "source": "queue",
            "operation": "queue.process",
            "taskName": task_name or "unknown",
            **({"hookState": "failure"} if hook_name else {"taskState": "failure"}),
            **({"queueName": queue_name} if queue_name else {}),
            **({"attempt": request.attempt} if request.attempt is not None else {}),
            **request.trace.metadata(),
        }
        request.client.issue(
            self.event_id_factory(),
            _instrumentation.now_timestamp(),
            create_issue_attributes_from_exception(
                error,
                title=(f"{self.display_name} hook {hook_name} failed" if hook_name
                       else f"{self.display_name} task {task_name or 'unknown'} failed"),
                message=type(error).__name__,
                mechanism=f"{self.system}.{'hook' if hook_name else 'job'}",
                handled=False,
                metadata=issue_metadata,
            ),
        )

    def notify(self, error: Exception) -> None:
        if self.on_capture_error is not None:
            with suppress(Exception):
                self.on_capture_error(error)

    def logger_handlers(
        self,
        owner: int,
        context: ContextVar[tuple[int, Any] | None],
        logger_names: Sequence[str],
    ) -> list[tuple[logging.Logger, LogBrewLoggingHandler]]:
        proxy: Any = _QueueClientProxy(owner, context)
        return [
            (
                logging.getLogger(name),
                LogBrewLoggingHandler(
                    proxy,
                    metadata=_instrumentation.compact_metadata_without_keys(self.metadata, _QUEUE_METADATA_DENYLIST),
                ),
            )
            for name in _normalized_logger_names(logger_names)
        ]


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
        operation_name=_instrumentation.required_label(
            "operation_name", operation_name
        ),
        system=_instrumentation.required_label("system", system),
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=_instrumentation.child_trace(parent_trace, span_id_factory),
        operation_kind=_instrumentation.optional_label(operation_kind),
        queue_name=_instrumentation.optional_label(queue_name),
        task_name=_instrumentation.optional_label(task_name),
        message_count=_instrumentation.normalize_non_negative_int(
            "message_count", message_count
        ),
        attempt=_instrumentation.normalize_non_negative_int("attempt", attempt),
        metadata=metadata,
        span_events=span_events,
        clock=read_clock,
        on_capture_error=on_capture_error,
        start=read_clock(),
    )


@contextmanager
def _capture_queue_span(request: _QueueSpanRequest) -> Iterator[None]:
    with use_logbrew_trace(request.trace):
        try:
            yield
        except Exception as error:
            request.capture("error", error=error)
            raise
    request.capture("ok")


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
    span_metadata = _instrumentation.compact_metadata_without_keys(
        metadata, _QUEUE_METADATA_DENYLIST
    )
    span_metadata.update(
        {
            "source": "queue",
            "queueSystem": system,
            "queueOperation": operation_name,
            "sampled": sampled,
        }
    )
    span_metadata.update(
        (key, value)
        for key, value in (
            (
                "operation",
                operation_kind and _QUEUE_OPERATION_SEMANTICS.get(operation_kind),
            ),
            ("queueOperationKind", operation_kind),
            ("queueName", queue_name),
            ("taskName", task_name),
            ("messageCount", message_count),
            ("attempt", attempt),
            ("errorType", error_type),
        )
        if value is not None
    )
    return span_metadata


def _require_operation(operation: object) -> None:
    if not callable(operation):
        raise TypeError("operation must be callable")


def _queue_trace_carrier(
    trace: LogBrewTraceContext, wall_clock: _instrumentation.Clock
) -> dict[str, str]:
    return {
        "traceparent": create_traceparent(
            trace_id=trace.trace_id,
            span_id=trace.span_id,
            trace_flags="01" if trace.sampled else "00",
        ),
        "enqueued_at_ms": str(round(wall_clock() * 1000)),
    }


def _queue_trace_from_carrier(carrier: Any) -> LogBrewTraceContext | None:
    with suppress(Exception):
        traceparent = (
            carrier.get("traceparent") if isinstance(carrier, Mapping) else None
        )
        if isinstance(traceparent, str):
            parsed = parse_traceparent(traceparent)
            return LogBrewTraceContext(
                parsed.trace_id, parsed.parent_span_id, sampled=parsed.sampled
            )
    return None


def _queue_wait_metadata(
    carrier: Any, wall_clock: _instrumentation.Clock
) -> dict[str, int]:
    with suppress(Exception):
        raw_value = (
            carrier.get("enqueued_at_ms") if isinstance(carrier, Mapping) else None
        )
        if (
            isinstance(raw_value, str)
            and len(raw_value) <= 16
            and raw_value.isdecimal()
        ):
            return {
                "queueWaitMs": min(
                    max(round(wall_clock() * 1000) - int(raw_value), 0),
                    _MAX_QUEUE_WAIT_MS,
                )
            }
    return {}


def _normalized_logger_names(logger_names: Sequence[str]) -> tuple[str, ...]:
    if isinstance(logger_names, str) or len(logger_names) > _MAX_LOGGERS:
        raise SdkError(
            "configuration_error",
            f"logger_names must contain at most {_MAX_LOGGERS} names",
        )
    normalized = tuple(
        dict.fromkeys(
            _instrumentation.required_label("logger name", name)
            for name in logger_names
        )
    )
    if any(len(name) > _MAX_LABEL_LENGTH for name in normalized):
        raise SdkError(
            "configuration_error",
            f"logger names cannot exceed {_MAX_LABEL_LENGTH} characters",
        )
    return normalized


class _QueueClientProxy:
    def __init__(self, owner: int, context: ContextVar[tuple[int, Any] | None]) -> None:
        self.owner = owner
        self.context = context

    def log(self, *args: Any, **kwargs: Any) -> None:
        active = self.context.get()
        if active is not None and active[0] == self.owner:
            active[1].log(*args, **kwargs)
