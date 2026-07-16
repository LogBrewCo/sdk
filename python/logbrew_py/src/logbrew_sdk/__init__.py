"""Public Python client for building, validating, previewing, and flushing LogBrew event batches."""

from __future__ import annotations

import json
import logging
import math
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from threading import Lock, RLock, get_ident
from typing import Annotated, Any, Literal, Protocol, TypeAlias, TypedDict
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from logbrew_sdk._delivery_lifecycle import DeliveryHealthSnapshot, _DeliveryFailure, _DeliveryLifecycle
from logbrew_sdk._errors import SdkError
from logbrew_sdk._event_queue import EventQueue, MemoryEventQueue, QueuedEvent
from logbrew_sdk._persistent_event_queue import PersistentEventQueue
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
from logbrew_sdk._trace_context import (
    LogBrewTraceContext,
    _create_logbrew_context_from_current_open_telemetry_span,
    _create_logbrew_context_from_open_telemetry_span,
    _create_logbrew_context_from_open_telemetry_span_context,
    get_active_logbrew_trace,
    trace_metadata,
    use_logbrew_trace,
)

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


class EnvironmentAttributes(TypedDict, total=False):
    """Public environment event attributes."""
    name: str
    region: str
    metadata: Metadata


class IssueAttributes(TypedDict, total=False):
    """Public issue event attributes."""
    title: str
    level: str
    message: str
    metadata: Metadata


class LogAttributes(TypedDict, total=False):
    """Public log event attributes."""
    message: str
    level: str
    logger: str
    metadata: Metadata


class ActionAttributes(TypedDict, total=False):
    """Public action event attributes."""
    name: str
    status: str
    metadata: Metadata


class MetricAttributes(TypedDict, total=False):
    """Public metric event attributes."""
    name: str
    kind: Literal["counter", "gauge", "histogram"]
    value: float
    unit: str
    temporality: Literal["delta", "cumulative", "instant"]
    metadata: Metadata


class ScriptedTransportResponse(TypedDict):
    status_code: int


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
DEFAULT_HTTP_ENDPOINT = "https://api.logbrew.co/v1/events"
DEFAULT_MAX_QUEUE_SIZE = 10_000
DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_BATCH_EVENTS = 100
DEFAULT_MAX_BATCH_BYTES = 256 * 1024
DEFAULT_DELIVERY_QUEUE_THRESHOLD = 50
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
    retry_after_ms: Annotated[int | None, "Bounded transport retry delay hint in milliseconds."] = field(
        default=None,
        compare=False,
    )


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

        return TransportResponse(status_code=int(next_response["status_code"]), attempts=1)


class HttpTransport:
    """Dependency-free HTTP transport for sending queued batches to LogBrew."""

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
        self.endpoint = endpoint
        self.headers = validate_headers(headers)
        self.timeout = float(timeout)
        self.open_url = open_url or urlopen

    def send(self, api_key: str, body: str) -> TransportResponse:
        """POST one serialized event batch and return the HTTP status."""
        require_non_empty("api_key", api_key)
        request = Request(
            self.endpoint,
            data=body.encode("utf-8"),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {api_key}",
                **self.headers,
            },
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
                    retry_after_ms=_parse_retry_after_ms(getattr(response, "headers", None)),
                )
            finally:
                close_response = getattr(response, "close", None)
                if callable(close_response):
                    close_response()
        except HTTPError as error:
            return TransportResponse(
                status_code=int(error.code),
                attempts=1,
                retry_after_ms=_parse_retry_after_ms(error.headers),
            )
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
        max_retries: int = 2,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
        max_batch_events: int = DEFAULT_MAX_BATCH_EVENTS,
        max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
        transport: Transport | None = None,
        automatic_delivery: bool | None = None,
        delivery_interval_seconds: float = 5.0,
        delivery_queue_threshold: int | None = None,
        persistent_queue_directory: str | os.PathLike[str] | None = None,
        persistent_queue_encryption_key: bytes | bytearray | memoryview | None = None,
    ) -> LogBrewClient:
        """Create a client from public SDK identity, retry, and API key settings."""
        require_non_empty("api_key", api_key)
        require_non_empty("sdk_name", sdk_name)
        require_non_empty("sdk_version", sdk_version)
        return cls(
            api_key=api_key,
            sdk={"name": sdk_name, "language": "python", "version": sdk_version},
            max_retries=max_retries,
            max_queue_size=max_queue_size,
            max_queue_bytes=max_queue_bytes,
            max_batch_events=max_batch_events,
            max_batch_bytes=max_batch_bytes,
            transport=transport,
            automatic_delivery=automatic_delivery,
            delivery_interval_seconds=delivery_interval_seconds,
            delivery_queue_threshold=delivery_queue_threshold,
            persistent_queue_directory=persistent_queue_directory,
            persistent_queue_encryption_key=persistent_queue_encryption_key,
        )

    def __init__(
        self,
        *,
        api_key: str,
        sdk: dict[str, str],
        max_retries: int,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
        max_batch_events: int = DEFAULT_MAX_BATCH_EVENTS,
        max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
        transport: Transport | None = None,
        automatic_delivery: bool | None = None,
        delivery_interval_seconds: float = 5.0,
        delivery_queue_threshold: int | None = None,
        persistent_queue_directory: str | os.PathLike[str] | None = None,
        persistent_queue_encryption_key: bytes | bytearray | memoryview | None = None,
    ) -> None:
        _require_positive_integer("max_queue_size", max_queue_size)
        _require_positive_integer("max_queue_bytes", max_queue_bytes)
        _require_positive_integer("max_batch_events", max_batch_events)
        _require_positive_integer("max_batch_bytes", max_batch_bytes)
        if (
            isinstance(delivery_interval_seconds, bool)
            or not isinstance(delivery_interval_seconds, (int, float))
            or not math.isfinite(delivery_interval_seconds)
            or not 0.01 <= delivery_interval_seconds <= 3600
        ):
            raise SdkError(
                "configuration_error",
                "delivery_interval_seconds must be between 0.01 and 3600 seconds",
            )
        if delivery_queue_threshold is None:
            effective_delivery_queue_threshold = min(DEFAULT_DELIVERY_QUEUE_THRESHOLD, max_queue_size)
        else:
            _require_positive_integer("delivery_queue_threshold", delivery_queue_threshold)
            effective_delivery_queue_threshold = delivery_queue_threshold
        if effective_delivery_queue_threshold > max_queue_size:
            raise SdkError(
                "configuration_error",
                "delivery_queue_threshold cannot exceed max_queue_size",
            )
        if automatic_delivery is not None and not isinstance(automatic_delivery, bool):
            raise SdkError("configuration_error", "automatic_delivery must be a boolean")
        automatic_delivery_enabled = transport is not None if automatic_delivery is None else automatic_delivery
        if automatic_delivery_enabled and transport is None:
            raise SdkError("configuration_error", "automatic_delivery requires an owned transport")
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
        self.max_retries = max_retries
        self.max_queue_size = max_queue_size
        self.max_queue_bytes = max_queue_bytes
        self.max_batch_events = max_batch_events
        self.max_batch_bytes = max_batch_bytes
        self._dropped_events = 0
        self._owner_pid = os.getpid()
        self._state_lock = RLock()
        self._flush_lock = Lock()
        self._flush_owner_thread_id: int | None = None
        self._failed_batch: tuple[int, str, int] | None = None
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
        self._delivery_lifecycle = _DeliveryLifecycle(
            automatic_delivery=automatic_delivery_enabled,
            interval_seconds=float(delivery_interval_seconds),
            queue_threshold=effective_delivery_queue_threshold,
            owner_pid=self._owner_pid,
            deliver=self._flush_owned_automatically,
            pending_count=self.pending_events,
        )
        self._delivery_lifecycle.event_accepted(self._queue.count)

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

    def delivery_health(self) -> DeliveryHealthSnapshot:
        """Return fixed content-free delivery state for safe diagnostics."""
        self._assert_owner()
        with self._state_lock:
            return self._delivery_lifecycle.health(
                queue_events=0 if self.closed else self._queue.count,
                queue_bytes=0 if self.closed else self._queue.byte_count,
                dropped_events=self._dropped_events,
            )

    def purge_pending_events(self) -> int:
        """Explicitly and durably remove all locally queued events."""
        self._assert_owner()
        with self._state_lock:
            if self.closed or self._closing:
                raise SdkError("shutdown_error", "client is already shut down")
            if self._flush_owner_thread_id is not None:
                raise SdkError("queue_busy_error", "pending events cannot be purged during delivery")
            purged = self._queue.purge()
            self._failed_batch = None
        self._delivery_lifecycle.record_purge()
        return purged

    def recover_pending_events(self) -> int:
        """Revalidate local queue durability and return the pending event count."""

        self._assert_owner()
        with self._state_lock:
            if self.closed or self._closing:
                raise SdkError("shutdown_error", "client is already shut down")
            if self._flush_owner_thread_id is not None:
                raise SdkError("queue_busy_error", "pending events cannot be recovered during delivery")
            return self._queue.recover()

    def preview_json(self) -> str:
        """Return the queued event batch as stable, pretty-printed JSON."""
        return json.dumps({"sdk": self.sdk, "events": self.events}, indent=2, ensure_ascii=False)

    def release(self, event_id: str, timestamp: str, attributes: ReleaseAttributes) -> None:
        self._push_event("release", event_id, timestamp, validate_release(attributes))

    def environment(self, event_id: str, timestamp: str, attributes: EnvironmentAttributes) -> None:
        self._push_event("environment", event_id, timestamp, validate_environment(attributes))

    def issue(self, event_id: str, timestamp: str, attributes: IssueAttributes) -> None:
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
        resolved_transport = self._resolve_transport(transport)
        return self._flush_with_resolved_transport(
            resolved_transport,
            record_lifecycle_outcome=True,
        )

    def shutdown(self, transport: Transport | None = None) -> TransportResponse:
        """Flush queued events, then mark the client closed so later writes fail."""
        self._assert_owner()
        resolved_transport = self._resolve_transport(transport)
        thread_id = get_ident()
        with self._state_lock:
            self._require_open_for_delivery(thread_id)
            self._closing = True

        self._delivery_lifecycle.stop_for_shutdown()
        with self._state_lock:
            shutdown_snapshot_end = self._queue.last_sequence()

        try:
            with self._flush_lock:
                with self._state_lock:
                    self._flush_owner_thread_id = thread_id
                try:
                    response = self._flush_internal(
                        resolved_transport,
                        through_sequence=shutdown_snapshot_end,
                    )
                    if self._tracks_lifecycle_outcome(resolved_transport):
                        self._delivery_lifecycle.record_manual_success(response)
                        self._delivery_lifecycle.event_accepted(self.pending_events())
                    self._queue.close()
                finally:
                    with self._state_lock:
                        self._flush_owner_thread_id = None
        except Exception as error:
            with self._state_lock:
                self._closing = False
                pending = self._queue.count
            failure = self._shutdown_failure_for_lifecycle(error, resolved_transport)
            self._delivery_lifecycle.reopen_after_failed_shutdown(pending, failure)
            raise

        with self._state_lock:
            self._closing = False
            self.closed = True
        self._delivery_lifecycle.close()
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

        accepted_queue_count: int | None = None
        with self._state_lock:
            if self.closed or self._closing:
                raise SdkError("shutdown_error", "client is already shut down")
            if (
                self._queue.count >= self.max_queue_size
                or self._queue.byte_count + event_bytes > self.max_queue_bytes
                or request_bytes > self.max_batch_bytes
            ):
                self._dropped_events += 1
                return
            self._queue.append(
                record_id=uuid4().hex,
                event_json=event_json,
                byte_count=event_bytes,
            )
            accepted_queue_count = self._queue.count
        assert accepted_queue_count is not None
        self._delivery_lifecycle.event_accepted(accepted_queue_count)

    def _flush_owned_automatically(self) -> TransportResponse:
        transport = self._owned_transport
        if transport is None:
            raise SdkError("configuration_error", "automatic delivery requires an owned transport")
        return self._flush_with_resolved_transport(
            transport,
            record_lifecycle_outcome=False,
        )

    def _flush_with_resolved_transport(
        self,
        transport: Transport,
        *,
        record_lifecycle_outcome: bool,
    ) -> TransportResponse:
        self._assert_owner()
        thread_id = get_ident()
        with self._state_lock:
            self._require_open_for_delivery(thread_id)

        with self._flush_lock:
            with self._state_lock:
                self._require_open_for_delivery(thread_id)
                self._flush_owner_thread_id = thread_id
            try:
                response = self._flush_internal(transport)
            except _DeliveryFailure as error:
                if record_lifecycle_outcome and self._tracks_lifecycle_outcome(transport):
                    self._delivery_lifecycle.record_manual_failure(error)
                raise
            else:
                if record_lifecycle_outcome and self._tracks_lifecycle_outcome(transport):
                    self._delivery_lifecycle.record_manual_success(response)
                    self._delivery_lifecycle.event_accepted(self.pending_events())
                return response
            finally:
                with self._state_lock:
                    self._flush_owner_thread_id = None

    def _resolve_transport(self, transport: Transport | None) -> Transport:
        resolved = transport if transport is not None else self._owned_transport
        if resolved is None:
            raise SdkError("configuration_error", "transport is required when the client does not own one")
        return resolved

    def _tracks_lifecycle_outcome(self, transport: Transport) -> bool:
        return self._owned_transport is None or transport is self._owned_transport

    def _shutdown_failure_for_lifecycle(
        self,
        error: Exception,
        transport: Transport,
    ) -> _DeliveryFailure:
        if isinstance(error, _DeliveryFailure) and self._tracks_lifecycle_outcome(transport):
            return error
        if isinstance(error, _DeliveryFailure) and self._owned_transport is not None:
            return _DeliveryFailure(
                code="transport_error",
                message="external shutdown transport failed",
                retryable=True,
                attempts=error.attempts,
                batches=error.batches,
                accepted_events=error.accepted_events,
            )
        return _DeliveryFailure(
            code="delivery_state_error",
            message="shutdown delivery state requires explicit recovery",
            retryable=False,
            pause_reason="non_retryable",
        )

    def _flush_internal(
        self,
        transport: Transport,
        *,
        through_sequence: int | None = None,
    ) -> TransportResponse:
        self._assert_owner()
        with self._state_lock:
            failed_batch = self._failed_batch
            snapshot_end = (
                through_sequence
                if through_sequence is not None
                else failed_batch[0]
                if failed_batch is not None
                else self._queue.last_sequence()
            )
        if snapshot_end is None:
            return TransportResponse(status_code=204, attempts=0, batches=0, accepted_events=0)

        total_attempts = 0
        accepted_batches = 0
        accepted_events = 0
        final_status = 204
        while True:
            with self._state_lock:
                records = self._queue.snapshot(through_sequence=snapshot_end)
                failed_batch = self._failed_batch
            if not records:
                return TransportResponse(
                    status_code=final_status,
                    attempts=total_attempts,
                    batches=accepted_batches,
                    accepted_events=accepted_events,
                )

            if failed_batch is None:
                batch, body = self._build_batch(records)
            else:
                failed_sequence, body, failed_count = failed_batch
                batch = records[:failed_count]
                if len(batch) != failed_count or batch[-1].sequence != failed_sequence:
                    raise SdkError("queue_state_error", "failed event prefix changed before retry")
            try:
                response = self._send_body(transport, body)
            except _DeliveryFailure as error:
                with self._state_lock:
                    if self._failed_batch is None:
                        self._failed_batch = (batch[-1].sequence, body, len(batch))
                error.attempts += total_attempts
                error.batches += accepted_batches
                error.accepted_events += accepted_events
                raise
            except Exception:
                with self._state_lock:
                    if self._failed_batch is None:
                        self._failed_batch = (batch[-1].sequence, body, len(batch))
                raise
            total_attempts += response.attempts
            final_status = response.status_code
            with self._state_lock:
                acknowledged = self._queue.acknowledge(batch[-1].sequence)
                if self._failed_batch is not None and self._failed_batch[0] == batch[-1].sequence:
                    self._failed_batch = None
            if acknowledged != len(batch):
                raise SdkError("queue_state_error", "accepted event prefix changed during delivery")
            accepted_batches += 1
            accepted_events += acknowledged

    def _build_batch(self, records: tuple[QueuedEvent, ...]) -> tuple[tuple[QueuedEvent, ...], str]:
        prefix = f'{{"sdk":{self._sdk_json},"events":['
        suffix = "]}"
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
        if not batch:
            raise SdkError("queue_state_error", "queued event cannot fit the configured request limit")
        return tuple(batch), f"{prefix}{','.join(record.json for record in batch)}{suffix}"

    def _send_body(self, transport: Transport, body: str) -> TransportResponse:
        max_attempts = self.max_retries + 1
        attempts = 0
        while attempts < max_attempts:
            attempts += 1
            try:
                response = transport.send(self.api_key, body)
                if response.status_code == 401:
                    raise _DeliveryFailure(
                        code="unauthenticated",
                        message="transport rejected the API key",
                        retryable=False,
                        pause_reason="authentication",
                        attempts=attempts,
                    )
                if 200 <= response.status_code < 300:
                    return TransportResponse(
                        status_code=response.status_code,
                        attempts=attempts,
                        batches=1,
                        accepted_events=0,
                    )
                retryable_status = response.status_code == 408 or response.status_code >= 500
                if retryable_status and attempts < max_attempts:
                    continue
                raise _DeliveryFailure(
                    code="transport_error",
                    message=f"unexpected transport status {response.status_code}",
                    retryable=retryable_status,
                    pause_reason=(
                        "rate_limit"
                        if response.status_code == 429
                        else "none"
                        if retryable_status
                        else "non_retryable"
                    ),
                    retry_after_ms=response.retry_after_ms,
                    attempts=attempts,
                )
            except _DeliveryFailure:
                raise
            except SdkError:
                raise
            except TransportError as error:
                if error.retryable and attempts < max_attempts:
                    continue
                raise _DeliveryFailure(
                    code=error.code,
                    message=error.message,
                    retryable=error.retryable,
                    pause_reason="none" if error.retryable else "non_retryable",
                    attempts=attempts,
                ) from error

        raise SdkError("transport_error", "exhausted retries")

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


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _parse_retry_after_ms(headers: object) -> int | None:
    if headers is None:
        return None
    get_header = getattr(headers, "get", None)
    if not callable(get_header):
        return None
    value = get_header("Retry-After")
    if value is None or isinstance(value, bool):
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return min(3_600_000, round(seconds * 1000))


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
        raise_flush_errors: bool = False,
        level: int = logging.NOTSET,
    ) -> None:
        super().__init__(level=level)
        self.client = client
        self.transport = transport
        self.flush_on_emit = flush_on_emit
        self.include_exception_text = include_exception_text
        self.metadata = dict(metadata or {})
        self.raise_flush_errors = raise_flush_errors

    def emit(self, record: logging.LogRecord) -> None:
        """Queue one LogBrew log event from a standard-library log record."""
        try:
            event_id = default_log_record_event_id(record)
            self.client.log(
                event_id,
                timestamp_from_log_record(record),
                log_attributes_from_record(
                    record,
                    include_exception_text=self.include_exception_text,
                    metadata=self.metadata,
                ),
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
    active_trace = get_active_logbrew_trace()
    if active_trace is not None:
        metadata.update(active_trace.metadata())
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
    return datetime.fromtimestamp(record.created, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def default_log_record_event_id(_record: logging.LogRecord) -> str:
    """Return a unique event id for a standard-library log record."""
    return f"evt_log_{uuid4().hex}"


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


def validate_release(attributes: ReleaseAttributes) -> dict[str, Any]:
    require_non_empty("release version", attributes.get("version"))
    commit = attributes.get("commit")
    if commit is not None:
        require_non_empty("release commit", commit)
    return with_metadata(
        {
            "version": attributes["version"],
            **({"commit": commit} if commit is not None else {}),
            **({"notes": attributes["notes"]} if "notes" in attributes else {}),
        },
        attributes.get("metadata"),
    )


def validate_environment(attributes: EnvironmentAttributes) -> dict[str, Any]:
    require_non_empty("environment name", attributes.get("name"))
    return with_metadata(
        {
            "name": attributes["name"],
            **({"region": attributes["region"]} if "region" in attributes else {}),
        },
        attributes.get("metadata"),
    )


def validate_issue(attributes: IssueAttributes) -> dict[str, Any]:
    require_non_empty("issue title", attributes.get("title"))
    level = normalize_severity("issue level", attributes.get("level"))
    return with_metadata(
        {
            "title": attributes["title"],
            "level": level,
            **({"message": attributes["message"]} if "message" in attributes else {}),
        },
        attributes.get("metadata"),
    )


def validate_log(attributes: LogAttributes) -> dict[str, Any]:
    require_non_empty("log message", attributes.get("message"))
    level = normalize_severity("log level", attributes.get("level"))
    return with_metadata(
        {
            "message": attributes["message"],
            "level": level,
            **({"logger": attributes["logger"]} if "logger" in attributes else {}),
        },
        attributes.get("metadata"),
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
    return with_metadata(
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
        attributes.get("metadata"),
    )


def validate_action(attributes: ActionAttributes) -> dict[str, Any]:
    require_non_empty("action name", attributes.get("name"))
    require_allowed_value("action status", attributes.get("status"), ACTION_STATUSES)
    return with_metadata(
        {
            "name": attributes["name"],
            "status": attributes["status"],
        },
        attributes.get("metadata"),
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
    return with_metadata(
        {
            "name": attributes["name"],
            "kind": kind,
            "value": value,
            "unit": attributes["unit"],
            "temporality": attributes["temporality"],
        },
        attributes.get("metadata"),
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
from logbrew_sdk._rq_client import rq_operation_with_logbrew_span  # noqa: E402
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
    "DeliveryHealthSnapshot",
    "EnvironmentAttributes",
    "HttpTransport",
    "IssueAttributes",
    "LogAttributes",
    "LogBrewAiohttpClientSessionInstrumentation",
    "LogBrewCeleryInstrumentation",
    "LogBrewCeleryWorkerLifecycle",
    "LogBrewClient",
    "LogBrewDbapiConnection",
    "LogBrewDbapiCursor",
    "LogBrewDjangoCacheInstrumentation",
    "LogBrewFlaskCacheInstrumentation",
    "LogBrewHttpxClientInstrumentation",
    "LogBrewLoggingHandler",
    "LogBrewOpenTelemetrySpanExporter",
    "LogBrewOpenTelemetrySpanProcessor",
    "LogBrewPymemcacheInstrumentation",
    "LogBrewRedisInstrumentation",
    "LogBrewRequestsSessionInstrumentation",
    "LogBrewSqlAlchemyInstrumentation",
    "LogBrewTraceContext",
    "Metadata",
    "MetadataValue",
    "MetricAttributes",
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
    "TraceparentContext",
    "Transport",
    "TransportError",
    "TransportResponse",
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
    "instrument_aiohttp_client_session_with_logbrew_spans",
    "instrument_celery_app_with_logbrew_spans",
    "instrument_celery_worker_processes_with_logbrew",
    "instrument_dbapi_connection_with_logbrew_spans",
    "instrument_django_cache_with_logbrew_spans",
    "instrument_flask_cache_with_logbrew_spans",
    "instrument_httpx_client_with_logbrew_spans",
    "instrument_pymemcache_client_with_logbrew_spans",
    "instrument_redis_client_with_logbrew_spans",
    "instrument_requests_session_with_logbrew_spans",
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
    "span_attributes_from_open_telemetry_readable_span",
    "span_attributes_from_trace_context",
    "span_attributes_from_traceparent",
    "trace_metadata",
    "urlopen_with_logbrew_span",
    "use_logbrew_trace",
]
