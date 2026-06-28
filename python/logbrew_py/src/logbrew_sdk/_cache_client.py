"""Explicit cache span helpers for app-owned Python cache calls."""

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

_CACHE_METADATA_DENYLIST = (
    "arg",
    "command",
    "cookie",
    "header",
    "key",
    "param",
    "payload",
    "auth",
    "private",
    "value",
)


def cache_operation_with_logbrew_span(
    operation_name: str,
    *,
    client: Any,
    event_id: str,
    operation: Operation[T],
    system: str,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    cache_name: str | None = None,
    cache_hit: bool | None = None,
    item_size_bytes: int | None = None,
    item_count: int | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run a caller-owned cache operation under a LogBrew child span."""

    _require_operation(operation)
    return _run_cache_operation(
        _cache_span_request(
            operation_name=operation_name,
            system=system,
            client=client,
            event_id=event_id,
            timestamp=timestamp,
            trace=trace,
            cache_name=cache_name,
            cache_hit=cache_hit,
            item_size_bytes=item_size_bytes,
            item_count=item_count,
            metadata=metadata,
            span_events=span_events,
            span_id_factory=span_id_factory,
            clock=clock,
            on_capture_error=on_capture_error,
        ),
        operation,
    )


async def async_cache_operation_with_logbrew_span(
    operation_name: str,
    *,
    client: Any,
    event_id: str,
    operation: AsyncOperation[T],
    system: str,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    cache_name: str | None = None,
    cache_hit: bool | None = None,
    item_size_bytes: int | None = None,
    item_count: int | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run a caller-owned async cache operation under a LogBrew child span."""

    _require_operation(operation)
    request = _cache_span_request(
        operation_name=operation_name,
        system=system,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=trace,
        cache_name=cache_name,
        cache_hit=cache_hit,
        item_size_bytes=item_size_bytes,
        item_count=item_count,
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
class _CacheSpanRequest:
    operation_name: str
    system: str
    client: Any
    event_id: str
    timestamp: str | None
    trace: LogBrewTraceContext
    cache_name: str | None
    cache_hit: bool | None
    item_size_bytes: int | None
    item_count: int | None
    metadata: Mapping[str, Any] | None
    span_events: Sequence[_instrumentation.SpanEventSummary] | None
    clock: _instrumentation.Clock
    on_capture_error: Callable[[Exception], None] | None
    start: float

    def capture(self, status: str, *, error: Exception | None = None) -> None:
        _instrumentation.capture_client_span(
            client=self.client,
            event_id=self.event_id,
            timestamp=self.timestamp,
            trace=self.trace,
            name=f"{self.system} {self.operation_name}",
            status=status,
            duration_ms=_instrumentation.duration_ms(self.start, self.clock),
            metadata=_cache_span_metadata(
                metadata=self.metadata,
                system=self.system,
                operation_name=self.operation_name,
                cache_name=self.cache_name,
                cache_hit=self.cache_hit,
                item_size_bytes=self.item_size_bytes,
                item_count=self.item_count,
                sampled=self.trace.sampled,
                error=error,
            ),
            events=_instrumentation.span_events_with_exception(
                self.span_events,
                error,
                _CACHE_METADATA_DENYLIST,
            ),
            on_capture_error=self.on_capture_error,
        )


def _cache_span_request(
    *,
    operation_name: str,
    system: str,
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext | None,
    cache_name: str | None,
    cache_hit: bool | None,
    item_size_bytes: int | None,
    item_count: int | None,
    metadata: Mapping[str, Any] | None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None,
    span_id_factory: Callable[[], str] | None,
    clock: _instrumentation.Clock | None,
    on_capture_error: Callable[[Exception], None] | None,
) -> _CacheSpanRequest:
    read_clock = clock or perf_counter
    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    return _CacheSpanRequest(
        operation_name=_instrumentation.required_label("operation_name", operation_name),
        system=_instrumentation.required_label("system", system),
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=_instrumentation.child_trace(parent_trace, span_id_factory),
        cache_name=_instrumentation.optional_label(cache_name),
        cache_hit=_instrumentation.optional_bool("cache_hit", cache_hit),
        item_size_bytes=_instrumentation.normalize_non_negative_int("item_size_bytes", item_size_bytes),
        item_count=_instrumentation.normalize_non_negative_int("item_count", item_count),
        metadata=metadata,
        span_events=span_events,
        clock=read_clock,
        on_capture_error=on_capture_error,
        start=read_clock(),
    )


def _run_cache_operation(request: _CacheSpanRequest, operation: Operation[T]) -> T:
    with use_logbrew_trace(request.trace):
        try:
            result = operation()
        except Exception as error:
            request.capture("error", error=error)
            raise
    request.capture("ok")
    return result


def _cache_span_metadata(
    *,
    metadata: Mapping[str, Any] | None,
    system: str,
    operation_name: str,
    cache_name: str | None,
    cache_hit: bool | None,
    item_size_bytes: int | None,
    item_count: int | None,
    sampled: bool,
    error: Exception | None,
) -> _instrumentation.Metadata:
    span_metadata = _safe_cache_metadata(metadata)
    span_metadata.update(
        {
            "source": "cache",
            "cacheSystem": system,
            "cacheOperation": operation_name,
            "sampled": sampled,
        }
    )
    if cache_name is not None:
        span_metadata["cacheName"] = cache_name
    if cache_hit is not None:
        span_metadata["cacheHit"] = cache_hit
    if item_size_bytes is not None:
        span_metadata["itemSizeBytes"] = item_size_bytes
    if item_count is not None:
        span_metadata["itemCount"] = item_count
    if error is not None:
        span_metadata["errorType"] = type(error).__name__
    return span_metadata


def _safe_cache_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    return _instrumentation.compact_metadata_without_keys(metadata, _CACHE_METADATA_DENYLIST)


def _require_operation(operation: object) -> None:
    if not callable(operation):
        raise TypeError("operation must be callable")
