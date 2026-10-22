"""Public Python client for building, validating, previewing, and flushing LogBrew event batches."""

from __future__ import annotations

import json
import logging
import math
import os
import re
import ssl
import sys
import time
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import partial
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from threading import Lock, RLock, get_ident, local
from typing import Annotated, Any, Literal, Protocol, TypeAlias, TypedDict, cast

if sys.version_info >= (3, 11):
    from typing import NotRequired
else:  # pragma: no cover - exercised by the Python 3.10 CI lane
    from typing_extensions import NotRequired
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import certifi
import truststore

from logbrew_sdk._automatic_delivery import (
    DEFAULT_DELIVERY_INTERVAL_SECONDS,
    AutomaticDeliveryController,
    DeliveryPrefix,
    DeliverySendError,
    parse_retry_after_ms,
    resolve_automatic_delivery_options,
    send_with_retry_policy,
)
from logbrew_sdk._automatic_delivery import (
    DeliveryHealthSnapshot as DeliveryHealthSnapshot,
)
from logbrew_sdk._breadcrumbs import (
    LogBrewBreadcrumbHandler,
    add_logbrew_breadcrumb,
    current_breadcrumbs,
    ignore_breadcrumb_url,
    install_automatic_breadcrumbs,
)
from logbrew_sdk._errors import SdkError
from logbrew_sdk._event_queue import EventQueue, MemoryEventQueue, QueuedEvent
from logbrew_sdk._issue_diagnostics import (
    issue_exception_chain_from_exception,
    safe_issue_exception_type,
    validate_issue_diagnostics,
)
from logbrew_sdk._logging_identity import log_record_identity as _log_record_identity
from logbrew_sdk._persistent_event_queue import PersistentEventQueue
from logbrew_sdk._runtime_context import (
    add_environment_resource_context,
    add_python_runtime_context,
)
from logbrew_sdk._span_events import (
    SpanAttributes,
    SpanEventSummary,
    SpanLinkSummary,
    validate_span_events,
    validate_span_links,
)
from logbrew_sdk._support_ticket import (
    SupportDiagnosticsValue,
    SupportTicketCategory,
    SupportTicketDraft,
    SupportTicketSource,
    build_create_support_ticket_draft,
)
from logbrew_sdk._telemetry_context import (
    TelemetryApplication,
    TelemetryContext,
    TelemetryDeployment,
    TelemetryDevice,
    TelemetryNamedVersion,
    TelemetryOperatingSystem,
    TelemetryResource,
    TelemetrySessionContext,
    TelemetrySubjectContext,
    TelemetryTraceContext,
    merge_telemetry_contexts,
    validate_telemetry_context,
)
from logbrew_sdk._trace_context import (
    LogBrewTraceContext,
    _create_logbrew_context_from_current_open_telemetry_span,
    _create_logbrew_context_from_open_telemetry_span,
    _create_logbrew_context_from_open_telemetry_span_context,
    get_active_logbrew_trace,
    trace_metadata,
    use_logbrew_trace,
)
from logbrew_sdk._user_context import active_user_subject, set_logbrew_user

# Keep the long-standing public exception identity after moving its implementation out of this module.
SdkError.__module__ = __name__

MetadataValue: TypeAlias = str | int | float | bool | None
Metadata: TypeAlias = dict[str, MetadataValue]


class ReleaseAttributes(TypedDict, total=False):
    """Public release event attributes."""
    version: str
    commit: str
    notes: str
    metadata: Metadata
    context: TelemetryContext


class EnvironmentAttributes(TypedDict, total=False):
    """Public environment event attributes."""
    name: str
    region: str
    metadata: Metadata
    context: TelemetryContext


class IssueStackFrame(TypedDict):
    """Privacy-bounded code identity for one issue traceback frame."""

    filename: str
    line: int
    column: int
    function: NotRequired[str]
    module: NotRequired[str]
    inApp: NotRequired[bool]
    debugId: NotRequired[str]


class IssueExceptionMechanism(TypedDict):
    """Runtime path that captured an exception and whether it escaped."""

    type: str
    handled: bool


class IssueException(TypedDict):
    """Structured exception identity attached to an issue."""

    type: str
    mechanism: NotRequired[IssueExceptionMechanism]


IssueExceptionRelationship: TypeAlias = Literal[
    "reported", "cause", "context", "aggregate_member", "suppressed"
]
IssueExceptionMessageState: TypeAlias = Literal[
    "captured", "truncated", "redacted", "not_captured"
]
IssueExceptionStackFramesState: TypeAlias = Literal["captured", "truncated", "not_captured"]


class IssueExceptionChainEntry(TypedDict):
    """One node in a bounded parent-first runtime exception tree."""

    id: int
    relationship: IssueExceptionRelationship
    type: str
    messageState: IssueExceptionMessageState
    stackFramesState: IssueExceptionStackFramesState
    parentId: NotRequired[int]
    message: NotRequired[str]
    module: NotRequired[str]
    mechanism: NotRequired[IssueExceptionMechanism]
    stackFrames: NotRequired[list[IssueStackFrame]]


class IssueExceptionChain(TypedDict):
    """Bounded exception tree with explicit omission state."""

    entries: list[IssueExceptionChainEntry]
    truncated: bool


IssueBreadcrumbLevel: TypeAlias = Literal["debug", "info", "warning", "error", "critical"]
IssueBreadcrumbLevelInput: TypeAlias = IssueBreadcrumbLevel | Literal["trace", "log", "warn", "fatal"]
IssueBreadcrumbDataValue: TypeAlias = str | int | float | bool | None


class IssueBreadcrumb(TypedDict):
    """One bounded, oldest-to-newest step that happened before an issue."""

    timestamp: str
    category: str
    type: NotRequired[str]
    level: NotRequired[IssueBreadcrumbLevelInput]
    message: NotRequired[str]
    data: NotRequired[dict[str, IssueBreadcrumbDataValue]]


class IssueLikelyFixArea(TypedDict, total=False):
    """App-reported code location that may contain the fix."""

    component: str
    module: str
    function: str
    file: str
    line: int
    column: int
    inApp: bool


class IssueImpactEvidence(TypedDict, total=False):
    """App-reported user-visible impact."""

    affectedUserSegment: str
    failedAction: str
    userVisibleOutcome: str


class IssueDiagnosticEvidence(TypedDict, total=False):
    """Bounded app-reported cause, fix area, impact, and field states."""

    likelyRootCause: str
    likelyFixArea: IssueLikelyFixArea
    impact: IssueImpactEvidence
    capturedFields: list[str]
    missingFields: list[str]
    redactedFields: list[str]
    truncatedFields: list[str]


class IssueAttributes(TypedDict, total=False):
    """Public issue event attributes."""
    title: str
    level: str
    message: str
    exception: IssueException
    exceptionChain: IssueExceptionChain
    stackFrames: list[IssueStackFrame]
    breadcrumbs: list[IssueBreadcrumb]
    breadcrumbsTruncated: bool
    evidence: IssueDiagnosticEvidence
    metadata: Metadata
    context: TelemetryContext


class LogAttributes(TypedDict, total=False):
    """Public log event attributes."""
    message: str
    level: str
    logger: str
    metadata: Metadata
    context: TelemetryContext


class ActionAttributes(TypedDict, total=False):
    """Public action event attributes."""
    name: str
    status: str
    metadata: Metadata
    context: TelemetryContext


class MetricAttributes(TypedDict, total=False):
    """Public metric event attributes."""
    name: str
    description: str
    kind: Literal["counter", "gauge", "histogram"]
    value: float
    unit: str
    temporality: Literal["delta", "cumulative", "instant"]
    metadata: Metadata
    context: TelemetryContext


class ScriptedTransportResponse(TypedDict):
    status_code: int
    retry_after_ms: NotRequired[int]


class Transport(Protocol):
    """Public transport protocol used by client flush, shutdown, and logging helpers."""

    def send(self, api_key: str, body: str) -> TransportResponse:
        """Send an already serialized event batch body."""


ISSUE_LEVELS = {"info", "warning", "error", "critical"}
SEVERITY_ALIASES = {
    "trace": "info",
    "debug": "info",
    "info": "info",
    "warn": "warning",
    "warning": "warning",
    "error": "error",
    "fatal": "critical",
    "critical": "critical",
}
SEVERITY_VALUES = set(SEVERITY_ALIASES)
SPAN_STATUSES = {"ok", "error"}
ACTION_STATUSES = {"queued", "running", "success", "failure"}
METRIC_TEMPORALITIES_BY_KIND = {
    "counter": {"delta", "cumulative"},
    "gauge": {"instant"},
    "histogram": {"delta", "cumulative"},
}
METRIC_KINDS = set(METRIC_TEMPORALITIES_BY_KIND)
NON_NEGATIVE_METRIC_KINDS = {"counter", "histogram"}
MAX_METRIC_DESCRIPTION_LENGTH = 1_024
DEFAULT_HTTP_ENDPOINT = "https://api.logbrew.co/v1/events"
_HTTP_USER_AGENT_PRODUCT = "logbrew-sdk-python"
DEFAULT_MAX_QUEUE_SIZE = 10_000
DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_BATCH_EVENTS = 100
DEFAULT_MAX_BATCH_BYTES = 256 * 1024
MAX_CLIENT_REPORT_REASONS = 16
MAX_CLIENT_REPORT_COUNT = 1_000_000_000
CLIENT_REPORT_SAVE_INTERVAL_SECONDS = 1.0
CLIENT_REPORT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
CLIENT_REPORT_REASON_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
TRACEPARENT_PATTERN = re.compile(r"^([0-9a-fA-F]{2})-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$")
ZERO_TRACE_ID = "00000000000000000000000000000000"
ZERO_SPAN_ID = "0000000000000000"

LOG_RECORD_BUILTINS = frozenset(
    logging.LogRecord(
        name="logbrew",
        level=logging.INFO,
        pathname="logbrew.py",
        lineno=1,
        msg="",
        args=(),
        exc_info=None,
    ).__dict__
) | {"message", "asctime"}


@dataclass(slots=True)
class TransportError(Exception):
    """Transport failure with a stable public code and retry hint."""
    code: str
    message: str
    retryable: bool = False

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    @classmethod
    def network(cls, message: str) -> TransportError:
        """Create a retryable network failure that preserves queued events."""
        return cls(code="network_failure", message=message, retryable=True)


@dataclass(slots=True)
class TransportResponse:
    """Stable transport response returned from flush and shutdown operations."""
    status_code: Annotated[int, "Final HTTP-like status returned by the transport."]
    attempts: Annotated[int, "Number of transport attempts used for the flush."]
    batches: Annotated[int, "Number of accepted request batches."] = field(default=0, compare=False)
    accepted_events: Annotated[int, "Number of events accepted across request batches."] = field(
        default=0,
        compare=False,
    )
    retry_after_ms: Annotated[int | None, "Bounded server-directed retry delay in milliseconds."] = field(
        default=None,
        compare=False,
    )


EventDropReason: TypeAlias = Literal["queue_overflow", "queue_bytes_overflow", "event_too_large", "evicted_for_fatal"]


@dataclass(frozen=True, slots=True)
class EventDrop:
    """Content-free description of one event the local queue rejected."""

    event_id: str
    event_type: str
    reason: EventDropReason
    dropped_events: Annotated[int, "Total events this client has dropped, including this one."]


@dataclass(frozen=True, slots=True)
class TraceparentContext:
    """Parsed W3C traceparent context."""

    version: str
    trace_id: str
    parent_span_id: str
    trace_flags: str
    sampled: bool


class RecordingTransport:
    """Scripted transport for previewing, accepting, or failing queued event flushes."""

    sent_bodies: Annotated[list[str], "Every request body sent through this transport instance."]

    def __init__(
        self,
        scripted_responses: list[ScriptedTransportResponse | Exception] | None = None,
    ) -> None:
        self.scripted_responses = list(scripted_responses or [{"status_code": 202}])
        self.sent_bodies: list[str] = []

    @classmethod
    def always_accept(cls) -> RecordingTransport:
        """Create a transport that accepts queued flushes with a 202 response."""
        return cls([{"status_code": 202}])

    def last_body(self) -> str | None:
        """Return the most recent request body sent through this transport."""
        if not self.sent_bodies:
            return None
        return self.sent_bodies[-1]

    def send(self, api_key: str, body: str) -> TransportResponse:
        require_non_empty("api_key", api_key)
        self.sent_bodies.append(body)

        next_response = self.scripted_responses.pop(0) if self.scripted_responses else {"status_code": 202}
        if isinstance(next_response, Exception):
            raise next_response

        return TransportResponse(
            status_code=int(next_response["status_code"]),
            attempts=1,
            retry_after_ms=next_response.get("retry_after_ms"),
        )


class HttpTransport:
    """HTTP transport for sending queued batches with portable TLS verification."""

    def __init__(
        self,
        *,
        endpoint: str = DEFAULT_HTTP_ENDPOINT,
        headers: Mapping[str, str] | None = None,
        timeout: float = 10.0,
        open_url: Callable[..., Any] | None = None,
    ) -> None:
        require_non_empty("endpoint", endpoint)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise SdkError("configuration_error", "HttpTransport timeout must be positive")
        ignore_breadcrumb_url(endpoint)
        try:
            timeout_seconds = float(timeout)
        except OverflowError:
            raise SdkError("configuration_error", "HttpTransport timeout must be finite and positive") from None
        if not math.isfinite(timeout_seconds):
            raise SdkError("configuration_error", "HttpTransport timeout must be finite and positive")
        self.endpoint = endpoint
        self.headers = validate_headers(headers)
        self._default_user_agent = (
            None
            if any(name.lower() == "user-agent" for name in self.headers)
            else _default_http_user_agent()
        )
        self.timeout = timeout_seconds
        self.open_url = open_url or partial(
            urlopen,
            context=_default_http_ssl_context(),
        )

    def send(self, api_key: str, body: str) -> TransportResponse:
        """POST one serialized event batch and return the HTTP status."""
        require_non_empty("api_key", api_key)
        request_headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
            **self.headers,
        }
        if self._default_user_agent is not None:
            request_headers["user-agent"] = self._default_user_agent
        request = Request(
            self.endpoint,
            data=body.encode("utf-8"),
            headers=request_headers,
            method="POST",
        )
        try:
            response = self.open_url(request, timeout=self.timeout)
            try:
                status = getattr(response, "status", None)
                if status is None:
                    status = response.getcode()
                return TransportResponse(
                    status_code=int(status),
                    attempts=1,
                    retry_after_ms=parse_retry_after_ms(getattr(response, "headers", None)),
                )
            finally:
                close_response = getattr(response, "close", None)
                if callable(close_response):
                    close_response()
        except HTTPError as error:
            try:
                return TransportResponse(
                    status_code=int(error.code),
                    attempts=1,
                    retry_after_ms=parse_retry_after_ms(error.headers),
                )
            finally:
                error.close()
        except OSError as error:
            raise TransportError.network(f"http transport failed: {error}") from error


class LogBrewClient:
    """Buffered public client for validating, previewing, and flushing LogBrew events."""

    @classmethod
    def create(
        cls,
        *,
        api_key: str,
        sdk_name: str,
        sdk_version: str,
        context: TelemetryContext | None = None,
        capture_runtime_context: bool = True,
        transport: Transport | None = None,
        automatic_delivery: bool | None = None,
        delivery_interval_seconds: float = DEFAULT_DELIVERY_INTERVAL_SECONDS,
        delivery_queue_threshold: int | None = None,
        max_retries: int = 2,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
        max_batch_events: int = DEFAULT_MAX_BATCH_EVENTS,
        max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
        persistent_queue_directory: str | os.PathLike[str] | None = None,
        persistent_queue_encryption_key: bytes | bytearray | memoryview | None = None,
        on_event_dropped: Callable[[EventDrop], None] | None = None,
        breadcrumbs: bool = True,
    ) -> LogBrewClient:
        """Create a client from public SDK identity, retry, and API key settings."""
        require_non_empty("api_key", api_key)
        require_non_empty("sdk_name", sdk_name)
        require_non_empty("sdk_version", sdk_version)
        return cls(
            api_key=api_key,
            sdk={"name": sdk_name, "language": "python", "version": sdk_version},
            context=context,
            capture_runtime_context=capture_runtime_context,
            transport=transport,
            automatic_delivery=automatic_delivery,
            delivery_interval_seconds=delivery_interval_seconds,
            delivery_queue_threshold=delivery_queue_threshold,
            max_retries=max_retries,
            max_queue_size=max_queue_size,
            max_queue_bytes=max_queue_bytes,
            max_batch_events=max_batch_events,
            max_batch_bytes=max_batch_bytes,
            persistent_queue_directory=persistent_queue_directory,
            persistent_queue_encryption_key=persistent_queue_encryption_key,
            on_event_dropped=on_event_dropped,
            breadcrumbs=breadcrumbs,
        )

    def __init__(
        self,
        *,
        api_key: str,
        sdk: dict[str, str],
        context: TelemetryContext | None = None,
        capture_runtime_context: bool = True,
        transport: Transport | None = None,
        automatic_delivery: bool | None = None,
        delivery_interval_seconds: float = DEFAULT_DELIVERY_INTERVAL_SECONDS,
        delivery_queue_threshold: int | None = None,
        max_retries: int,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
        max_batch_events: int = DEFAULT_MAX_BATCH_EVENTS,
        max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
        persistent_queue_directory: str | os.PathLike[str] | None = None,
        persistent_queue_encryption_key: bytes | bytearray | memoryview | None = None,
        on_event_dropped: Callable[[EventDrop], None] | None = None,
        breadcrumbs: bool = True,
    ) -> None:
        if not isinstance(capture_runtime_context, bool):
            raise SdkError("configuration_error", "capture_runtime_context must be a boolean")
        if not isinstance(breadcrumbs, bool):
            raise SdkError("configuration_error", "breadcrumbs must be a boolean")
        self._breadcrumbs = breadcrumbs
        if breadcrumbs:
            install_automatic_breadcrumbs()
        _require_positive_integer("max_queue_size", max_queue_size)
        _require_positive_integer("max_queue_bytes", max_queue_bytes)
        _require_positive_integer("max_batch_events", max_batch_events)
        _require_positive_integer("max_batch_bytes", max_batch_bytes)
        automatic_options = resolve_automatic_delivery_options(
            has_owned_transport=transport is not None,
            automatic_delivery=automatic_delivery,
            interval_seconds=delivery_interval_seconds,
            queue_threshold=delivery_queue_threshold,
            max_queue_size=max_queue_size,
        )
        if persistent_queue_directory is None and persistent_queue_encryption_key is not None:
            raise SdkError(
                "configuration_error",
                "persistent_queue_encryption_key requires persistent_queue_directory",
            )
        if persistent_queue_directory is not None and persistent_queue_encryption_key is None:
            raise SdkError(
                "configuration_error",
                "persistent_queue_encryption_key is required when persistent_queue_directory is set",
            )
        self.api_key = api_key
        self.sdk = sdk
        self._sdk_json = _compact_json(sdk)
        context_with_environment = add_environment_resource_context(context)
        self._context = (
            add_python_runtime_context(context_with_environment)
            if capture_runtime_context
            else validate_telemetry_context(context_with_environment, label="client telemetry context")
        )
        self.max_retries = max_retries
        self.max_queue_size = max_queue_size
        self.max_queue_bytes = max_queue_bytes
        self.max_batch_events = max_batch_events
        self.max_batch_bytes = max_batch_bytes
        self._dropped_events = 0
        self._dropped_events_by_reason: dict[EventDropReason, int] = {}
        self._on_event_dropped = on_event_dropped
        self._drop_callback_state = local()
        self._owner_pid = os.getpid()
        self._state_lock = RLock()
        self._flush_lock = Lock()
        self._flush_owner_thread_id: int | None = None
        self._frozen_prefix: DeliveryPrefix | None = None
        self._closing = False
        self.closed = False
        self._owned_transport = transport
        if persistent_queue_directory is None:
            queue: EventQueue = MemoryEventQueue()
        else:
            assert persistent_queue_encryption_key is not None
            queue = PersistentEventQueue(
                directory=persistent_queue_directory,
                sdk_json=self._sdk_json,
                max_queue_size=max_queue_size,
                max_queue_bytes=max_queue_bytes,
                max_batch_bytes=max_batch_bytes,
                encryption_key=persistent_queue_encryption_key,
            )
        self._queue = queue
        # A persistent queue keeps counts not yet acknowledged by a 2xx across restarts.
        self._client_report_saved_at = -math.inf
        # Drops not yet acknowledged by the intake ride in the next batch as a client report; drops
        # frozen under one report ID wait until a 2xx acknowledges a body that carried them.
        self._pending_report, self._unreported_drops = _load_client_report(queue)
        self._automatic_delivery = AutomaticDeliveryController(
            enabled=automatic_options.enabled,
            interval_seconds=automatic_options.interval_seconds,
            queue_threshold=automatic_options.queue_threshold,
            deliver=self._run_automatic_delivery,
        )
        if self._queue.count:
            self._automatic_delivery.event_retained(self._queue.count)

    @property
    def events(self) -> list[dict[str, Any]]:
        """Return a detached snapshot of queued events for read compatibility."""
        self._assert_owner()
        with self._state_lock:
            if self.closed:
                return []
            return [json.loads(record.json) for record in self._queue.snapshot()]

    def pending_events(self) -> int:
        """Return the queued event count currently buffered locally."""
        self._assert_owner()
        with self._state_lock:
            if self.closed:
                return 0
            return self._queue.count

    def pending_event_bytes(self) -> int:
        """Return exact compact event JSON bytes currently buffered locally."""
        self._assert_owner()
        with self._state_lock:
            if self.closed:
                return 0
            return self._queue.byte_count

    def dropped_events(self) -> int:
        """Return the number of events dropped because local queue bounds were reached."""
        self._assert_owner()
        with self._state_lock:
            return self._dropped_events

    def dropped_events_by_reason(self) -> dict[EventDropReason, int]:
        """Return dropped event counts keyed by drop reason."""
        self._assert_owner()
        with self._state_lock:
            return dict(self._dropped_events_by_reason)

    def delivery_health(self) -> DeliveryHealthSnapshot:
        """Return a fixed content-free snapshot of local delivery state."""
        self._assert_owner()
        with self._state_lock:
            pending_events = 0 if self.closed else self._queue.count
            pending_event_bytes = 0 if self.closed else self._queue.byte_count
            dropped_events = self._dropped_events
        return self._automatic_delivery.snapshot(
            pending_events=pending_events,
            pending_event_bytes=pending_event_bytes,
            dropped_events=dropped_events,
        )

    def purge_pending_events(self) -> int:
        """Explicitly and durably remove all locally queued events."""
        self._assert_owner()
        with self._state_lock:
            if self.closed or self._closing:
                raise SdkError("shutdown_error", "client is already shut down")
            if self._flush_owner_thread_id is not None:
                raise SdkError("queue_busy_error", "pending events cannot be purged during delivery")
            removed = self._queue.purge()
            self._frozen_prefix = None
        self._automatic_delivery.queue_changed(0)
        return removed

    def recover_pending_events(self) -> int:
        """Revalidate local queue durability and return the pending event count."""

        self._assert_owner()
        with self._state_lock:
            if self.closed or self._closing:
                raise SdkError("shutdown_error", "client is already shut down")
            if self._flush_owner_thread_id is not None:
                raise SdkError("queue_busy_error", "pending events cannot be recovered during delivery")
            pending_events = self._queue.recover()
        if pending_events:
            self._automatic_delivery.event_retained(pending_events)
        else:
            self._automatic_delivery.queue_changed(0)
        return pending_events

    def preview_json(self) -> str:
        """Return the queued event batch as stable, pretty-printed JSON."""
        return json.dumps({"sdk": self.sdk, "events": self.events}, indent=2, ensure_ascii=False)

    def release(self, event_id: str, timestamp: str, attributes: ReleaseAttributes) -> None:
        self._push_event("release", event_id, timestamp, validate_release(attributes))

    def environment(self, event_id: str, timestamp: str, attributes: EnvironmentAttributes) -> None:
        self._push_event("environment", event_id, timestamp, validate_environment(attributes))

    def issue(self, event_id: str, timestamp: str, attributes: IssueAttributes) -> None:
        if self._breadcrumbs and "breadcrumbs" not in attributes:
            # Attach what led up to the issue in the active request scope, or the process scope.
            breadcrumbs, truncated = current_breadcrumbs()
            if breadcrumbs:
                attributes = cast(
                    IssueAttributes,
                    {**attributes, "breadcrumbs": breadcrumbs, **({"breadcrumbsTruncated": True} if truncated else {})},
                )
        self._push_event("issue", event_id, timestamp, validate_issue(attributes))

    def log(self, event_id: str, timestamp: str, attributes: LogAttributes) -> None:
        self._push_event("log", event_id, timestamp, validate_log(attributes))

    def span(self, event_id: str, timestamp: str, attributes: SpanAttributes) -> None:
        self._push_event("span", event_id, timestamp, validate_span(attributes))

    def action(self, event_id: str, timestamp: str, attributes: ActionAttributes) -> None:
        self._push_event("action", event_id, timestamp, validate_action(attributes))

    def metric(self, event_id: str, timestamp: str, attributes: MetricAttributes) -> None:
        self._push_event("metric", event_id, timestamp, validate_metric(attributes))

    def flush(self, transport: Transport | None = None) -> TransportResponse:
        """Flush queued events through a transport while preserving retry semantics."""
        self._assert_owner()
        selected_transport = self._resolve_transport(transport)
        uses_owned_transport = selected_transport is self._owned_transport
        thread_id = get_ident()
        with self._state_lock:
            self._require_open_for_delivery(thread_id)

        with self._flush_lock:
            with self._state_lock:
                self._require_open_for_delivery(thread_id)
                self._flush_owner_thread_id = thread_id
            self._automatic_delivery.manual_delivery_started()
            try:
                response = self._flush_internal(selected_transport)
            except BaseException as error:
                # Failure statistics must not replace the original delivery error.
                pending_events: int | None
                try:
                    with self._state_lock:
                        pending_events = self._queue.count
                except BaseException:
                    pending_events = None
                self._automatic_delivery.manual_delivery_failed(
                    error,
                    pending_events=pending_events,
                    owned=uses_owned_transport,
                )
                raise
            else:
                with self._state_lock:
                    pending_events = self._queue.count
                self._automatic_delivery.manual_delivery_succeeded(
                    accepted_events=response.accepted_events,
                    pending_events=pending_events,
                    owned=uses_owned_transport,
                )
                return response
            finally:
                with self._state_lock:
                    self._flush_owner_thread_id = None
                self._automatic_delivery.manual_delivery_finished()

    def shutdown(self, transport: Transport | None = None) -> TransportResponse:
        """Flush queued events, then mark the client closed so later writes fail."""
        self._assert_owner()
        selected_transport = self._resolve_transport(transport)
        uses_owned_transport = selected_transport is self._owned_transport
        thread_id = get_ident()
        with self._state_lock:
            self._require_open_for_delivery(thread_id)
            self._closing = True
        try:
            scheduler = self._automatic_delivery.begin_shutdown()
            if scheduler is not None and scheduler.ident != thread_id:
                scheduler.join()
            with self._flush_lock:
                with self._state_lock:
                    self._flush_owner_thread_id = thread_id
                self._automatic_delivery.manual_delivery_started()
                try:
                    try:
                        response = self._flush_internal(selected_transport)
                    finally:
                        with self._state_lock:
                            self._save_client_report(immediately=True)
                    self._queue.close()
                except BaseException as error:
                    with self._state_lock:
                        pending_events = self._queue.count
                    self._automatic_delivery.manual_delivery_failed(
                        error,
                        pending_events=pending_events,
                        owned=uses_owned_transport,
                    )
                    raise
                else:
                    self._automatic_delivery.manual_delivery_succeeded(
                        accepted_events=response.accepted_events,
                        pending_events=0,
                        owned=uses_owned_transport,
                    )
                finally:
                    with self._state_lock:
                        self._flush_owner_thread_id = None
                    self._automatic_delivery.manual_delivery_finished()
        except BaseException:
            with self._state_lock:
                self._closing = False
                pending_events = self._queue.count
            self._automatic_delivery.abort_shutdown(pending_events)
            raise

        with self._state_lock:
            self._closing = False
            self.closed = True
        self._automatic_delivery.mark_closed()
        return response

    def _push_event(
        self,
        event_type: str,
        event_id: str,
        timestamp: str,
        attributes: dict[str, Any],
    ) -> None:
        self._assert_owner()
        require_non_empty("event id", event_id)
        require_timestamp(timestamp)
        event_context = attributes.pop("context", None)
        if (active_trace := trace_metadata()) and event_type != "span":
            event_context = merge_telemetry_contexts({"schemaVersion": 1, "trace": active_trace}, event_context)
        if (user_subject := active_user_subject()) is not None:
            event_context = merge_telemetry_contexts({"schemaVersion": 1, "subject": user_subject}, event_context)
        merged_context = merge_telemetry_contexts(self._context, event_context)
        if merged_context is not None:
            attributes["context"] = merged_context
        event = {
            "type": event_type,
            "id": event_id,
            "timestamp": timestamp,
            "attributes": attributes,
        }
        try:
            event_json = _compact_json(event)
        except (TypeError, ValueError) as error:
            raise SdkError("validation_error", "event must contain JSON-compatible finite values") from error
        event_bytes = len(event_json.encode("utf-8"))
        request_bytes = len(f'{{"sdk":{self._sdk_json},"events":[{event_json}]}}'.encode())

        with self._state_lock:
            if self.closed or self._closing:
                raise SdkError("shutdown_error", "client is already shut down")
            reason, evicted_drops = self._admission(event_type, attributes, event_bytes, request_bytes)
            if reason is not None:
                drop = self._record_drop(event_id, event_type, reason)
            else:
                self._queue.append(
                    record_id=uuid4().hex,
                    event_json=event_json,
                    byte_count=event_bytes,
                )
                pending_events = self._queue.count
        if reason is None:
            self._automatic_delivery.event_retained(pending_events)
            # Report evictions only after admission so drop callbacks cannot refill the freed room.
            for evicted_drop in evicted_drops:
                self._report_drop(evicted_drop)
        else:
            self._report_drop(drop)

    def _admission(
        self, event_type: str, attributes: Mapping[str, Any], event_bytes: int, request_bytes: int
    ) -> tuple[EventDropReason | None, list[EventDrop]]:
        """Return the drop reason, or None after making room; callers hold the state lock."""
        reason: EventDropReason | None = None
        if event_bytes > self.max_queue_bytes or request_bytes > self.max_batch_bytes:
            return "event_too_large", []
        if self._queue.count >= self.max_queue_size:
            reason = "queue_overflow"
        elif self._queue.byte_count + event_bytes > self.max_queue_bytes:
            reason = "queue_bytes_overflow"
        if reason is None or not _is_fatal_event(event_type, attributes):
            return reason, []
        # A crash report outranks older non-crash events, like the JavaScript SDK.
        evicted = self._evict_for_fatal(event_bytes)
        if not evicted:
            return reason, []
        return None, [self._record_drop(*_queued_identity(record), "evicted_for_fatal") for record in evicted]

    def _record_drop(self, event_id: str, event_type: str, reason: EventDropReason) -> EventDrop:
        self._dropped_events += 1
        self._dropped_events_by_reason[reason] = self._dropped_events_by_reason.get(reason, 0) + 1
        first_of_reason = reason not in self._unreported_drops
        self._unreported_drops[reason] = min(MAX_CLIENT_REPORT_COUNT, self._unreported_drops.get(reason, 0) + 1)
        self._save_client_report(immediately=first_of_reason)
        return EventDrop(event_id, event_type, reason, self._dropped_events)

    def _evict_for_fatal(self, event_bytes: int) -> tuple[QueuedEvent, ...]:
        """Remove the oldest non-crash events outside the frozen delivery body, only when that makes room."""
        protected_through = 0 if self._frozen_prefix is None else self._frozen_prefix.through_sequence
        count = self._queue.count
        byte_count = self._queue.byte_count + event_bytes
        chosen: list[QueuedEvent] = []
        for record in self._queue.snapshot():
            if count < self.max_queue_size and byte_count <= self.max_queue_bytes:
                break
            if record.sequence <= protected_through or _is_fatal_record(record):
                continue
            chosen.append(record)
            count -= 1
            byte_count -= record.byte_count
        if count >= self.max_queue_size or byte_count > self.max_queue_bytes:
            return ()
        self._queue.remove({record.sequence for record in chosen})
        return tuple(chosen)

    def _save_client_report(self, *, immediately: bool) -> None:
        """Save at once for a new report or reason, and at most once a second during a drop burst."""
        now = time.monotonic()
        if not immediately and now - self._client_report_saved_at < CLIENT_REPORT_SAVE_INTERVAL_SECONDS:
            return
        self._client_report_saved_at = now
        pending = self._pending_report
        report = {
            "pending": None if pending is None else {"report_id": pending[0], "dropped_events": dict(pending[1])},
            "unreported": dict(self._unreported_drops),
        }
        try:
            self._queue.save_client_report(report if pending is not None or self._unreported_drops else None)
        except Exception:
            # Drop counts are advisory: a failed save keeps them in memory and never blocks capture.
            return

    def _report_drop(self, drop: EventDrop) -> None:
        # Drop callbacks are advisory: failures and nested drops never reach the application.
        state = self._drop_callback_state
        if self._on_event_dropped is None or getattr(state, "active", False):
            return
        state.active = True
        try:
            with suppress(Exception):
                self._on_event_dropped(drop)
        finally:
            state.active = False

    def _flush_internal(self, transport: Transport) -> TransportResponse:
        self._assert_owner()
        with self._state_lock:
            self._reconcile_frozen_prefix()
            snapshot_end = self._queue.last_sequence()
        if snapshot_end is None:
            return TransportResponse(status_code=204, attempts=0, batches=0, accepted_events=0)

        total_attempts = 0
        accepted_batches = 0
        accepted_events = 0
        final_status = 204
        while True:
            with self._state_lock:
                prefix = self._frozen_prefix
                if prefix is None:
                    records = self._queue.snapshot(through_sequence=snapshot_end)
                    if records:
                        batch, body, reported_drops = self._build_batch(records)
                        prefix = DeliveryPrefix(
                            through_sequence=batch[-1].sequence,
                            event_count=len(batch),
                            body=body,
                            reported_drops=reported_drops,
                        )
                        self._frozen_prefix = prefix
            if prefix is None:
                return TransportResponse(
                    status_code=final_status,
                    attempts=total_attempts,
                    batches=accepted_batches,
                    accepted_events=accepted_events,
                )

            response = self._send_body(transport, prefix.body)
            self._assert_owner()
            total_attempts += response.attempts
            final_status = response.status_code
            with self._state_lock:
                if self._frozen_prefix is not prefix:
                    raise SdkError("queue_state_error", "delivery prefix ownership changed")
                acknowledged = self._queue.acknowledge(prefix.through_sequence)
                if acknowledged == prefix.event_count:
                    self._frozen_prefix = None
                # Drops recorded while this body was in flight stay pending under a new report ID.
                if prefix.reported_drops:
                    self._pending_report = None
                    self._save_client_report(immediately=True)
            if acknowledged != prefix.event_count:
                raise SdkError("queue_state_error", "accepted event prefix changed during delivery")
            self._automatic_delivery.record_accepted_events(acknowledged)
            accepted_batches += 1
            accepted_events += acknowledged

    def _reconcile_frozen_prefix(self) -> None:
        prefix = self._frozen_prefix
        if prefix is None:
            return
        retained = self._queue.snapshot(through_sequence=prefix.through_sequence)
        if not retained:
            self._frozen_prefix = None
            return
        if len(retained) != prefix.event_count:
            raise SdkError("queue_state_error", "retained delivery prefix changed")

    def _build_batch(
        self, records: tuple[QueuedEvent, ...]
    ) -> tuple[tuple[QueuedEvent, ...], str, tuple[tuple[str, int], ...]]:
        prefix = f'{{"sdk":{self._sdk_json},"events":['
        if self._pending_report is None:
            # Freeze unreported drops under one stable ID, so every resend of them is counted once.
            drops = tuple(
                (reason, count) for reason, count in self._unreported_drops.items() if count > 0
            )[:MAX_CLIENT_REPORT_REASONS]
            if drops:
                for reason, _count in drops:
                    del self._unreported_drops[reason]
                self._pending_report = (uuid4().hex, drops)
                self._save_client_report(immediately=True)
        if self._pending_report is not None:
            report_id, reported_drops = self._pending_report
            report = _compact_json({"report_id": report_id, "dropped_events": dict(reported_drops)})
            batch = self._fit_batch(records, prefix, f'],"client_report":{report}}}')
            if batch:
                # A report never pushes a batch over max_batch_bytes; it waits for a batch with room.
                body = f'{prefix}{",".join(record.json for record in batch)}],"client_report":{report}}}'
                return batch, body, reported_drops
        batch = self._fit_batch(records, prefix, "]}")
        if not batch:
            raise SdkError("queue_state_error", "queued event cannot fit the configured request limit")
        return batch, f"{prefix}{','.join(record.json for record in batch)}]}}", ()

    def _fit_batch(self, records: tuple[QueuedEvent, ...], prefix: str, suffix: str) -> tuple[QueuedEvent, ...]:
        body_bytes = len(prefix.encode("utf-8")) + len(suffix.encode("utf-8"))
        batch: list[QueuedEvent] = []
        for record in records:
            separator_bytes = 1 if batch else 0
            if len(batch) >= self.max_batch_events:
                break
            if body_bytes + separator_bytes + record.byte_count > self.max_batch_bytes:
                break
            batch.append(record)
            body_bytes += separator_bytes + record.byte_count
        return tuple(batch)

    def _send_body(self, transport: Transport, body: str) -> TransportResponse:
        def send_once() -> TransportResponse:
            self._automatic_delivery.record_transport_attempt()
            try:
                return transport.send(self.api_key, body)
            except TransportError as error:
                raise DeliverySendError(
                    error.code,
                    error.message,
                    retryable=error.retryable,
                ) from error

        result = send_with_retry_policy(send_once, max_retries=self.max_retries)
        return TransportResponse(
            status_code=result.status_code,
            attempts=result.attempts,
            batches=1,
            accepted_events=0,
        )

    def _run_automatic_delivery(self) -> tuple[int, int]:
        self._assert_owner()
        transport = self._owned_transport
        if transport is None:
            raise SdkError("configuration_error", "automatic delivery requires an owned transport")
        thread_id = get_ident()
        with self._flush_lock:
            with self._state_lock:
                if self.closed or self._closing:
                    return 0, 0 if self.closed else self._queue.count
                self._require_open_for_delivery(thread_id)
                self._flush_owner_thread_id = thread_id
            try:
                response = self._flush_internal(transport)
                with self._state_lock:
                    pending_events = self._queue.count
                return response.accepted_events, pending_events
            finally:
                with self._state_lock:
                    self._flush_owner_thread_id = None

    def _resolve_transport(self, transport: Transport | None) -> Transport:
        if transport is not None:
            return transport
        if self._owned_transport is None:
            raise SdkError("configuration_error", "delivery requires an owned transport or explicit transport")
        return self._owned_transport

    def _require_open_for_delivery(self, thread_id: int) -> None:
        if self.closed or self._closing:
            raise SdkError("shutdown_error", "client is already shut down")
        if self._flush_owner_thread_id == thread_id:
            raise SdkError("queue_reentrant_error", "delivery cannot be reentered from the transport")

    def _assert_owner(self) -> None:
        if os.getpid() != self._owner_pid:
            raise SdkError(
                "process_ownership_error",
                "client cannot be used after fork; create a new client in the child process",
            )


def _load_client_report(
    queue: EventQueue,
) -> tuple[tuple[str, tuple[tuple[str, int], ...]] | None, dict[str, int]]:
    """Restore saved drop counts; anything unreadable or out of bounds is ignored, never fatal."""
    try:
        state = queue.load_client_report() or {}
    except Exception:
        state = {}
    pending = state.get("pending")
    pending_counts = _valid_client_report_counts(pending.get("dropped_events") if isinstance(pending, dict) else None)
    report_id = pending.get("report_id") if isinstance(pending, dict) else None
    restored = (
        (report_id, tuple(pending_counts.items()))
        if isinstance(report_id, str) and CLIENT_REPORT_ID_PATTERN.fullmatch(report_id) and pending_counts
        else None
    )
    return restored, _valid_client_report_counts(state.get("unreported"))


def _valid_client_report_counts(counts: Any) -> dict[str, int]:
    if not isinstance(counts, dict):
        return {}
    valid = [
        (reason, count)
        for reason, count in counts.items()
        if isinstance(reason, str)
        and CLIENT_REPORT_REASON_PATTERN.fullmatch(reason)
        and type(count) is int
        and 1 <= count <= MAX_CLIENT_REPORT_COUNT
    ]
    return dict(valid[:MAX_CLIENT_REPORT_REASONS])


def _is_fatal_event(event_type: str, attributes: Mapping[str, Any]) -> bool:
    # Fatal input severity is stored as critical; a critical issue is a crash report.
    return event_type == "issue" and attributes.get("level") == "critical"


def _is_fatal_record(record: QueuedEvent) -> bool:
    event = json.loads(record.json)
    return _is_fatal_event(event.get("type", ""), event.get("attributes", {}))


def _queued_identity(record: QueuedEvent) -> tuple[str, str]:
    event = json.loads(record.json)
    return str(event.get("id", "")), str(event.get("type", ""))


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _require_positive_integer(name: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise SdkError("configuration_error", f"{name} must be a positive integer")


class LogBrewLoggingHandler(logging.Handler):
    """Standard-library logging handler that turns LogRecord objects into LogBrew log events."""

    def __init__(
        self,
        client: LogBrewClient,
        transport: Transport | None = None,
        *,
        flush_on_emit: bool = False,
        include_exception_text: bool = False,
        metadata: Metadata | None = None,
        context_provider: Callable[[logging.LogRecord], TelemetryContext | None] | None = None,
        raise_flush_errors: bool = False,
        level: int = logging.NOTSET,
    ) -> None:
        if context_provider is not None and not callable(context_provider):
            raise SdkError("configuration_error", "logging context_provider must be callable")
        super().__init__(level=level)
        self.client = client
        self.transport = transport
        self.flush_on_emit = flush_on_emit
        self.include_exception_text = include_exception_text
        self.metadata = dict(metadata or {})
        self.context_provider = context_provider
        self.raise_flush_errors = raise_flush_errors

    def emit(self, record: logging.LogRecord) -> None:
        """Queue one LogBrew log event from a standard-library log record."""
        try:
            event_id = default_log_record_event_id(record)
            timestamp = timestamp_from_log_record(record)
            attributes = log_attributes_from_record(
                record,
                include_exception_text=self.include_exception_text,
                metadata=self.metadata,
            )
            if self.context_provider is not None:
                context = merge_telemetry_contexts(self.context_provider(record), getattr(record, "context", None))
                if context is not None:
                    attributes["context"] = context
            self.client.log(
                event_id,
                timestamp,
                attributes,
            )
            if self.flush_on_emit:
                self._flush_transport()
        except Exception:
            self.handleError(record)

    def flush(self) -> None:
        """Flush queued records when a transport was provided to the handler."""
        self.acquire()
        try:
            self._flush_transport()
        finally:
            self.release()

    def _flush_transport(self) -> None:
        if self.transport is None or self.client.closed or self.client.pending_events() == 0:
            return
        try:
            self.client.flush(self.transport)
        except Exception:
            if self.raise_flush_errors:
                raise


def log_attributes_from_record(
    record: logging.LogRecord,
    *,
    include_exception_text: bool = False,
    metadata: Metadata | None = None,
) -> LogAttributes:
    """Convert a standard-library LogRecord into LogBrew log attributes."""
    merged_metadata = {
        **dict(metadata or {}),
        **metadata_from_log_record(record, include_exception_text=include_exception_text),
    }
    return {
        "message": record.getMessage(),
        "level": logbrew_level(record.levelno),
        "logger": record.name,
        "metadata": merged_metadata,
    }


def metadata_from_log_record(
    record: logging.LogRecord,
    *,
    include_exception_text: bool = False,
) -> Metadata:
    """Return privacy-conscious metadata from a standard-library LogRecord."""
    metadata: Metadata = {
        "fileName": record.filename,
        "functionName": record.funcName,
        "levelName": record.levelname,
        "levelNumber": record.levelno,
        "lineNumber": record.lineno,
        "module": record.module,
        "processName": record.processName,
        "threadName": record.threadName,
    }
    metadata.update(extra_metadata_from_log_record(record))
    metadata.update(trace_metadata())
    if record.exc_info is not None:
        exception = record.exc_info[1]
        if exception is not None:
            metadata["exceptionName"] = type(exception).__name__
            metadata["exceptionMessage"] = str(exception)
        if include_exception_text:
            formatter = logging.Formatter()
            metadata["exceptionText"] = formatter.formatException(record.exc_info)
    return metadata


def extra_metadata_from_log_record(record: logging.LogRecord) -> Metadata:
    """Collect primitive values passed through logging's extra argument."""
    metadata: Metadata = {}
    for key, value in record.__dict__.items():
        if key in LOG_RECORD_BUILTINS:
            continue
        if isinstance(value, str | int | float | bool) or value is None:
            metadata[key] = value
    return metadata


def timestamp_from_log_record(record: logging.LogRecord) -> str:
    """Return a UTC ISO-8601 timestamp for a standard-library log record."""
    return (
        datetime.fromtimestamp(record.created, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def default_log_record_event_id(record: logging.LogRecord) -> str:
    """Return an opaque ID stable for this record object's lifetime."""
    return _log_record_identity(record)


def logbrew_level(level_number: int) -> str:
    """Map standard-library logging levels to LogBrew log levels."""
    if level_number >= logging.CRITICAL:
        return "critical"
    if level_number >= logging.ERROR:
        return "error"
    if level_number >= logging.WARNING:
        return "warning"
    if level_number >= logging.INFO:
        return "info"
    return "info"


def parse_traceparent(traceparent: str) -> TraceparentContext:
    """Parse and validate a W3C traceparent header."""

    require_non_empty("traceparent", traceparent)
    match = TRACEPARENT_PATTERN.match(traceparent.strip())
    if match is None:
        raise SdkError(
            "validation_error",
            "traceparent must use W3C version-traceId-parentSpanId-traceFlags format",
        )

    version = match.group(1).lower()
    trace_id = match.group(2).lower()
    parent_span_id = match.group(3).lower()
    trace_flags = match.group(4).lower()
    if version == "ff":
        raise SdkError("validation_error", "traceparent version ff is not allowed")
    if trace_id == ZERO_TRACE_ID:
        raise SdkError("validation_error", "traceparent traceId must not be all zeros")
    if parent_span_id == ZERO_SPAN_ID:
        raise SdkError("validation_error", "traceparent parentSpanId must not be all zeros")

    return TraceparentContext(
        version=version,
        trace_id=trace_id,
        parent_span_id=parent_span_id,
        trace_flags=trace_flags,
        sampled=(int(trace_flags, 16) & 1) == 1,
    )


def create_traceparent(*, trace_id: str, span_id: str, trace_flags: str = "01") -> str:
    """Create a W3C traceparent header from explicit trace and span ids."""

    require_trace_id(trace_id)
    require_span_id("span_id", span_id)
    require_trace_flags(trace_flags)
    return f"00-{trace_id.lower()}-{span_id.lower()}-{trace_flags.lower()}"


def create_traceparent_headers(*, trace_id: str, span_id: str, trace_flags: str = "01") -> dict[str, str]:
    """Create an explicit outbound header carrier containing only traceparent."""

    return {
        "traceparent": create_traceparent(
            trace_id=trace_id,
            span_id=span_id,
            trace_flags=trace_flags,
        )
    }


def create_logbrew_trace_context(
    traceparent: str | None = None,
    *,
    span_id: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewTraceContext:
    """Create request-local trace context from W3C traceparent or a new local trace."""

    child_span_id = span_id
    if child_span_id is None:
        child_span_id = (span_id_factory or default_span_id_factory)()
    require_span_id("span_id", child_span_id)

    if traceparent:
        context = parse_traceparent(traceparent)
        return LogBrewTraceContext(
            trace_id=context.trace_id,
            span_id=child_span_id.lower(),
            parent_span_id=context.parent_span_id,
            sampled=context.sampled,
        )

    return LogBrewTraceContext(
        trace_id=default_trace_id(),
        span_id=child_span_id.lower(),
        sampled=False,
    )


def logbrew_trace_context_from_open_telemetry_span_context(
    span_context: Any,
    *,
    span_id: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewTraceContext | None:
    """Create a LogBrew child context from a live OpenTelemetry SpanContext.

    The helper intentionally duck-types OpenTelemetry objects so default LogBrew
    installs do not gain an OpenTelemetry dependency.
    """

    return _create_logbrew_context_from_open_telemetry_span_context(
        span_context,
        span_id=span_id,
        span_id_factory=span_id_factory or default_span_id_factory,
        span_id_validator=require_span_id,
    )


def logbrew_trace_context_from_open_telemetry_span(
    span: Any,
    *,
    span_id: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewTraceContext | None:
    """Create a LogBrew child context from an OpenTelemetry Span-like object."""

    return _create_logbrew_context_from_open_telemetry_span(
        span,
        span_id=span_id,
        span_id_factory=span_id_factory or default_span_id_factory,
        span_id_validator=require_span_id,
    )


def logbrew_trace_context_from_current_open_telemetry_span(
    *,
    span_id: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewTraceContext | None:
    """Create a LogBrew child context from OpenTelemetry's current span, if present."""

    return _create_logbrew_context_from_current_open_telemetry_span(
        span_id=span_id,
        span_id_factory=span_id_factory or default_span_id_factory,
        span_id_validator=require_span_id,
    )


def span_attributes_from_traceparent(
    traceparent: str,
    *,
    name: str,
    span_id: str,
    status: str,
    duration_ms: float | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> SpanAttributes:
    """Build LogBrew span attributes that continue an incoming W3C traceparent."""

    context = parse_traceparent(traceparent)
    require_non_empty("span name", name)
    require_span_id("span_id", span_id)
    require_allowed_value("span status", status, SPAN_STATUSES)
    if duration_ms is not None and (
        isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)) or duration_ms < 0
    ):
        raise SdkError("validation_error", "span durationMs must be non-negative")

    safe_metadata = compact_metadata(metadata)
    return {
        "name": name,
        "traceId": context.trace_id,
        "spanId": span_id.lower(),
        "parentSpanId": context.parent_span_id,
        "status": status,
        **({"durationMs": duration_ms} if duration_ms is not None else {}),
        **({"metadata": safe_metadata} if safe_metadata is not None else {}),
    }


def span_attributes_from_trace_context(
    trace: LogBrewTraceContext,
    *,
    name: str,
    status: str,
    duration_ms: float | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> SpanAttributes:
    """Build LogBrew span attributes from an existing request-local trace context."""

    require_non_empty("span name", name)
    require_allowed_value("span status", status, SPAN_STATUSES)
    if duration_ms is not None and (
        isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)) or duration_ms < 0
    ):
        raise SdkError("validation_error", "span durationMs must be non-negative")

    safe_metadata = compact_metadata(metadata)
    return {
        "name": name,
        "traceId": trace.trace_id,
        "spanId": trace.span_id,
        **({"parentSpanId": trace.parent_span_id} if trace.parent_span_id is not None else {}),
        "status": status,
        **({"durationMs": duration_ms} if duration_ms is not None else {}),
        **({"metadata": safe_metadata} if safe_metadata is not None else {}),
    }


def default_trace_id() -> str:
    """Return a fresh non-zero W3C-compatible trace id."""

    trace_id = uuid4_hex(16)
    return "00000000000000000000000000000001" if trace_id == ZERO_TRACE_ID else trace_id


def default_span_id_factory() -> str:
    """Return a fresh non-zero W3C-compatible span id."""

    span_id = uuid4_hex(8)
    return "0000000000000001" if span_id == ZERO_SPAN_ID else span_id


def uuid4_hex(byte_count: int) -> str:
    return uuid4().hex[: byte_count * 2]


def slugify(value: str) -> str:
    normalized = "".join(character.lower() if character.isalnum() else "_" for character in value)
    return normalized.strip("_") or "logger"


def require_trace_id(trace_id: Any) -> None:
    if not isinstance(trace_id, str) or re.fullmatch(r"[0-9a-fA-F]{32}", trace_id) is None:
        raise SdkError("validation_error", "traceId must be 32 lowercase or uppercase hex characters")
    if trace_id.lower() == ZERO_TRACE_ID:
        raise SdkError("validation_error", "traceId must not be all zeros")


def require_span_id(label: str, span_id: Any) -> None:
    if not isinstance(span_id, str) or re.fullmatch(r"[0-9a-fA-F]{16}", span_id) is None:
        raise SdkError("validation_error", f"{label} must be 16 lowercase or uppercase hex characters")
    if span_id.lower() == ZERO_SPAN_ID:
        raise SdkError("validation_error", f"{label} must not be all zeros")


def require_trace_flags(trace_flags: Any) -> None:
    if not isinstance(trace_flags, str) or re.fullmatch(r"[0-9a-fA-F]{2}", trace_flags) is None:
        raise SdkError("validation_error", "traceFlags must be 2 lowercase or uppercase hex characters")


def compact_metadata(metadata: Mapping[str, Any] | None) -> Metadata | None:
    if metadata is None:
        return None
    if not isinstance(metadata, Mapping):
        raise SdkError("validation_error", "metadata must be an object")
    safe_metadata: Metadata = {}
    for key, value in metadata.items():
        if isinstance(key, str) and (isinstance(value, str | int | float | bool) or value is None):
            safe_metadata[key] = value
    return safe_metadata


def validate_headers(headers: Mapping[str, str] | None) -> dict[str, str]:
    if headers is None:
        return {}
    safe_headers: dict[str, str] = {}
    for name, value in headers.items():
        require_non_empty("header name", name)
        if not isinstance(value, str):
            raise SdkError("configuration_error", "HttpTransport header values must be strings")
        safe_headers[name] = value
    return safe_headers


def _default_http_user_agent() -> str:
    try:
        package_version = distribution_version("logbrew-sdk")
    except PackageNotFoundError:
        return _HTTP_USER_AGENT_PRODUCT
    return f"{_HTTP_USER_AGENT_PRODUCT}/{package_version}"


def _default_http_ssl_context() -> ssl.SSLContext:
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(certifi.where())
    return context


def require_non_empty(label: str, value: Any) -> None:
    if not isinstance(value, str) or not value.strip():
        raise SdkError("validation_error", f"{label} must be non-empty")


def require_allowed_value(label: str, value: Any, allowed_values: set[str]) -> None:
    require_non_empty(label, value)
    if value not in allowed_values:
        allowed = ", ".join(sorted(allowed_values))
        raise SdkError("validation_error", f"{label} must be one of: {allowed}")


def normalize_severity(label: str, value: Any) -> str:
    require_allowed_value(label, value, SEVERITY_VALUES)
    return SEVERITY_ALIASES[value]


def require_finite_number(label: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SdkError("validation_error", f"{label} must be a finite number")


def metric_description_or_none(value: Any) -> str | None:
    normalized = value.strip() if isinstance(value, str) else ""
    if (
        not normalized
        or len(normalized) > MAX_METRIC_DESCRIPTION_LENGTH
        or any(
            ord(character) <= 31
            or 127 <= ord(character) <= 159
            or 0xD800 <= ord(character) <= 0xDFFF
            or ord(character) in {0x2028, 0x2029}
            for character in normalized
        )
    ):
        raise SdkError(
            "validation_error",
            "metric description must be a non-blank string of at most 1024 non-control characters",
        )
    return normalized


def require_timestamp(timestamp: Any) -> None:
    require_non_empty("timestamp", timestamp)
    if timestamp.endswith("Z"):
        return
    time_portion = timestamp.split("T")[1] if "T" in timestamp else ""
    if "+" in time_portion:
        return
    if "-" in time_portion[1:]:
        return
    raise SdkError("validation_error", f"timestamp must include a timezone offset: {timestamp}")


def clone_metadata(metadata: Any) -> dict[str, Any] | None:
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        raise SdkError("validation_error", "metadata must be an object")
    return dict(metadata)


def with_metadata(attributes: dict[str, Any], metadata: Any) -> dict[str, Any]:
    safe_metadata = clone_metadata(metadata)
    if safe_metadata is None:
        return attributes
    return {**attributes, "metadata": safe_metadata}


def with_common_attributes(
    normalized: dict[str, Any],
    source: Mapping[str, Any],
) -> dict[str, Any]:
    attributes = with_metadata(normalized, source.get("metadata"))
    if "context" in source:
        attributes["context"] = source["context"]
    return attributes


def validate_release(attributes: ReleaseAttributes) -> dict[str, Any]:
    require_non_empty("release version", attributes.get("version"))
    commit = attributes.get("commit")
    if commit is not None:
        require_non_empty("release commit", commit)
    return with_common_attributes(
        {
            "version": attributes["version"],
            **({"commit": commit} if commit is not None else {}),
            **({"notes": attributes["notes"]} if "notes" in attributes else {}),
        },
        attributes,
    )


def validate_environment(attributes: EnvironmentAttributes) -> dict[str, Any]:
    require_non_empty("environment name", attributes.get("name"))
    return with_common_attributes(
        {
            "name": attributes["name"],
            **({"region": attributes["region"]} if "region" in attributes else {}),
        },
        attributes,
    )


def validate_issue(attributes: IssueAttributes) -> dict[str, Any]:
    require_non_empty("issue title", attributes.get("title"))
    level = normalize_severity("issue level", attributes.get("level"))
    return with_common_attributes(
        {
            "title": attributes["title"],
            "level": level,
            **({"message": attributes["message"]} if "message" in attributes else {}),
            **validate_issue_diagnostics(attributes),
        },
        attributes,
    )


def create_issue_attributes_from_exception(
    error: BaseException,
    *,
    title: str | None = None,
    level: str = "error",
    message: str | None = None,
    mechanism: str = "python.exception",
    handled: bool = True,
    metadata: Mapping[str, Any] | None = None,
    context: TelemetryContext | None = None,
    breadcrumbs: list[IssueBreadcrumb] | None = None,
    breadcrumbs_truncated: bool = False,
    evidence: IssueDiagnosticEvidence | None = None,
    include_stack_frames: bool = True,
) -> IssueAttributes:
    """Build an issue with structured identity and a privacy-bounded traceback projection."""

    if not isinstance(error, BaseException):
        raise SdkError("validation_error", "issue error must be an exception")
    if not isinstance(include_stack_frames, bool):
        raise SdkError("validation_error", "include_stack_frames must be a boolean")

    exception_type = safe_issue_exception_type(error)
    exception_chain = issue_exception_chain_from_exception(
        error,
        mechanism=mechanism,
        handled=handled,
        include_stack_frames=include_stack_frames,
        capture_messages=message is None,
    )
    reported_exception = exception_chain["entries"][0]
    if message is None:
        message = cast(str, reported_exception.get("message", exception_type))
    stack_frames = cast(list[IssueStackFrame], reported_exception.get("stackFrames", []))
    attributes: IssueAttributes = {
        "title": title if title is not None else exception_type,
        "level": level,
        "message": message,
        "exception": {
            "type": exception_type,
            "mechanism": {"type": mechanism, "handled": handled},
        },
        "exceptionChain": cast(IssueExceptionChain, exception_chain),
        **({"stackFrames": stack_frames} if stack_frames else {}),
        **({"breadcrumbs": breadcrumbs} if breadcrumbs is not None else {}),
        **({"breadcrumbsTruncated": True} if breadcrumbs_truncated else {}),
        **({"evidence": evidence} if evidence is not None else {}),
        **({"metadata": dict(metadata)} if metadata is not None else {}),
        **({"context": context} if context is not None else {}),
    }
    return cast(IssueAttributes, validate_issue(attributes))


def validate_log(attributes: LogAttributes) -> dict[str, Any]:
    require_non_empty("log message", attributes.get("message"))
    level = normalize_severity("log level", attributes.get("level"))
    return with_common_attributes(
        {
            "message": attributes["message"],
            "level": level,
            **({"logger": attributes["logger"]} if "logger" in attributes else {}),
        },
        attributes,
    )


def validate_span(attributes: SpanAttributes) -> dict[str, Any]:
    require_non_empty("span name", attributes.get("name"))
    require_non_empty("span traceId", attributes.get("traceId"))
    require_non_empty("span spanId", attributes.get("spanId"))
    require_allowed_value("span status", attributes.get("status"), SPAN_STATUSES)
    parent_span_id = attributes.get("parentSpanId")
    if parent_span_id is not None:
        require_non_empty("span parentSpanId", parent_span_id)
    duration_ms = attributes.get("durationMs")
    if duration_ms is not None and (
        isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)) or duration_ms < 0
    ):
        raise SdkError("validation_error", "span durationMs must be non-negative")
    return with_common_attributes(
        {
            "name": attributes["name"],
            "traceId": attributes["traceId"],
            "spanId": attributes["spanId"],
            "status": attributes["status"],
            **({"parentSpanId": parent_span_id} if parent_span_id is not None else {}),
            **({"durationMs": duration_ms} if duration_ms is not None else {}),
            **(
                {"events": span_events}
                if (
                    span_events := validate_span_events(
                        attributes.get("events"),
                        error_factory=SdkError,
                        require_non_empty=require_non_empty,
                        require_timestamp=require_timestamp,
                        compact_metadata=compact_metadata,
                    )
                )
                else {}
            ),
            **(
                {"links": span_links}
                if (
                    span_links := validate_span_links(
                        attributes.get("links"),
                        error_factory=SdkError,
                        require_trace_id=require_trace_id,
                        require_span_id=require_span_id,
                        compact_metadata=compact_metadata,
                    )
                )
                else {}
            ),
        },
        attributes,
    )


def validate_action(attributes: ActionAttributes) -> dict[str, Any]:
    require_non_empty("action name", attributes.get("name"))
    require_allowed_value("action status", attributes.get("status"), ACTION_STATUSES)
    return with_common_attributes(
        {
            "name": attributes["name"],
            "status": attributes["status"],
        },
        attributes,
    )


def validate_metric(attributes: MetricAttributes) -> dict[str, Any]:
    require_non_empty("metric name", attributes.get("name"))
    require_allowed_value("metric kind", attributes.get("kind"), METRIC_KINDS)
    require_finite_number("metric value", attributes.get("value"))
    require_non_empty("metric unit", attributes.get("unit"))
    kind = attributes["kind"]
    value = attributes["value"]
    require_allowed_value(
        f"metric temporality for {kind}",
        attributes.get("temporality"),
        METRIC_TEMPORALITIES_BY_KIND[kind],
    )
    if kind in NON_NEGATIVE_METRIC_KINDS and value < 0:
        raise SdkError("validation_error", f"metric {kind} value must be non-negative")
    description = (
        metric_description_or_none(attributes.get("description"))
        if "description" in attributes
        else None
    )
    return with_common_attributes(
        {
            "name": attributes["name"],
            **({"description": description} if description is not None else {}),
            "kind": kind,
            "value": value,
            "unit": attributes["unit"],
            "temporality": attributes["temporality"],
        },
        attributes,
    )


create_support_ticket_draft = build_create_support_ticket_draft(
    sdk_error_type=SdkError,
    require_allowed_value=require_allowed_value,
    require_non_empty=require_non_empty,
    require_trace_id=require_trace_id,
)

from logbrew_sdk._http_client import (  # noqa: E402, I001
    aiohttp_request_with_logbrew_span,
    async_httpx_request_with_logbrew_span,
    httpx_request_with_logbrew_span,
    requests_request_with_logbrew_span,
    urlopen_with_logbrew_span,
)
from logbrew_sdk._http_instrumentation import (  # noqa: E402
    LogBrewAiohttpClientSessionInstrumentation,
    LogBrewHttpxClientInstrumentation,
    LogBrewRequestsSessionInstrumentation,
    instrument_aiohttp_client_session_with_logbrew_spans,
    instrument_httpx_client_with_logbrew_spans,
    instrument_requests_session_with_logbrew_spans,
)
from logbrew_sdk._db_client import async_database_operation_with_logbrew_span, database_operation_with_logbrew_span  # noqa: E402
from logbrew_sdk._dbapi_client import LogBrewDbapiConnection, LogBrewDbapiCursor, connect_dbapi_connection_with_logbrew_spans, instrument_dbapi_connection_with_logbrew_spans  # noqa: E402, E501
from logbrew_sdk._sqlalchemy_client import LogBrewSqlAlchemyInstrumentation, instrument_sqlalchemy_engine_with_logbrew_spans  # noqa: E402, E501
from logbrew_sdk._cache_client import async_cache_operation_with_logbrew_span, cache_operation_with_logbrew_span  # noqa: E402
from logbrew_sdk._django_cache_client import LogBrewDjangoCacheInstrumentation, instrument_django_cache_with_logbrew_spans  # noqa: E402, E501
from logbrew_sdk._flask_cache_client import LogBrewFlaskCacheInstrumentation, instrument_flask_cache_with_logbrew_spans  # noqa: E402
from logbrew_sdk._pymemcache_client import LogBrewPymemcacheInstrumentation, instrument_pymemcache_client_with_logbrew_spans  # noqa: E402, E501
from logbrew_sdk._redis_client import LogBrewRedisInstrumentation, instrument_redis_client_with_logbrew_spans  # noqa: E402
from logbrew_sdk._celery_client import (  # noqa: E402
    celery_operation_with_logbrew_span,
    create_celery_trace_headers,
    logbrew_trace_context_from_celery_headers,
)
from logbrew_sdk._celery_instrumentation import (  # noqa: E402
    LogBrewCeleryInstrumentation,
    instrument_celery_app_with_logbrew_spans,
)
from logbrew_sdk._celery_worker_lifecycle import (  # noqa: E402
    LogBrewCeleryWorkerLifecycle,
    celery_worker_persistent_queue_directory,
    instrument_celery_worker_processes_with_logbrew,
)
from logbrew_sdk._queue_client import (  # noqa: E402
    async_queue_operation_with_logbrew_span,
    queue_operation_with_logbrew_span,
)
from logbrew_sdk._rq_client import (  # noqa: E402
    LogBrewRqQueueInstrumentation,
    LogBrewRqWorkerInstrumentation,
    instrument_rq_queue_with_logbrew_spans,
    instrument_rq_worker_processes_with_logbrew,
    rq_operation_with_logbrew_span,
)
from logbrew_sdk._arq_client import (  # noqa: E402
    LogBrewArqPoolInstrumentation,
    LogBrewArqWorkerInstrumentation,
    instrument_arq_pool_with_logbrew_spans,
    instrument_arq_worker_with_logbrew_spans,
)
from logbrew_sdk._dramatiq_client import (  # noqa: E402
    LogBrewDramatiqInstrumentation,
    instrument_dramatiq_broker_with_logbrew_spans,
)
from logbrew_sdk._process_errors import ProcessErrorCapture, install_process_error_capture  # noqa: E402
from logbrew_sdk._timeline import create_network_milestone_attributes, create_product_action_attributes  # noqa: E402
from logbrew_sdk._opentelemetry_processor import (  # noqa: E402
    LogBrewOpenTelemetrySpanExporter,
    LogBrewOpenTelemetrySpanProcessor,
    create_logbrew_open_telemetry_span_exporter,
    create_logbrew_open_telemetry_span_processor,
    span_attributes_from_open_telemetry_readable_span,
)


__all__ = [
    "ActionAttributes",
    "EnvironmentAttributes",
    "EventDrop",
    "EventDropReason",
    "HttpTransport",
    "IssueAttributes",
    "IssueBreadcrumb",
    "IssueBreadcrumbDataValue",
    "IssueBreadcrumbLevel",
    "IssueBreadcrumbLevelInput",
    "IssueDiagnosticEvidence",
    "IssueException",
    "IssueExceptionChain",
    "IssueExceptionChainEntry",
    "IssueExceptionMechanism",
    "IssueExceptionMessageState",
    "IssueExceptionRelationship",
    "IssueExceptionStackFramesState",
    "IssueImpactEvidence",
    "IssueLikelyFixArea",
    "IssueStackFrame",
    "LogAttributes",
    "LogBrewAiohttpClientSessionInstrumentation",
    "LogBrewArqPoolInstrumentation",
    "LogBrewArqWorkerInstrumentation",
    "LogBrewBreadcrumbHandler",
    "LogBrewCeleryInstrumentation",
    "LogBrewCeleryWorkerLifecycle",
    "LogBrewClient",
    "LogBrewDbapiConnection",
    "LogBrewDbapiCursor",
    "LogBrewDjangoCacheInstrumentation",
    "LogBrewDramatiqInstrumentation",
    "LogBrewFlaskCacheInstrumentation",
    "LogBrewHttpxClientInstrumentation",
    "LogBrewLoggingHandler",
    "LogBrewOpenTelemetrySpanExporter",
    "LogBrewOpenTelemetrySpanProcessor",
    "LogBrewPymemcacheInstrumentation",
    "LogBrewRedisInstrumentation",
    "LogBrewRequestsSessionInstrumentation",
    "LogBrewRqQueueInstrumentation",
    "LogBrewRqWorkerInstrumentation",
    "LogBrewSqlAlchemyInstrumentation",
    "LogBrewTraceContext",
    "Metadata",
    "MetadataValue",
    "MetricAttributes",
    "ProcessErrorCapture",
    "RecordingTransport",
    "ReleaseAttributes",
    "SdkError",
    "SpanAttributes",
    "SpanEventSummary",
    "SpanLinkSummary",
    "SupportDiagnosticsValue",
    "SupportTicketCategory",
    "SupportTicketDraft",
    "SupportTicketSource",
    "TelemetryApplication",
    "TelemetryContext",
    "TelemetryDeployment",
    "TelemetryDevice",
    "TelemetryNamedVersion",
    "TelemetryOperatingSystem",
    "TelemetryResource",
    "TelemetrySessionContext",
    "TelemetrySubjectContext",
    "TelemetryTraceContext",
    "TraceparentContext",
    "Transport",
    "TransportError",
    "TransportResponse",
    "add_logbrew_breadcrumb",
    "aiohttp_request_with_logbrew_span",
    "async_cache_operation_with_logbrew_span",
    "async_database_operation_with_logbrew_span",
    "async_httpx_request_with_logbrew_span",
    "async_queue_operation_with_logbrew_span",
    "cache_operation_with_logbrew_span",
    "celery_operation_with_logbrew_span",
    "celery_worker_persistent_queue_directory",
    "connect_dbapi_connection_with_logbrew_spans",
    "create_celery_trace_headers",
    "create_issue_attributes_from_exception",
    "create_logbrew_open_telemetry_span_exporter",
    "create_logbrew_open_telemetry_span_processor",
    "create_logbrew_trace_context",
    "create_network_milestone_attributes",
    "create_product_action_attributes",
    "create_support_ticket_draft",
    "create_traceparent",
    "create_traceparent_headers",
    "database_operation_with_logbrew_span",
    "get_active_logbrew_trace",
    "httpx_request_with_logbrew_span",
    "install_process_error_capture",
    "instrument_aiohttp_client_session_with_logbrew_spans",
    "instrument_arq_pool_with_logbrew_spans",
    "instrument_arq_worker_with_logbrew_spans",
    "instrument_celery_app_with_logbrew_spans",
    "instrument_celery_worker_processes_with_logbrew",
    "instrument_dbapi_connection_with_logbrew_spans",
    "instrument_django_cache_with_logbrew_spans",
    "instrument_dramatiq_broker_with_logbrew_spans",
    "instrument_flask_cache_with_logbrew_spans",
    "instrument_httpx_client_with_logbrew_spans",
    "instrument_pymemcache_client_with_logbrew_spans",
    "instrument_redis_client_with_logbrew_spans",
    "instrument_requests_session_with_logbrew_spans",
    "instrument_rq_queue_with_logbrew_spans",
    "instrument_rq_worker_processes_with_logbrew",
    "instrument_sqlalchemy_engine_with_logbrew_spans",
    "log_attributes_from_record",
    "logbrew_trace_context_from_celery_headers",
    "logbrew_trace_context_from_current_open_telemetry_span",
    "logbrew_trace_context_from_open_telemetry_span",
    "logbrew_trace_context_from_open_telemetry_span_context",
    "parse_traceparent",
    "queue_operation_with_logbrew_span",
    "requests_request_with_logbrew_span",
    "rq_operation_with_logbrew_span",
    "set_logbrew_user",
    "span_attributes_from_open_telemetry_readable_span",
    "span_attributes_from_trace_context",
    "span_attributes_from_traceparent",
    "trace_metadata",
    "urlopen_with_logbrew_span",
    "use_logbrew_trace",
]
