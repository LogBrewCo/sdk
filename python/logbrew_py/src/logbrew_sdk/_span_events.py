"""Shared validation for privacy-bounded span event summaries."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, TypeAlias, TypedDict

MetadataValue: TypeAlias = str | int | float | bool | None
Metadata: TypeAlias = dict[str, MetadataValue]
SpanEventErrorFactory: TypeAlias = Callable[[str, str], Exception]
TraceIdValidator: TypeAlias = Callable[[Any], None]
SpanIdValidator: TypeAlias = Callable[[str, Any], None]

SPAN_EVENT_LIMIT = 8
SPAN_LINK_LIMIT = 8


class SpanEventSummary(TypedDict, total=False):
    """Public privacy-bounded span event summary."""

    name: str
    timestamp: str
    metadata: Metadata


class SpanLinkSummary(TypedDict, total=False):
    """Public privacy-bounded span link summary."""

    traceId: str
    spanId: str
    sampled: bool
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
    links: list[SpanLinkSummary]


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


def validate_span_links(
    links: Any,
    *,
    error_factory: SpanEventErrorFactory,
    require_trace_id: TraceIdValidator,
    require_span_id: SpanIdValidator,
    compact_metadata: Callable[[Mapping[str, Any] | None], Metadata | None],
) -> list[dict[str, Any]]:
    if links is None:
        return []
    if not isinstance(links, list):
        raise error_factory("validation_error", "span links must be a list")
    if len(links) > SPAN_LINK_LIMIT:
        raise error_factory(
            "validation_error",
            f"span links must contain at most {SPAN_LINK_LIMIT} entries",
        )

    return [
        validate_span_link(
            link,
            error_factory=error_factory,
            require_trace_id=require_trace_id,
            require_span_id=require_span_id,
            compact_metadata=compact_metadata,
        )
        for link in links
    ]


def validate_span_link(
    link: Any,
    *,
    error_factory: SpanEventErrorFactory,
    require_trace_id: TraceIdValidator,
    require_span_id: SpanIdValidator,
    compact_metadata: Callable[[Mapping[str, Any] | None], Metadata | None],
) -> dict[str, Any]:
    if not isinstance(link, dict):
        raise error_factory("validation_error", "span link must be an object")
    require_trace_id(link.get("traceId"))
    require_span_id("span link spanId", link.get("spanId"))
    sampled = link.get("sampled")
    if sampled is not None and not isinstance(sampled, bool):
        raise error_factory("validation_error", "span link sampled must be a boolean")
    metadata = compact_metadata(link.get("metadata"))
    return {
        "traceId": link["traceId"].lower(),
        "spanId": link["spanId"].lower(),
        **({"sampled": sampled} if sampled is not None else {}),
        **({"metadata": metadata} if metadata else {}),
    }
