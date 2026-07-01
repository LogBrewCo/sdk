"""Request-local trace context helpers for correlating app-owned telemetry."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from importlib import import_module
from typing import Any, TypeAlias

MetadataValue: TypeAlias = str | int | float | bool | None
Metadata: TypeAlias = dict[str, MetadataValue]
SpanIdValidator: TypeAlias = Callable[[str, str], None]
OPEN_TELEMETRY_TRACE_ID_MAX = 2**128 - 1
OPEN_TELEMETRY_SPAN_ID_MAX = 2**64 - 1


@dataclass(frozen=True, slots=True)
class LogBrewTraceContext:
    """Request-local LogBrew trace context safe to attach to logs, errors, and callbacks."""

    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    sampled: bool = False

    def metadata(self) -> Metadata:
        """Return primitive-only metadata for correlating app-owned telemetry."""

        return {
            "traceId": self.trace_id,
            "spanId": self.span_id,
            **({"parentSpanId": self.parent_span_id} if self.parent_span_id is not None else {}),
            "sampled": self.sampled,
        }


_active_trace_context: ContextVar[LogBrewTraceContext | None] = ContextVar(
    "logbrew_active_trace_context",
    default=None,
)


def get_active_logbrew_trace() -> LogBrewTraceContext | None:
    """Return the active request trace context for app-owned logs/errors, when one exists."""

    return _active_trace_context.get()


@contextmanager
def use_logbrew_trace(trace: LogBrewTraceContext | None) -> Iterator[LogBrewTraceContext | None]:
    """Temporarily make a trace context active for synchronous and async framework work."""

    reset_handle = _active_trace_context.set(trace)
    try:
        yield trace
    finally:
        _active_trace_context.reset(reset_handle)


def trace_metadata(trace: LogBrewTraceContext | None = None) -> Metadata:
    """Return primitive trace metadata for the active context or the provided context."""

    active_trace = trace if trace is not None else get_active_logbrew_trace()
    return active_trace.metadata() if active_trace is not None else {}


def _create_logbrew_context_from_open_telemetry_span_context(
    span_context: Any,
    *,
    span_id: str | None,
    span_id_factory: Callable[[], str],
    span_id_validator: SpanIdValidator,
) -> LogBrewTraceContext | None:
    """Create a LogBrew child context from a live OpenTelemetry SpanContext."""

    if span_context is None or getattr(span_context, "is_valid", True) is False:
        return None

    trace_id = _format_open_telemetry_id(
        getattr(span_context, "trace_id", None),
        width=32,
        maximum=OPEN_TELEMETRY_TRACE_ID_MAX,
    )
    parent_span_id = _format_open_telemetry_id(
        getattr(span_context, "span_id", None),
        width=16,
        maximum=OPEN_TELEMETRY_SPAN_ID_MAX,
    )
    if trace_id is None or parent_span_id is None:
        return None

    child_span_id = span_id if span_id is not None else span_id_factory()
    span_id_validator("span_id", child_span_id)

    return LogBrewTraceContext(
        trace_id=trace_id,
        span_id=child_span_id.lower(),
        parent_span_id=parent_span_id,
        sampled=_open_telemetry_trace_flags_sampled(getattr(span_context, "trace_flags", 0)),
    )


def _create_logbrew_context_from_open_telemetry_span(
    span: Any,
    *,
    span_id: str | None,
    span_id_factory: Callable[[], str],
    span_id_validator: SpanIdValidator,
) -> LogBrewTraceContext | None:
    """Create a LogBrew child context from an OpenTelemetry Span-like object."""

    get_span_context = getattr(span, "get_span_context", None)
    if not callable(get_span_context):
        return None
    try:
        span_context = get_span_context()
    except Exception:
        return None
    return _create_logbrew_context_from_open_telemetry_span_context(
        span_context,
        span_id=span_id,
        span_id_factory=span_id_factory,
        span_id_validator=span_id_validator,
    )


def _create_logbrew_context_from_current_open_telemetry_span(
    *,
    span_id: str | None,
    span_id_factory: Callable[[], str],
    span_id_validator: SpanIdValidator,
) -> LogBrewTraceContext | None:
    """Create a LogBrew child context from OpenTelemetry's current span, if present."""

    try:
        open_telemetry_trace = import_module("opentelemetry.trace")
        span = open_telemetry_trace.get_current_span()
    except Exception:
        return None
    return _create_logbrew_context_from_open_telemetry_span(
        span,
        span_id=span_id,
        span_id_factory=span_id_factory,
        span_id_validator=span_id_validator,
    )


def _format_open_telemetry_id(value: Any, *, width: int, maximum: int) -> str | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > maximum:
        return None
    return format(value, f"0{width}x")


def _open_telemetry_trace_flags_sampled(trace_flags: Any) -> bool:
    sampled = getattr(trace_flags, "sampled", None)
    if isinstance(sampled, bool):
        return sampled
    try:
        return (int(trace_flags) & 1) == 1
    except (TypeError, ValueError):
        return False
