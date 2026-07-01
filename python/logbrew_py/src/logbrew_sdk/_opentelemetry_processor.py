"""Dependency-optional OpenTelemetry span processor helpers for Python apps."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, TypeAlias, cast

from logbrew_sdk import SdkError, _instrumentation
from logbrew_sdk._span_events import SpanAttributes
from logbrew_sdk._trace_context import (
    OPEN_TELEMETRY_SPAN_ID_MAX,
    OPEN_TELEMETRY_TRACE_ID_MAX,
    _format_open_telemetry_id,
    _open_telemetry_trace_flags_sampled,
)

Metadata: TypeAlias = dict[str, str | int | float | bool | None]
TimestampFactory: TypeAlias = Callable[[], str]
CaptureErrorHandler: TypeAlias = Callable[[Exception], None]
SpanFilter: TypeAlias = Callable[[Any], bool]

DEFAULT_OTEL_SPAN_ATTRIBUTE_KEYS = frozenset(
    {
        "db.operation.name",
        "db.system",
        "faas.trigger",
        "graphql.operation.name",
        "graphql.operation.type",
        "http.method",
        "http.request.method",
        "http.response.status_code",
        "http.route",
        "http.status_code",
        "messaging.operation.name",
        "messaging.system",
        "rpc.method",
        "rpc.service",
        "rpc.system",
    }
)
DEFAULT_OTEL_RESOURCE_ATTRIBUTE_KEYS = frozenset(
    {
        "deployment.environment",
        "deployment.environment.name",
        "service.name",
        "service.version",
        "telemetry.sdk.language",
        "telemetry.sdk.name",
        "telemetry.sdk.version",
    }
)
DEFAULT_OTEL_EVENT_ATTRIBUTE_KEYS = frozenset({"exception.escaped", "exception.type"})
TRACE_SUMMARY_METADATA_KEYS = frozenset(
    {
        *DEFAULT_OTEL_RESOURCE_ATTRIBUTE_KEYS,
        "db.operation.name",
        "db.system",
        "faas.trigger",
        "graphql.operation.name",
        "graphql.operation.type",
        "http.method",
        "http.request.method",
        "http.response.status_code",
        "http.route",
        "http.status_code",
        "messaging.operation.name",
        "messaging.system",
        "rpc.method",
        "rpc.service",
        "rpc.system",
    }
)
OTEL_SPAN_KIND_NAMES = {
    0: "internal",
    1: "server",
    2: "client",
    3: "producer",
    4: "consumer",
}
SENSITIVE_OTEL_ATTRIBUTE_KEYS = frozenset(
    {
        "code.stacktrace",
        "db.statement",
        "exception.message",
        "exception.stacktrace",
        "http.request.body",
        "http.response.body",
        "http.url",
        "url.full",
    }
)
SENSITIVE_OTEL_ATTRIBUTE_PREFIXES = ("http.request.header.", "http.response.header.")
SENSITIVE_OTEL_ATTRIBUTE_PATTERN = re.compile(
    r"(^|[._-])(authorization|body|cookie|credential|fragment|header|headers|payload|password|passwd|"
    r"private[-_]?key|query|secret|stack|stacktrace|token)([._-]|$)",
    re.IGNORECASE,
)


@dataclass(slots=True)
class _ReadableSpanOptions:
    attribute_keys: frozenset[str]
    capture_unsampled: bool
    event_attribute_keys: frozenset[str]
    include_span_events: bool
    metadata: Metadata
    resource_attribute_keys: frozenset[str]


@dataclass(slots=True)
class _TraceSummary:
    trace_id: str
    span_count: int = 0
    error_span_count: int = 0
    metadata: Metadata = field(default_factory=dict)
    root_seen: bool = False
    root_span_id: str | None = None
    root_name: str | None = None
    root_kind: str | None = None
    root_start_ms: float | None = None
    root_duration_ms: float | None = None
    first_start_ms: float | None = None
    last_end_ms: float | None = None


@dataclass(frozen=True, slots=True)
class _NormalizedSpanContext:
    trace_id: str
    span_id: str
    sampled: bool


class LogBrewOpenTelemetrySpanProcessor:
    """OpenTelemetry SpanProcessor-compatible bridge into a caller-owned LogBrew client."""

    def __init__(
        self,
        *,
        client: Any,
        transport: Any | None = None,
        event_id_prefix: str = "otel",
        timestamp_factory: TimestampFactory | None = None,
        metadata: Mapping[str, Any] | None = None,
        attribute_keys: Iterable[str] | None = None,
        resource_attribute_keys: Iterable[str] | None = None,
        event_attribute_keys: Iterable[str] | None = None,
        capture_unsampled: bool = False,
        include_span_events: bool = True,
        include_trace_summary: bool = False,
        flush_on_force_flush: bool = True,
        span_filter: SpanFilter | None = None,
        on_capture_error: CaptureErrorHandler | None = None,
    ) -> None:
        _require_client(client)
        _require_non_empty_string("OpenTelemetry event_id_prefix", event_id_prefix)
        self._client = client
        self._transport = transport
        self._event_id_prefix = event_id_prefix
        self._timestamp_factory = timestamp_factory
        self._flush_on_force_flush = flush_on_force_flush
        self._span_filter = span_filter
        self._on_capture_error = on_capture_error
        self._captured_spans = 0
        self._captured_summaries = 0
        self._closed = False
        self._trace_summaries: dict[str, _TraceSummary] | None = {} if include_trace_summary else None
        self._options = _readable_span_options(
            attribute_keys=attribute_keys,
            capture_unsampled=capture_unsampled,
            event_attribute_keys=event_attribute_keys,
            include_span_events=include_span_events,
            metadata=metadata,
            resource_attribute_keys=resource_attribute_keys,
        )

    def on_start(self, span: Any, parent_context: Any | None = None) -> None:
        """Keep the OpenTelemetry SpanProcessor start hook intentionally side-effect free."""

    def _on_ending(self, span: Any) -> None:
        """Support OpenTelemetry Python SDKs that call the pre-end processor hook."""

    def on_end(self, span: Any) -> None:
        """Convert one ended OpenTelemetry ReadableSpan-like object into a queued LogBrew span."""

        if self._closed:
            return
        try:
            if self._span_filter is not None and not self._span_filter(span):
                return
            attributes = _span_attributes_from_resolved_open_telemetry_readable_span(span, self._options)
            if attributes is None:
                return
            self._record_trace_summary(attributes, span)
            self._captured_spans += 1
            self._client.span(
                f"{self._event_id_prefix}_{self._captured_spans}",
                _timestamp_from_open_telemetry_readable_span(span, self._timestamp_factory),
                attributes,
            )
        except Exception as error:
            _notify_capture_error(self._on_capture_error, error)

    def force_flush(self, timeout_millis: int | None = 30000) -> bool:
        """Emit pending trace summaries, then optionally flush the caller-owned LogBrew client."""

        return self._flush()

    def shutdown(self) -> bool:
        """Close the processor and flush any pending summaries/client events."""

        self._closed = True
        return self._flush()

    def _flush(self) -> bool:
        self._enqueue_trace_summaries()
        if self._transport is None or not self._flush_on_force_flush:
            return True
        try:
            self._client.flush(self._transport)
        except Exception as error:
            _notify_capture_error(self._on_capture_error, error)
            return False
        return True

    def _record_trace_summary(self, attributes: SpanAttributes, span: Any) -> None:
        if self._trace_summaries is None:
            return
        trace_id = attributes["traceId"]
        summary = self._trace_summaries.get(trace_id)
        if summary is None:
            summary = _TraceSummary(trace_id=trace_id)
            self._trace_summaries[trace_id] = summary

        summary.span_count += 1
        if attributes["status"] == "error":
            summary.error_span_count += 1

        start_ms = _open_telemetry_time_ms(getattr(span, "start_time", None))
        duration_ms = attributes.get("durationMs")
        end_ms = _end_ms_from_open_telemetry_readable_span(span, start_ms, duration_ms)
        if start_ms is not None and (summary.first_start_ms is None or start_ms < summary.first_start_ms):
            summary.first_start_ms = start_ms
        if end_ms is not None and (summary.last_end_ms is None or end_ms > summary.last_end_ms):
            summary.last_end_ms = end_ms

        metadata = attributes.get("metadata")
        _copy_trace_summary_metadata(summary, metadata)
        is_root_span = attributes.get("parentSpanId") is None
        if is_root_span or summary.root_span_id is None:
            summary.root_span_id = attributes["spanId"]
            summary.root_name = attributes["name"]
            summary.root_kind = _string_or_none(metadata.get("otel.kind")) if metadata is not None else None
            summary.root_seen = is_root_span
            summary.root_start_ms = start_ms
            summary.root_duration_ms = duration_ms
            _copy_trace_summary_metadata(summary, metadata, overwrite=True)

    def _enqueue_trace_summaries(self) -> None:
        if not self._trace_summaries:
            return
        summaries = list(self._trace_summaries.values())
        self._trace_summaries.clear()
        for summary in summaries:
            try:
                self._captured_summaries += 1
                self._client.span(
                    f"{self._event_id_prefix}_trace_{self._captured_summaries}",
                    _timestamp_from_open_telemetry_trace_summary(summary, self._timestamp_factory),
                    _open_telemetry_trace_summary_attributes(summary),
                )
            except Exception as error:
                _notify_capture_error(self._on_capture_error, error)


def create_logbrew_open_telemetry_span_processor(
    *,
    client: Any,
    transport: Any | None = None,
    event_id_prefix: str = "otel",
    timestamp_factory: TimestampFactory | None = None,
    metadata: Mapping[str, Any] | None = None,
    attribute_keys: Iterable[str] | None = None,
    resource_attribute_keys: Iterable[str] | None = None,
    event_attribute_keys: Iterable[str] | None = None,
    capture_unsampled: bool = False,
    include_span_events: bool = True,
    include_trace_summary: bool = False,
    flush_on_force_flush: bool = True,
    span_filter: SpanFilter | None = None,
    on_capture_error: CaptureErrorHandler | None = None,
) -> LogBrewOpenTelemetrySpanProcessor:
    """Create an OpenTelemetry SpanProcessor-compatible LogBrew bridge."""

    return LogBrewOpenTelemetrySpanProcessor(
        client=client,
        transport=transport,
        event_id_prefix=event_id_prefix,
        timestamp_factory=timestamp_factory,
        metadata=metadata,
        attribute_keys=attribute_keys,
        resource_attribute_keys=resource_attribute_keys,
        event_attribute_keys=event_attribute_keys,
        capture_unsampled=capture_unsampled,
        include_span_events=include_span_events,
        include_trace_summary=include_trace_summary,
        flush_on_force_flush=flush_on_force_flush,
        span_filter=span_filter,
        on_capture_error=on_capture_error,
    )


def span_attributes_from_open_telemetry_readable_span(
    span: Any,
    *,
    metadata: Mapping[str, Any] | None = None,
    attribute_keys: Iterable[str] | None = None,
    resource_attribute_keys: Iterable[str] | None = None,
    event_attribute_keys: Iterable[str] | None = None,
    capture_unsampled: bool = False,
    include_span_events: bool = True,
) -> SpanAttributes | None:
    """Convert an OpenTelemetry ReadableSpan-like object into privacy-bounded span attributes."""

    return _span_attributes_from_resolved_open_telemetry_readable_span(
        span,
        _readable_span_options(
            attribute_keys=attribute_keys,
            capture_unsampled=capture_unsampled,
            event_attribute_keys=event_attribute_keys,
            include_span_events=include_span_events,
            metadata=metadata,
            resource_attribute_keys=resource_attribute_keys,
        ),
    )


def _span_attributes_from_resolved_open_telemetry_readable_span(
    span: Any,
    options: _ReadableSpanOptions,
) -> SpanAttributes | None:
    if span is None or isinstance(span, list | tuple):
        return None
    context = _normalize_open_telemetry_readable_span_context(span)
    if context is None:
        return None
    if not options.capture_unsampled and not context.sampled:
        return None

    metadata = _open_telemetry_readable_span_metadata(span, options)
    span_events = (
        _open_telemetry_readable_span_events(getattr(span, "events", ()), options.event_attribute_keys)
        if options.include_span_events
        else []
    )
    duration_ms = _duration_ms_from_open_telemetry_readable_span(span)
    parent_context = _normalize_open_telemetry_span_context(getattr(span, "parent", None))
    parent_span_id = (
        parent_context.span_id
        if parent_context is not None and parent_context.trace_id == context.trace_id
        else None
    )

    return cast(
        SpanAttributes,
        {
            "name": _open_telemetry_span_name(span),
            "traceId": context.trace_id,
            "spanId": context.span_id,
            **({"parentSpanId": parent_span_id} if parent_span_id is not None else {}),
            "status": _open_telemetry_span_status(getattr(span, "status", None)),
            **({"durationMs": duration_ms} if duration_ms is not None else {}),
            **({"events": span_events} if span_events else {}),
            **({"metadata": metadata} if metadata else {}),
        },
    )


def _readable_span_options(
    *,
    attribute_keys: Iterable[str] | None,
    capture_unsampled: bool,
    event_attribute_keys: Iterable[str] | None,
    include_span_events: bool,
    metadata: Mapping[str, Any] | None,
    resource_attribute_keys: Iterable[str] | None,
) -> _ReadableSpanOptions:
    return _ReadableSpanOptions(
        attribute_keys=_open_telemetry_attribute_key_set(
            DEFAULT_OTEL_SPAN_ATTRIBUTE_KEYS,
            attribute_keys,
            "OpenTelemetry attribute_keys",
        ),
        capture_unsampled=capture_unsampled,
        event_attribute_keys=_open_telemetry_attribute_key_set(
            DEFAULT_OTEL_EVENT_ATTRIBUTE_KEYS,
            event_attribute_keys,
            "OpenTelemetry event_attribute_keys",
        ),
        include_span_events=include_span_events,
        metadata=_instrumentation.compact_metadata(metadata),
        resource_attribute_keys=_open_telemetry_attribute_key_set(
            DEFAULT_OTEL_RESOURCE_ATTRIBUTE_KEYS,
            resource_attribute_keys,
            "OpenTelemetry resource_attribute_keys",
        ),
    )


def _open_telemetry_attribute_key_set(
    default_keys: frozenset[str],
    extra_keys: Iterable[str] | None,
    label: str,
) -> frozenset[str]:
    if extra_keys is None:
        return default_keys
    allowed_keys = set(default_keys)
    for key in extra_keys:
        _require_non_empty_string(label, key)
        if _is_sensitive_open_telemetry_attribute_key(key):
            raise _sdk_error("validation_error", f"{label} cannot include sensitive key: {key}")
        allowed_keys.add(key)
    return frozenset(allowed_keys)


def _normalize_open_telemetry_readable_span_context(span: Any) -> _NormalizedSpanContext | None:
    get_span_context = getattr(span, "get_span_context", None)
    if callable(get_span_context):
        try:
            return _normalize_open_telemetry_span_context(get_span_context())
        except Exception:
            return None
    return _normalize_open_telemetry_span_context(getattr(span, "context", None))


def _normalize_open_telemetry_span_context(span_context: Any) -> _NormalizedSpanContext | None:
    if span_context is None or getattr(span_context, "is_valid", True) is False:
        return None
    trace_id = _format_open_telemetry_id(
        getattr(span_context, "trace_id", None),
        width=32,
        maximum=OPEN_TELEMETRY_TRACE_ID_MAX,
    )
    span_id = _format_open_telemetry_id(
        getattr(span_context, "span_id", None),
        width=16,
        maximum=OPEN_TELEMETRY_SPAN_ID_MAX,
    )
    if trace_id is None or span_id is None:
        return None
    return _NormalizedSpanContext(
        trace_id=trace_id,
        span_id=span_id,
        sampled=_open_telemetry_trace_flags_sampled(getattr(span_context, "trace_flags", 0)),
    )


def _open_telemetry_readable_span_metadata(span: Any, options: _ReadableSpanOptions) -> Metadata:
    metadata: Metadata = {
        "source": "opentelemetry.readable_span",
        **options.metadata,
    }
    resource = getattr(span, "resource", None)
    metadata.update(
        _open_telemetry_selected_metadata(
            getattr(resource, "attributes", None),
            options.resource_attribute_keys,
        )
    )
    kind = _open_telemetry_span_kind_name(getattr(span, "kind", None))
    if kind is not None:
        metadata["otel.kind"] = kind

    instrumentation_scope = getattr(span, "instrumentation_scope", None)
    scope_name = _string_or_none(getattr(instrumentation_scope, "name", None))
    if scope_name is not None:
        metadata["otel.scope.name"] = scope_name
    scope_version = _string_or_none(getattr(instrumentation_scope, "version", None))
    if scope_version is not None:
        metadata["otel.scope.version"] = scope_version

    _add_positive_count(
        metadata,
        "otel.dropped_attributes_count",
        _first_attr(span, "dropped_attributes", "dropped_attributes_count"),
    )
    _add_positive_count(
        metadata,
        "otel.dropped_events_count",
        _first_attr(span, "dropped_events", "dropped_events_count"),
    )
    _add_positive_count(metadata, "otel.dropped_links_count", _first_attr(span, "dropped_links", "dropped_links_count"))
    metadata.update(_open_telemetry_selected_metadata(getattr(span, "attributes", None), options.attribute_keys))
    return metadata


def _open_telemetry_selected_metadata(attributes: Any, allowed_keys: frozenset[str]) -> Metadata:
    if not isinstance(attributes, Mapping):
        return {}
    return {
        key: value
        for key, value in attributes.items()
        if (
            isinstance(key, str)
            and key in allowed_keys
            and not _is_sensitive_open_telemetry_attribute_key(key)
            and (isinstance(value, str | int | float | bool) or value is None)
        )
    }


def _open_telemetry_readable_span_events(events: Any, event_attribute_keys: frozenset[str]) -> list[dict[str, Any]]:
    if not isinstance(events, Iterable) or isinstance(events, str | bytes | Mapping):
        return []
    summaries: list[dict[str, Any]] = []
    for event in list(events)[: _instrumentation.SPAN_EVENT_LIMIT]:
        name = _string_or_none(getattr(event, "name", None)) or "opentelemetry.event"
        timestamp = _timestamp_from_open_telemetry_time(
            _first_attr(event, "timestamp", "time"),
            fallback_factory=None,
        )
        metadata = _open_telemetry_selected_metadata(getattr(event, "attributes", None), event_attribute_keys)
        summaries.append(
            {
                "name": name,
                **({"timestamp": timestamp} if timestamp is not None else {}),
                **({"metadata": metadata} if metadata else {}),
            }
        )
    return summaries


def _copy_trace_summary_metadata(
    summary: _TraceSummary,
    metadata: Metadata | None,
    *,
    overwrite: bool = False,
) -> None:
    if metadata is None:
        return
    for key, value in metadata.items():
        if key in TRACE_SUMMARY_METADATA_KEYS and (overwrite or key not in summary.metadata):
            summary.metadata[key] = value


def _open_telemetry_trace_summary_attributes(summary: _TraceSummary) -> SpanAttributes:
    duration_ms = _duration_ms_from_open_telemetry_trace_summary(summary)
    metadata = _instrumentation.compact_metadata(
        {
            "source": "opentelemetry.trace_summary",
            **summary.metadata,
            "otel.trace.span_count": summary.span_count,
            **({"otel.trace.error_span_count": summary.error_span_count} if summary.error_span_count > 0 else {}),
            **({"otel.trace.root_span_id": summary.root_span_id} if summary.root_span_id is not None else {}),
            **({"otel.trace.root_name": summary.root_name} if summary.root_name is not None else {}),
            **({"otel.trace.root_kind": summary.root_kind} if summary.root_kind is not None else {}),
            "otel.trace.summary_kind": "rooted" if summary.root_seen else "flush_batch",
        }
    )
    return cast(
        SpanAttributes,
        {
            "name": f"opentelemetry.trace:{summary.root_name}" if summary.root_name else "opentelemetry.trace",
            "traceId": summary.trace_id,
            "spanId": _instrumentation.default_span_id(),
            "status": "error" if summary.error_span_count > 0 else "ok",
            **({"durationMs": duration_ms} if duration_ms is not None else {}),
            "metadata": metadata,
        },
    )


def _duration_ms_from_open_telemetry_trace_summary(summary: _TraceSummary) -> float | None:
    if (
        summary.first_start_ms is not None
        and summary.last_end_ms is not None
        and summary.last_end_ms >= summary.first_start_ms
    ):
        return round(summary.last_end_ms - summary.first_start_ms, 3)
    return summary.root_duration_ms


def _duration_ms_from_open_telemetry_readable_span(span: Any) -> float | None:
    start_ms = _open_telemetry_time_ms(getattr(span, "start_time", None))
    end_ms = _open_telemetry_time_ms(getattr(span, "end_time", None))
    if start_ms is not None and end_ms is not None and end_ms >= start_ms:
        return round(end_ms - start_ms, 3)
    return None


def _end_ms_from_open_telemetry_readable_span(
    span: Any,
    start_ms: float | None,
    duration_ms: float | None,
) -> float | None:
    end_ms = _open_telemetry_time_ms(getattr(span, "end_time", None))
    if end_ms is not None:
        return end_ms
    if start_ms is not None and duration_ms is not None:
        return start_ms + duration_ms
    return None


def _timestamp_from_open_telemetry_readable_span(
    span: Any,
    fallback_factory: TimestampFactory | None,
) -> str:
    return (
        _timestamp_from_open_telemetry_time(getattr(span, "end_time", None), fallback_factory)
        or _instrumentation.now_timestamp()
    )


def _timestamp_from_open_telemetry_trace_summary(
    summary: _TraceSummary,
    fallback_factory: TimestampFactory | None,
) -> str:
    return (
        _timestamp_from_open_telemetry_time(summary.root_start_ms, fallback_factory=None)
        or _timestamp_from_open_telemetry_time(summary.first_start_ms, fallback_factory=None)
        or (fallback_factory() if fallback_factory is not None else _instrumentation.now_timestamp())
    )


def _timestamp_from_open_telemetry_time(
    value: Any,
    fallback_factory: TimestampFactory | None,
) -> str | None:
    milliseconds = _open_telemetry_time_ms(value)
    if milliseconds is not None:
        return (
            datetime.fromtimestamp(milliseconds / 1000, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    return fallback_factory() if fallback_factory is not None else None


def _open_telemetry_time_ms(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value <= 0:
        return None
    return float(value) / 1_000_000 if value > 10_000_000_000_000 else float(value)


def _open_telemetry_span_name(span: Any) -> str:
    return _string_or_none(getattr(span, "name", None)) or "opentelemetry.span"


def _open_telemetry_span_status(status: Any) -> str:
    status_code = _first_attr(status, "status_code", "code")
    status_name = _status_code_name(status_code)
    if status_name == "ERROR" or status_code == 2:
        return "error"
    return "ok"


def _status_code_name(status_code: Any) -> str | None:
    name = getattr(status_code, "name", None)
    if isinstance(name, str):
        return name.upper()
    if isinstance(status_code, str):
        return status_code.upper()
    return None


def _open_telemetry_span_kind_name(kind: Any) -> str | None:
    if isinstance(kind, bool) or kind is None:
        return None
    if isinstance(kind, int):
        return OTEL_SPAN_KIND_NAMES.get(kind)
    name = getattr(kind, "name", None)
    if isinstance(name, str) and name:
        return name.lower()
    value = getattr(kind, "value", None)
    if isinstance(value, int):
        return OTEL_SPAN_KIND_NAMES.get(value)
    if isinstance(kind, str) and kind:
        return kind.rsplit(".", maxsplit=1)[-1].lower()
    return None


def _is_sensitive_open_telemetry_attribute_key(key: str) -> bool:
    normalized = key.lower()
    return (
        normalized in SENSITIVE_OTEL_ATTRIBUTE_KEYS
        or any(normalized.startswith(prefix) for prefix in SENSITIVE_OTEL_ATTRIBUTE_PREFIXES)
        or SENSITIVE_OTEL_ATTRIBUTE_PATTERN.search(normalized) is not None
    )


def _add_positive_count(metadata: Metadata, key: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return
    metadata[key] = value


def _first_attr(value: Any, *names: str) -> Any:
    for name in names:
        attr = getattr(value, name, None)
        if attr is not None:
            return attr
    return None


def _string_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split())
    return normalized or None


def _require_client(client: Any) -> None:
    if not callable(getattr(client, "span", None)):
        raise _sdk_error("validation_error", "OpenTelemetry span processor client must expose span(...)")


def _require_non_empty_string(label: str, value: Any) -> None:
    if not isinstance(value, str) or not value.strip():
        raise _sdk_error("validation_error", f"{label} must be non-empty")


def _notify_capture_error(handler: CaptureErrorHandler | None, error: Exception) -> None:
    if handler is not None:
        try:
            handler(error)
        except Exception:
            return


def _sdk_error(code: str, message: str) -> Exception:
    return SdkError(code, message)
