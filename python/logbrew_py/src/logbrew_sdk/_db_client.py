"""Explicit database span helpers for app-owned Python database calls."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
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
RowCountReader: TypeAlias = Callable[[T], int | None]


def database_operation_with_logbrew_span(
    operation_name: str,
    *,
    client: Any,
    event_id: str,
    operation: Operation[T],
    system: str,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    db_name: str | None = None,
    statement_template: str | None = None,
    row_count: int | None = None,
    row_count_from_result: RowCountReader[T] | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run a caller-owned database operation under a LogBrew child span."""

    _require_operation(operation)
    return _run_database_operation(
        _db_span_request(
            operation_name=operation_name,
            system=system,
            client=client,
            event_id=event_id,
            timestamp=timestamp,
            trace=trace,
            db_name=db_name,
            statement_template=statement_template,
            row_count=row_count,
            row_count_from_result=row_count_from_result,
            metadata=metadata,
            span_id_factory=span_id_factory,
            clock=clock,
            on_capture_error=on_capture_error,
        ),
        operation,
    )


async def async_database_operation_with_logbrew_span(
    operation_name: str,
    *,
    client: Any,
    event_id: str,
    operation: AsyncOperation[T],
    system: str,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    db_name: str | None = None,
    statement_template: str | None = None,
    row_count: int | None = None,
    row_count_from_result: RowCountReader[T] | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run a caller-owned async database operation under a LogBrew child span."""

    _require_operation(operation)
    request = _db_span_request(
        operation_name=operation_name,
        system=system,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=trace,
        db_name=db_name,
        statement_template=statement_template,
        row_count=row_count,
        row_count_from_result=row_count_from_result,
        metadata=metadata,
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
    request.capture("ok", result=result)
    return result


@dataclass(slots=True)
class _DatabaseSpanRequest:
    operation_name: str
    system: str
    client: Any
    event_id: str
    timestamp: str | None
    trace: LogBrewTraceContext
    db_name: str | None
    statement_template: str | None
    row_count: int | None
    row_count_from_result: RowCountReader[Any] | None
    metadata: Mapping[str, Any] | None
    clock: _instrumentation.Clock
    on_capture_error: Callable[[Exception], None] | None
    start: float

    def capture(self, status: str, *, result: Any = None, error: Exception | None = None) -> None:
        row_count = self.row_count
        if error is None and self.row_count_from_result is not None:
            row_count = _safe_row_count(self.row_count_from_result, result, self.on_capture_error)
        _capture_database_span(
            client=self.client,
            event_id=self.event_id,
            timestamp=self.timestamp,
            trace=self.trace,
            name=f"{self.system} {self.operation_name}",
            status=status,
            duration_ms=_instrumentation.duration_ms(self.start, self.clock),
            metadata=_db_span_metadata(
                metadata=self.metadata,
                system=self.system,
                operation_name=self.operation_name,
                db_name=self.db_name,
                statement_template=self.statement_template,
                row_count=row_count,
                sampled=self.trace.sampled,
                error=error,
            ),
            on_capture_error=self.on_capture_error,
        )


def _db_span_request(
    *,
    operation_name: str,
    system: str,
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext | None,
    db_name: str | None,
    statement_template: str | None,
    row_count: int | None,
    row_count_from_result: RowCountReader[Any] | None,
    metadata: Mapping[str, Any] | None,
    span_id_factory: Callable[[], str] | None,
    clock: _instrumentation.Clock | None,
    on_capture_error: Callable[[Exception], None] | None,
) -> _DatabaseSpanRequest:
    if row_count is not None and row_count_from_result is not None:
        raise TypeError("row_count and row_count_from_result cannot both be supplied")
    read_clock = clock or perf_counter
    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    return _DatabaseSpanRequest(
        operation_name=_required_label("operation_name", operation_name),
        system=_required_label("system", system),
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=_instrumentation.child_trace(parent_trace, span_id_factory),
        db_name=_optional_label(db_name),
        statement_template=_optional_label(statement_template),
        row_count=_normalize_row_count(row_count),
        row_count_from_result=row_count_from_result,
        metadata=metadata,
        clock=read_clock,
        on_capture_error=on_capture_error,
        start=read_clock(),
    )


def _run_database_operation(request: _DatabaseSpanRequest, operation: Operation[T]) -> T:
    with use_logbrew_trace(request.trace):
        try:
            result = operation()
        except Exception as error:
            request.capture("error", error=error)
            raise
    request.capture("ok", result=result)
    return result


def _capture_database_span(
    *,
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext,
    name: str,
    status: str,
    duration_ms: float,
    metadata: _instrumentation.Metadata,
    on_capture_error: Callable[[Exception], None] | None,
) -> None:
    try:
        client.span(
            event_id,
            timestamp or _instrumentation.now_timestamp(),
            {
                "name": name,
                "traceId": trace.trace_id,
                "spanId": trace.span_id,
                **({"parentSpanId": trace.parent_span_id} if trace.parent_span_id else {}),
                "status": status,
                "durationMs": duration_ms,
                "metadata": metadata,
            },
        )
    except Exception as capture_error:
        if on_capture_error is not None:
            with suppress(Exception):
                on_capture_error(capture_error)


def _db_span_metadata(
    *,
    metadata: Mapping[str, Any] | None,
    system: str,
    operation_name: str,
    db_name: str | None,
    statement_template: str | None,
    row_count: int | None,
    sampled: bool,
    error: Exception | None,
) -> _instrumentation.Metadata:
    span_metadata = _instrumentation.compact_metadata(metadata)
    span_metadata.update(
        {
            "source": "database",
            "dbSystem": system,
            "dbOperation": operation_name,
            "sampled": sampled,
        }
    )
    if db_name is not None:
        span_metadata["dbName"] = db_name
    if statement_template is not None:
        span_metadata["statementTemplate"] = statement_template
    if row_count is not None:
        span_metadata["rowCount"] = row_count
    if error is not None:
        span_metadata["errorType"] = type(error).__name__
    return span_metadata


def _safe_row_count(
    row_count_from_result: RowCountReader[Any],
    result: Any,
    on_capture_error: Callable[[Exception], None] | None,
) -> int | None:
    try:
        return _normalize_row_count(row_count_from_result(result))
    except Exception as error:
        if on_capture_error is not None:
            with suppress(Exception):
                on_capture_error(error)
        return None


def _normalize_row_count(row_count: int | None) -> int | None:
    if row_count is None:
        return None
    if isinstance(row_count, bool) or not isinstance(row_count, int) or row_count < 0:
        raise ValueError("row_count must be a non-negative integer")
    return row_count


def _required_label(name: str, value: str) -> str:
    normalized = _optional_label(value)
    if normalized is None:
        raise TypeError(f"{name} must be a non-empty string")
    return normalized


def _optional_label(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("label values must be strings")
    normalized = " ".join(value.split())
    return normalized or None


def _require_operation(operation: object) -> None:
    if not callable(operation):
        raise TypeError("operation must be callable")
