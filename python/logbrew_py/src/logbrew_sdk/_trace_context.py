"""Request-local trace context helpers for correlating app-owned telemetry."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TypeAlias

MetadataValue: TypeAlias = str | int | float | bool | None
Metadata: TypeAlias = dict[str, MetadataValue]


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
