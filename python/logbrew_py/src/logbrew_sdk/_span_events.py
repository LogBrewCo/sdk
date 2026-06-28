"""Shared validation for privacy-bounded span event summaries."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, TypeAlias, TypedDict

MetadataValue: TypeAlias = str | int | float | bool | None
Metadata: TypeAlias = dict[str, MetadataValue]
SpanEventErrorFactory: TypeAlias = Callable[[str, str], Exception]

SPAN_EVENT_LIMIT = 8


class SpanEventSummary(TypedDict, total=False):
    """Public privacy-bounded span event summary."""

    name: str
    timestamp: str
    metadata: Metadata


class SpanAttributes(TypedDict, total=False):
    """Public span event attributes."""

    name: str
    traceId: str
    spanId: str
    parentSpanId: str
    status: str
    durationMs: float
    metadata: Metadata
    events: list[SpanEventSummary]


def validate_span_events(
    events: Any,
    *,
    error_factory: SpanEventErrorFactory,
    require_non_empty: Callable[[str, Any], None],
    require_timestamp: Callable[[Any], None],
    compact_metadata: Callable[[Mapping[str, Any] | None], Metadata | None],
) -> list[dict[str, Any]]:
    if events is None:
        return []
    if not isinstance(events, list):
        raise error_factory("validation_error", "span events must be a list")

    return [
        validate_span_event(
            event,
            error_factory=error_factory,
            require_non_empty=require_non_empty,
            require_timestamp=require_timestamp,
            compact_metadata=compact_metadata,
        )
        for event in events[:SPAN_EVENT_LIMIT]
    ]


def validate_span_event(
    event: Any,
    *,
    error_factory: SpanEventErrorFactory,
    require_non_empty: Callable[[str, Any], None],
    require_timestamp: Callable[[Any], None],
    compact_metadata: Callable[[Mapping[str, Any] | None], Metadata | None],
) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise error_factory("validation_error", "span event must be an object")
    require_non_empty("span event name", event.get("name"))
    timestamp = event.get("timestamp")
    if timestamp is not None:
        require_timestamp(timestamp)
    metadata = compact_metadata(event.get("metadata"))
    return {
        "name": event["name"],
        **({"timestamp": timestamp} if timestamp is not None else {}),
        **({"metadata": metadata} if metadata else {}),
    }
