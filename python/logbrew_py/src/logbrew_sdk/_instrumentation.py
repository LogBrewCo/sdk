"""Shared helpers for explicit, app-owned instrumentation integrations."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any, TypeAlias
from uuid import uuid4

from logbrew_sdk._trace_context import LogBrewTraceContext

MetadataValue: TypeAlias = str | int | float | bool | None
Metadata: TypeAlias = dict[str, MetadataValue]
Clock: TypeAlias = Callable[[], float]

HEX16 = re.compile(r"^[0-9a-fA-F]{16}$")
ZERO_SPAN_ID = "0000000000000000"


def child_trace(
    parent_trace: LogBrewTraceContext | None,
    span_id_factory: Callable[[], str] | None,
) -> LogBrewTraceContext:
    span_id = (span_id_factory or default_span_id)().lower()
    require_span_id(span_id)
    if parent_trace is None:
        return LogBrewTraceContext(
            trace_id=default_trace_id(),
            span_id=span_id,
            sampled=False,
        )
    return LogBrewTraceContext(
        trace_id=parent_trace.trace_id,
        span_id=span_id,
        parent_span_id=parent_trace.span_id,
        sampled=parent_trace.sampled,
    )


def compact_metadata(metadata: Mapping[str, Any] | None) -> Metadata:
    if metadata is None:
        return {}
    return {
        key: value
        for key, value in metadata.items()
        if isinstance(key, str) and (isinstance(value, str | int | float | bool) or value is None)
    }


def duration_ms(start: float, clock: Clock) -> float:
    return round(max((clock() - start) * 1000, 0), 3)


def now_timestamp() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def capture_client_span(
    *,
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext,
    name: str,
    status: str,
    duration_ms: float,
    metadata: Metadata,
    on_capture_error: Callable[[Exception], None] | None,
) -> None:
    try:
        client.span(
            event_id,
            timestamp or now_timestamp(),
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


def required_label(name: str, value: str) -> str:
    normalized = optional_label(value)
    if normalized is None:
        raise TypeError(f"{name} must be a non-empty string")
    return normalized


def optional_label(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("label values must be strings")
    normalized = " ".join(value.split())
    return normalized or None


def optional_bool(name: str, value: bool | None) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise TypeError(f"{name} must be a boolean")
    return value


def normalize_non_negative_int(name: str, value: int | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def default_trace_id() -> str:
    trace_id = uuid4().hex
    return "00000000000000000000000000000001" if trace_id == "0" * 32 else trace_id


def default_span_id() -> str:
    span_id = uuid4().hex[:16]
    return "0000000000000001" if span_id == ZERO_SPAN_ID else span_id


def require_span_id(span_id: str) -> None:
    if HEX16.fullmatch(span_id) is None or span_id == ZERO_SPAN_ID:
        raise ValueError("span_id_factory must return a non-zero 16-character hex span id")
