"""Client-owned scheduling and fixed health policy for automatic delivery."""

from __future__ import annotations

import math
import random
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from logbrew_sdk._errors import SdkError

DeliveryLifecycle = Literal["idle", "scheduled", "delivering", "paused", "shutting_down", "closed"]
DeliveryOutcome = Literal["none", "accepted", "no_work", "retry_scheduled", "paused", "failed"]
DeliveryPauseReason = Literal[
    "none",
    "authentication",
    "quota",
    "nonretryable",
    "storage",
    "ownership",
    "internal",
]

MAX_HEALTH_COUNTER = (1 << 63) - 1
MAX_RETRY_AFTER_MS = 300_000
MAX_RETRY_DELAY_SECONDS = 300.0
BASE_RETRY_DELAY_SECONDS = 1.0
MIN_DELIVERY_INTERVAL_SECONDS = 0.01
DEFAULT_DELIVERY_INTERVAL_SECONDS = 5.0
DEFAULT_DELIVERY_QUEUE_THRESHOLD = 50
MAX_DELIVERY_INTERVAL_SECONDS = 3600.0


class DeliveryResponse(Protocol):
    """Minimal response surface consumed by delivery retry policy."""

    @property
    def status_code(self) -> int: ...

    @property
    def retry_after_ms(self) -> int | None: ...


@dataclass(frozen=True, slots=True)
class AutomaticDeliveryOptions:
    """Validated automatic-delivery settings resolved from client creation."""

    enabled: bool
    interval_seconds: float
    queue_threshold: int


@dataclass(frozen=True, slots=True)
class DeliveryAttemptResult:
    """Successful bounded send result independent of the public response type."""

    status_code: int
    attempts: int


@dataclass(frozen=True, slots=True)
class DeliveryHealthSnapshot:
    """Content-free point-in-time state for one client's delivery lifecycle."""

    lifecycle: DeliveryLifecycle
    automatic_delivery: bool
    pending_events: int
    pending_event_bytes: int
    dropped_events: int
    delivery_in_flight: bool
    wake_coalesced: bool
    last_outcome: DeliveryOutcome
    pause_reason: DeliveryPauseReason
    consecutive_failures: int
    retry_delay_ms: int
    delivery_attempts: int
    accepted_events: int


@dataclass(frozen=True, slots=True)
class DeliveryPrefix:
    """One immutable request body tied to the exact queue prefix it owns."""

    through_sequence: int
    event_count: int
    body: str


class DeliverySendError(SdkError):
    """Internal delivery classification retaining the stable public SDK error surface."""

    retryable: bool
    retry_after_ms: int | None
    pause_reason: DeliveryPauseReason

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool,
        retry_after_ms: int | None = None,
        pause_reason: DeliveryPauseReason = "nonretryable",
    ) -> None:
        super().__init__(code=code, message=message)
        self.retryable = retryable
        self.retry_after_ms = _bounded_retry_after_ms(retry_after_ms)
        self.pause_reason = pause_reason


class AutomaticDeliveryController:
    """Own one lazy daemon and fixed scheduling/health state for a client."""

    def __init__(
        self,
        *,
        enabled: bool,
        interval_seconds: float,
        queue_threshold: int,
        deliver: Callable[[], tuple[int, int]],
    ) -> None:
        self._enabled = enabled
        self._interval_seconds = interval_seconds
        self._queue_threshold = queue_threshold
        self._deliver = deliver
        self._condition = threading.Condition()
        self._thread: threading.Thread | None = None
        self._stop_requested = False
        self._shutting_down = False
        self._closed = False
        self._has_pending = False
        self._due_at: float | None = None
        self._retry_due_at: float | None = None
        self._wake_requested = False
        self._delivery_in_flight = False
        self._wake_coalesced = False
        self._last_outcome: DeliveryOutcome = "none"
        self._pause_reason: DeliveryPauseReason = "none"
        self._consecutive_failures = 0
        self._delivery_attempts = 0
        self._accepted_events = 0

    @property
    def enabled(self) -> bool:
        return self._enabled

    def event_retained(self, pending_events: int) -> None:
        if not self._enabled:
            return
        with self._condition:
            if self._closed or self._shutting_down:
                return
            self._has_pending = pending_events > 0
            now = time.monotonic()
            self._ensure_worker_locked(now)
            if self._pause_reason != "none":
                self._condition.notify_all()
                return
            if self._delivery_in_flight:
                self._wake_coalesced = True
            if self._retry_due_at is None:
                if self._due_at is None:
                    self._due_at = now + self._interval_seconds
                if pending_events >= self._queue_threshold:
                    self._wake_requested = True
                    self._due_at = now
            self._condition.notify_all()

    def queue_changed(self, pending_events: int) -> None:
        with self._condition:
            self._has_pending = pending_events > 0
            if not self._has_pending:
                self._due_at = None
                self._retry_due_at = None
                self._wake_requested = False
                self._wake_coalesced = False
            self._condition.notify_all()

    def record_transport_attempt(self) -> None:
        with self._condition:
            self._delivery_attempts = _saturating_add(self._delivery_attempts, 1)

    def record_accepted_events(self, count: int) -> None:
        with self._condition:
            self._accepted_events = _saturating_add(self._accepted_events, count)

    def manual_delivery_started(self) -> None:
        with self._condition:
            self._delivery_in_flight = True

    def manual_delivery_finished(self) -> None:
        with self._condition:
            self._delivery_in_flight = False
            self._condition.notify_all()

    def manual_delivery_succeeded(self, *, accepted_events: int, pending_events: int, owned: bool) -> None:
        with self._condition:
            self._has_pending = pending_events > 0
            self._last_outcome = "accepted" if accepted_events else "no_work"
            if owned:
                self._pause_reason = "none"
                self._consecutive_failures = 0
                self._retry_due_at = None
                self._wake_requested = self._enabled and self._has_pending
                self._due_at = time.monotonic() if self._wake_requested else None
                if self._wake_requested:
                    self._ensure_worker_locked(time.monotonic())
            self._condition.notify_all()

    def manual_delivery_failed(self, error: BaseException, *, pending_events: int, owned: bool) -> None:
        if not owned:
            with self._condition:
                self._last_outcome = "failed"
            return
        with self._condition:
            self._has_pending = pending_events > 0
            self._apply_failure_locked(error, time.monotonic())
            self._condition.notify_all()

    def begin_shutdown(self) -> threading.Thread | None:
        with self._condition:
            self._shutting_down = True
            self._stop_requested = True
            self._wake_requested = False
            self._due_at = None
            self._retry_due_at = None
            self._condition.notify_all()
            return self._thread

    def abort_shutdown(self, pending_events: int) -> None:
        with self._condition:
            self._shutting_down = False
            self._stop_requested = False
            self._thread = None
            self._has_pending = pending_events > 0
            if self._enabled and self._has_pending and self._pause_reason == "none":
                now = time.monotonic()
                self._due_at = now + self._interval_seconds
                self._ensure_worker_locked(now)
            self._condition.notify_all()

    def mark_closed(self) -> None:
        with self._condition:
            self._closed = True
            self._shutting_down = False
            self._stop_requested = True
            self._has_pending = False
            self._delivery_in_flight = False
            self._wake_coalesced = False
            self._due_at = None
            self._retry_due_at = None
            self._condition.notify_all()

    def snapshot(
        self,
        *,
        pending_events: int,
        pending_event_bytes: int,
        dropped_events: int,
    ) -> DeliveryHealthSnapshot:
        with self._condition:
            now = time.monotonic()
            retry_delay_ms = 0
            if self._retry_due_at is not None:
                retry_delay_ms = min(MAX_RETRY_AFTER_MS, max(0, math.ceil((self._retry_due_at - now) * 1000)))
            return DeliveryHealthSnapshot(
                lifecycle=self._lifecycle_locked(),
                automatic_delivery=self._enabled,
                pending_events=pending_events,
                pending_event_bytes=pending_event_bytes,
                dropped_events=dropped_events,
                delivery_in_flight=self._delivery_in_flight,
                wake_coalesced=self._wake_coalesced,
                last_outcome=self._last_outcome,
                pause_reason=self._pause_reason,
                consecutive_failures=self._consecutive_failures,
                retry_delay_ms=retry_delay_ms,
                delivery_attempts=self._delivery_attempts,
                accepted_events=self._accepted_events,
            )

    def _ensure_worker_locked(self, now: float) -> None:
        if not self._enabled or self._closed or self._shutting_down or self._pause_reason != "none":
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_requested = False
        if self._due_at is None and self._has_pending:
            self._due_at = now + self._interval_seconds
        worker = threading.Thread(
            target=self._worker,
            name="logbrew-automatic-delivery",
            daemon=True,
        )
        try:
            worker.start()
        except Exception:
            self._thread = None
            self._last_outcome = "paused"
            self._pause_reason = "internal"
            self._consecutive_failures = _saturating_add(self._consecutive_failures, 1)
            self._due_at = None
            self._retry_due_at = None
            self._wake_requested = False
            self._wake_coalesced = False
        else:
            self._thread = worker

    def _worker(self) -> None:
        while True:
            with self._condition:
                while True:
                    if self._stop_requested:
                        return
                    if self._pause_reason != "none" or not self._has_pending:
                        self._condition.wait()
                        continue
                    due_at = self._retry_due_at if self._retry_due_at is not None else self._due_at
                    if self._wake_requested and self._retry_due_at is None:
                        due_at = time.monotonic()
                    if due_at is None:
                        self._due_at = time.monotonic() + self._interval_seconds
                        due_at = self._due_at
                    remaining = due_at - time.monotonic()
                    if remaining > 0:
                        self._condition.wait(timeout=remaining)
                        continue
                    self._wake_requested = False
                    self._wake_coalesced = False
                    self._delivery_in_flight = True
                    break

            try:
                accepted_events, pending_events = self._deliver()
            except Exception as error:
                with self._condition:
                    self._delivery_in_flight = False
                    self._apply_failure_locked(error, time.monotonic())
                    self._condition.notify_all()
            else:
                with self._condition:
                    now = time.monotonic()
                    self._delivery_in_flight = False
                    self._has_pending = pending_events > 0
                    self._last_outcome = "accepted" if accepted_events else "no_work"
                    self._pause_reason = "none"
                    self._consecutive_failures = 0
                    self._retry_due_at = None
                    if self._has_pending:
                        self._due_at = now if self._wake_coalesced else now + self._interval_seconds
                        self._wake_requested = self._wake_coalesced
                    else:
                        self._due_at = None
                        self._wake_requested = False
                        self._wake_coalesced = False
                    self._condition.notify_all()

    def _apply_failure_locked(self, error: BaseException, now: float) -> None:
        self._consecutive_failures = _saturating_add(self._consecutive_failures, 1)
        if isinstance(error, DeliverySendError) and error.retryable:
            delay = _retry_delay_seconds(self._consecutive_failures, error.retry_after_ms)
            self._retry_due_at = now + delay
            self._due_at = self._retry_due_at
            self._last_outcome = "retry_scheduled"
            self._pause_reason = "none"
            return

        self._retry_due_at = None
        self._due_at = None
        self._wake_requested = False
        self._wake_coalesced = False
        self._last_outcome = "paused"
        self._pause_reason = _pause_reason(error)

    def _lifecycle_locked(self) -> DeliveryLifecycle:
        if self._closed:
            return "closed"
        if self._shutting_down:
            return "shutting_down"
        if self._pause_reason != "none":
            return "paused"
        if self._delivery_in_flight:
            return "delivering"
        if self._enabled and self._has_pending:
            return "scheduled"
        return "idle"


def resolve_automatic_delivery_options(
    *,
    has_owned_transport: bool,
    automatic_delivery: object,
    interval_seconds: object,
    queue_threshold: object,
    max_queue_size: int,
) -> AutomaticDeliveryOptions:
    if (
        isinstance(interval_seconds, bool)
        or not isinstance(interval_seconds, (int, float))
        or not math.isfinite(interval_seconds)
        or interval_seconds < MIN_DELIVERY_INTERVAL_SECONDS
        or interval_seconds > MAX_DELIVERY_INTERVAL_SECONDS
    ):
        raise SdkError(
            "configuration_error",
            "delivery_interval_seconds must be from 0.01 through 3600 seconds",
        )
    threshold = min(DEFAULT_DELIVERY_QUEUE_THRESHOLD, max_queue_size)
    if queue_threshold is not None:
        if isinstance(queue_threshold, bool) or not isinstance(queue_threshold, int) or queue_threshold <= 0:
            raise SdkError("configuration_error", "delivery_queue_threshold must be a positive integer")
        if queue_threshold > max_queue_size:
            raise SdkError("configuration_error", "delivery_queue_threshold cannot exceed max_queue_size")
        threshold = queue_threshold
    enabled = has_owned_transport if automatic_delivery is None else automatic_delivery
    if not isinstance(enabled, bool):
        raise SdkError("configuration_error", "automatic_delivery must be a boolean")
    if enabled and not has_owned_transport:
        raise SdkError("configuration_error", "automatic delivery requires an owned transport")
    return AutomaticDeliveryOptions(
        enabled=enabled,
        interval_seconds=float(interval_seconds),
        queue_threshold=threshold,
    )


def send_with_retry_policy(
    send_once: Callable[[], DeliveryResponse],
    *,
    max_retries: int,
) -> DeliveryAttemptResult:
    max_attempts = max_retries + 1
    attempts = 0
    while attempts < max_attempts:
        attempts += 1
        try:
            response = send_once()
        except DeliverySendError as error:
            if error.retryable and attempts < max_attempts:
                continue
            raise
        if response.status_code == 401:
            raise DeliverySendError(
                "unauthenticated",
                "transport rejected the API key",
                retryable=False,
                pause_reason="authentication",
            )
        if response.status_code == 429:
            raise DeliverySendError(
                "rate_limited",
                "transport rejected delivery because quota is unavailable",
                retryable=False,
                pause_reason="quota",
            )
        if 200 <= response.status_code < 300:
            return DeliveryAttemptResult(status_code=response.status_code, attempts=attempts)
        if response.status_code == 408 or response.status_code >= 500:
            if attempts < max_attempts:
                continue
            raise DeliverySendError(
                "transport_error",
                f"unexpected transport status {response.status_code}",
                retryable=True,
                retry_after_ms=response.retry_after_ms,
            )
        raise DeliverySendError(
            "transport_error",
            f"unexpected transport status {response.status_code}",
            retryable=False,
        )
    raise DeliverySendError("transport_error", "exhausted retries", retryable=True)


def parse_retry_after_ms(headers: Any) -> int | None:
    if not isinstance(headers, Mapping):
        get_value = getattr(headers, "get", None)
        if not callable(get_value):
            return None
    else:
        get_value = headers.get
    try:
        raw_value = get_value("retry-after-ms")
    except Exception:
        return None
    if not isinstance(raw_value, str) or not raw_value or len(raw_value) > 6:
        return None
    if not raw_value.isascii() or not all("0" <= character <= "9" for character in raw_value):
        return None
    value = int(raw_value)
    return value if value <= MAX_RETRY_AFTER_MS else None


def _retry_delay_seconds(consecutive_failures: int, retry_after_ms: int | None) -> float:
    bounded_hint = _bounded_retry_after_ms(retry_after_ms)
    if bounded_hint is not None:
        return bounded_hint / 1000
    exponent = min(max(consecutive_failures - 1, 0), 30)
    ceiling = min(MAX_RETRY_DELAY_SECONDS, BASE_RETRY_DELAY_SECONDS * (2**exponent))
    return random.uniform(ceiling / 2, ceiling)


def _bounded_retry_after_ms(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > MAX_RETRY_AFTER_MS:
        return None
    return value


def _pause_reason(error: BaseException) -> DeliveryPauseReason:
    if isinstance(error, DeliverySendError):
        return error.pause_reason
    if isinstance(error, SdkError):
        if error.code == "process_ownership_error":
            return "ownership"
        if error.code.startswith("persistent_") or error.code.startswith("persistence_"):
            return "storage"
    return "internal"


def _saturating_add(value: int, increment: int) -> int:
    return min(MAX_HEALTH_COUNTER, value + max(0, increment))
