"""Client-owned automatic delivery scheduling and content-free health state."""

from __future__ import annotations

import os
import random
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol, TypedDict

from logbrew_sdk._errors import SdkError

_PauseReason = Literal["none", "authentication", "rate_limit", "non_retryable"]


@dataclass(slots=True)
class _DeliveryFailure(SdkError):
    """Private scheduling details carried by the stable public SDK error."""

    retryable: bool
    pause_reason: _PauseReason = "none"
    retry_after_ms: int | None = None
    attempts: int = 0
    batches: int = 0
    accepted_events: int = 0


class _DeliveryResult(Protocol):
    attempts: int
    batches: int
    accepted_events: int


class DeliveryHealthSnapshot(TypedDict):
    """Fixed content-free delivery state safe for application diagnostics."""

    automatic_delivery: bool
    lifecycle: Literal["active", "shutting_down", "closed"]
    queue_events: int
    queue_bytes: int
    dropped_events: int
    scheduled: bool
    in_flight: bool
    coalesced: bool
    last_outcome: Literal["idle", "empty", "accepted", "failed"]
    paused_reason: Literal["none", "authentication", "rate_limit", "non_retryable"]
    consecutive_failures: int
    retry_delay_ms: int
    flushes: int
    failures: int
    attempts: int
    batches: int
    accepted_events: int


_MAX_COUNTER = (1 << 63) - 1


def _saturating_add(current: int, increment: int) -> int:
    return min(_MAX_COUNTER, current + max(0, increment))


class _DeliveryLifecycle:
    """Own one lazy scheduler while leaving queue and transport work to the client."""

    def __init__(
        self,
        *,
        automatic_delivery: bool,
        interval_seconds: float,
        queue_threshold: int,
        owner_pid: int,
        deliver: Callable[[], _DeliveryResult],
        pending_count: Callable[[], int],
    ) -> None:
        self._automatic_delivery = automatic_delivery
        self._interval_seconds = interval_seconds
        self._queue_threshold = queue_threshold
        self._owner_pid = owner_pid
        self._deliver = deliver
        self._pending_count = pending_count
        self._condition = threading.Condition()
        self._thread: threading.Thread | None = None
        self._stop = False
        self._wake = False
        self._deadline: float | None = None
        self._scheduled = False
        self._in_flight = False
        self._coalesced = False
        self._lifecycle: Literal["active", "shutting_down", "closed"] = "active"
        self._last_outcome: Literal["idle", "empty", "accepted", "failed"] = "idle"
        self._paused_reason: _PauseReason = "none"
        self._consecutive_failures = 0
        self._retry_delay_ms = 0
        self._flushes = 0
        self._failures = 0
        self._attempts = 0
        self._batches = 0
        self._accepted_events = 0

    def event_accepted(self, queue_count: int) -> None:
        if not self._automatic_delivery or queue_count <= 0:
            return
        with self._condition:
            if self._lifecycle != "active" or self._stop or os.getpid() != self._owner_pid:
                return
            if self._paused_reason != "none":
                self._scheduled = False
                return
            self._ensure_thread_locked()
            if self._in_flight or (self._retry_delay_ms > 0 and self._deadline is not None):
                self._coalesced = True
            elif queue_count >= self._queue_threshold:
                self._wake = True
            elif self._deadline is None:
                self._deadline = time.monotonic() + self._interval_seconds
            self._scheduled = True
            self._condition.notify_all()

    def health(
        self,
        *,
        queue_events: int,
        queue_bytes: int,
        dropped_events: int,
    ) -> DeliveryHealthSnapshot:
        with self._condition:
            return {
                "automatic_delivery": self._automatic_delivery,
                "lifecycle": self._lifecycle,
                "queue_events": queue_events,
                "queue_bytes": queue_bytes,
                "dropped_events": dropped_events,
                "scheduled": self._scheduled,
                "in_flight": self._in_flight,
                "coalesced": self._coalesced,
                "last_outcome": self._last_outcome,
                "paused_reason": self._paused_reason,
                "consecutive_failures": self._consecutive_failures,
                "retry_delay_ms": self._retry_delay_ms,
                "flushes": self._flushes,
                "failures": self._failures,
                "attempts": self._attempts,
                "batches": self._batches,
                "accepted_events": self._accepted_events,
            }

    def record_manual_success(self, response: _DeliveryResult) -> None:
        with self._condition:
            self._record_success_locked(response)
            self._paused_reason = "none"
            self._consecutive_failures = 0
            self._retry_delay_ms = 0
            self._deadline = None
            self._wake = False
            self._scheduled = False
            self._coalesced = False
            self._condition.notify_all()

    def record_manual_failure(self, error: _DeliveryFailure) -> None:
        self._record_failure(error, automatic=self._automatic_delivery)

    def record_purge(self) -> None:
        with self._condition:
            self._paused_reason = "none"
            self._consecutive_failures = 0
            self._retry_delay_ms = 0
            self._deadline = None
            self._wake = False
            self._scheduled = False
            self._coalesced = False
            self._condition.notify_all()

    def stop_for_shutdown(self) -> None:
        with self._condition:
            self._lifecycle = "shutting_down"
            self._stop = True
            self._scheduled = False
            self._wake = False
            self._deadline = None
            self._condition.notify_all()
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join()

    def close(self) -> None:
        with self._condition:
            self._lifecycle = "closed"
            self._scheduled = False
            self._coalesced = False

    def reopen_after_failed_shutdown(
        self,
        queue_count: int,
        failure: _DeliveryFailure,
    ) -> None:
        with self._condition:
            self._lifecycle = "active"
            self._stop = False
            self._thread = None
            self._in_flight = False
        self._record_failure(failure, automatic=self._automatic_delivery)
        with self._condition:
            if (
                queue_count > 0
                and self._scheduled
                and self._lifecycle == "active"
                and not self._stop
                and os.getpid() == self._owner_pid
            ):
                self._ensure_thread_locked()
                self._condition.notify_all()

    def _ensure_thread_locked(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run,
            name="logbrew-delivery",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        while True:
            with self._condition:
                while True:
                    if self._stop or os.getpid() != self._owner_pid:
                        self._scheduled = False
                        return
                    now = time.monotonic()
                    due = self._wake or (self._deadline is not None and self._deadline <= now)
                    if due:
                        retrying_failed_prefix = self._retry_delay_ms > 0
                        self._wake = False
                        self._deadline = None
                        self._retry_delay_ms = 0
                        self._scheduled = False
                        self._in_flight = True
                        if not retrying_failed_prefix:
                            self._coalesced = False
                        break
                    timeout = None if self._deadline is None else max(0.0, self._deadline - now)
                    self._condition.wait(timeout)

            try:
                response = self._deliver()
            except _DeliveryFailure as error:
                self._record_failure(error, automatic=True)
            except Exception:
                self._record_failure(
                    _DeliveryFailure(
                        code="transport_error",
                        message="automatic delivery failed",
                        retryable=False,
                        pause_reason="non_retryable",
                    ),
                    automatic=True,
                )
            else:
                pending = self._pending_count()
                with self._condition:
                    self._in_flight = False
                    self._record_success_locked(response)
                    if not self._stop and pending > 0:
                        if self._coalesced or pending >= self._queue_threshold:
                            self._wake = True
                        else:
                            self._deadline = time.monotonic() + self._interval_seconds
                        self._scheduled = True
                    else:
                        self._coalesced = False
                    self._condition.notify_all()

    def _record_failure(self, error: _DeliveryFailure, *, automatic: bool) -> None:
        pending = self._pending_count()
        with self._condition:
            self._in_flight = False
            self._last_outcome = "failed"
            self._failures = _saturating_add(self._failures, 1)
            self._attempts = _saturating_add(self._attempts, error.attempts)
            self._batches = _saturating_add(self._batches, error.batches)
            self._accepted_events = _saturating_add(self._accepted_events, error.accepted_events)
            self._consecutive_failures = _saturating_add(self._consecutive_failures, 1)
            self._paused_reason = error.pause_reason
            self._scheduled = False
            self._deadline = None
            if automatic and error.retryable and not self._stop and pending > 0:
                exponent = min(self._consecutive_failures - 1, 30)
                maximum_delay = min(60.0, self._interval_seconds * (2**exponent))
                minimum_delay = maximum_delay / 2
                delay = minimum_delay + (random.random() * (maximum_delay - minimum_delay))
                if error.retry_after_ms is not None:
                    delay = max(delay, error.retry_after_ms / 1000)
                self._retry_delay_ms = min(3_600_000, max(1, round(delay * 1000)))
                self._deadline = time.monotonic() + delay
                self._scheduled = True
            else:
                self._retry_delay_ms = 0
                if error.pause_reason != "none":
                    self._coalesced = False
            self._condition.notify_all()

    def _record_success_locked(self, response: _DeliveryResult) -> None:
        self._last_outcome = "accepted" if response.batches > 0 else "empty"
        self._flushes = _saturating_add(self._flushes, 1)
        self._attempts = _saturating_add(self._attempts, response.attempts)
        self._batches = _saturating_add(self._batches, response.batches)
        self._accepted_events = _saturating_add(self._accepted_events, response.accepted_events)
        self._consecutive_failures = 0
        self._retry_delay_ms = 0
