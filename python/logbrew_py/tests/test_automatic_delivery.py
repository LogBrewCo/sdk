from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from dataclasses import FrozenInstanceError, asdict
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from logbrew_sdk import (
    DeliveryHealthSnapshot,
    HttpTransport,
    LogBrewClient,
    SdkError,
    TransportError,
    TransportResponse,
)
from logbrew_sdk._automatic_delivery import MAX_HEALTH_COUNTER, _saturating_add

HAS_PERSISTENCE_CRYPTO = importlib.util.find_spec("cryptography") is not None


def create_client(transport: Any | None = None, **kwargs: Any) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-automatic",
        sdk_version="0.1.0",
        transport=transport,
        **kwargs,
    )


def capture_log(client: LogBrewClient, event_id: str) -> None:
    client.log(
        event_id,
        "2026-07-20T08:00:00Z",
        {"message": f"message {event_id}", "level": "info", "logger": "automatic-test"},
    )


def wait_until(predicate: Any, *, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition was not reached before the bounded deadline")


class ScriptedTransport:
    def __init__(self, *responses: int | TransportResponse | Exception) -> None:
        self._responses = list(responses)
        self.sent_bodies: list[str] = []
        self._lock = threading.Lock()

    def send(self, api_key: str, body: str) -> TransportResponse:
        with self._lock:
            self.sent_bodies.append(body)
            response = self._responses.pop(0) if self._responses else 202
        if isinstance(response, Exception):
            raise response
        if isinstance(response, TransportResponse):
            return response
        return TransportResponse(status_code=response, attempts=1)


class UnexpectedFailureTransport:
    def send(self, api_key: str, body: str) -> TransportResponse:
        raise RuntimeError("private callback detail")


class AcknowledgeThenFailQueue:
    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate
        self._failed = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)

    def acknowledge(self, through_sequence: int) -> int:
        acknowledged = cast(int, self._delegate.acknowledge(through_sequence))
        if not self._failed:
            self._failed = True
            raise SdkError("persistence_commit_error", "accepted prefix outcome was ambiguous")
        return acknowledged


class CaptureDuringFailureTransport(ScriptedTransport):
    def __init__(self, client_ref: list[LogBrewClient]) -> None:
        super().__init__(TransportResponse(503, 1, retry_after_ms=20), 202, 202)
        self._client_ref = client_ref

    def send(self, api_key: str, body: str) -> TransportResponse:
        response = super().send(api_key, body)
        if len(self.sent_bodies) == 1:
            capture_log(self._client_ref[0], "evt_later")
        return response


class SingleFlightTransport:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.sent_bodies: list[str] = []
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def send(self, api_key: str, body: str) -> TransportResponse:
        with self._lock:
            self.sent_bodies.append(body)
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            call_count = len(self.sent_bodies)
        if call_count == 1:
            self.entered.set()
            if not self.release.wait(timeout=2):
                raise AssertionError("test did not release the transport")
        with self._lock:
            self.active -= 1
        return TransportResponse(status_code=202, attempts=1)


class HeaderResponse:
    def __init__(self, status: int, retry_after_ms: str | None) -> None:
        self.status = status
        self.headers = {} if retry_after_ms is None else {"retry-after-ms": retry_after_ms}

    def close(self) -> None:
        return


class AutomaticDeliveryPublicContractTests(unittest.TestCase):
    def test_manual_defaults_remain_manual_and_owned_transport_enables_automatic_delivery(self) -> None:
        manual = create_client()
        self.assertFalse(manual.delivery_health().automatic_delivery)
        self.assertEqual(manual.delivery_health().lifecycle, "idle")
        with self.assertRaisesRegex(SdkError, "owned transport"):
            manual.flush()

        transport = ScriptedTransport(202)
        automatic = create_client(transport)
        before = automatic.delivery_health()
        self.assertTrue(before.automatic_delivery)
        self.assertEqual(before.lifecycle, "idle")
        capture_log(automatic, "evt_lazy")
        self.assertIn(automatic.delivery_health().lifecycle, {"scheduled", "delivering"})
        workers = [thread for thread in threading.enumerate() if thread.name == "logbrew-automatic-delivery"]
        self.assertEqual(len(workers), 1)
        self.assertTrue(workers[0].daemon)
        automatic.shutdown()

    def test_automatic_configuration_is_validated_without_changing_manual_creation(self) -> None:
        with self.assertRaisesRegex(SdkError, "transport"):
            create_client(automatic_delivery=True)
        for option, invalid in (
            ("delivery_interval_seconds", 0),
            ("delivery_interval_seconds", 0.001),
            ("delivery_interval_seconds", True),
            ("delivery_interval_seconds", 3601),
            ("delivery_queue_threshold", 0),
            ("delivery_queue_threshold", True),
            ("delivery_queue_threshold", 11),
        ):
            with self.subTest(option=option), self.assertRaises(SdkError):
                create_client(
                    ScriptedTransport(),
                    max_queue_size=10,
                    **{option: invalid},
                )

        disabled = create_client(ScriptedTransport(), automatic_delivery=False)
        capture_log(disabled, "evt_manual")
        time.sleep(0.03)
        self.assertEqual(disabled.pending_events(), 1)
        disabled.shutdown()

    def test_scheduler_start_failure_retains_capture_and_pauses_without_raising(self) -> None:
        transport = ScriptedTransport(202)
        client = create_client(
            transport,
            delivery_interval_seconds=60,
            delivery_queue_threshold=1,
        )
        with patch.object(threading.Thread, "start", side_effect=RuntimeError("private thread failure")):
            capture_log(client, "evt_retained")

        health = client.delivery_health()
        self.assertEqual(client.pending_events(), 1)
        self.assertEqual(health.lifecycle, "paused")
        self.assertEqual(health.pause_reason, "internal")
        self.assertNotIn("private thread failure", repr(health))
        client.shutdown()

    def test_interval_and_threshold_wakes_use_one_owned_transport(self) -> None:
        interval_transport = ScriptedTransport(202)
        interval_client = create_client(
            interval_transport,
            delivery_interval_seconds=0.02,
            delivery_queue_threshold=50,
        )
        capture_log(interval_client, "evt_interval")
        wait_until(lambda: len(interval_transport.sent_bodies) == 1)
        self.assertEqual(interval_client.pending_events(), 0)
        self.assertEqual(interval_client.delivery_health().delivery_attempts, 1)
        self.assertEqual(interval_client.delivery_health().accepted_events, 1)
        interval_client.shutdown()

        threshold_transport = ScriptedTransport(202)
        threshold_client = create_client(
            threshold_transport,
            delivery_interval_seconds=60,
            delivery_queue_threshold=2,
        )
        capture_log(threshold_client, "evt_one")
        time.sleep(0.02)
        self.assertEqual(threshold_transport.sent_bodies, [])
        capture_log(threshold_client, "evt_two")
        wait_until(lambda: len(threshold_transport.sent_bodies) == 1)
        self.assertEqual(len(json.loads(threshold_transport.sent_bodies[0])["events"]), 2)
        threshold_client.shutdown()

    def test_inflight_capture_coalesces_without_concurrent_transport_calls(self) -> None:
        transport = SingleFlightTransport()
        client = create_client(
            transport,
            delivery_interval_seconds=60,
            delivery_queue_threshold=1,
        )
        capture_log(client, "evt_first")
        self.assertTrue(transport.entered.wait(timeout=2))
        capture_log(client, "evt_second")
        wait_until(lambda: client.delivery_health().wake_coalesced)
        transport.release.set()
        wait_until(lambda: len(transport.sent_bodies) == 2)

        self.assertEqual(transport.max_active, 1)
        self.assertEqual(
            [[event["id"] for event in json.loads(body)["events"]] for body in transport.sent_bodies],
            [["evt_first"], ["evt_second"]],
        )
        client.shutdown()

    def test_retry_keeps_an_exact_failed_prefix_and_later_work_behind_it(self) -> None:
        client_ref: list[LogBrewClient] = []
        transport = CaptureDuringFailureTransport(client_ref)
        client = create_client(
            transport,
            max_retries=0,
            delivery_interval_seconds=60,
            delivery_queue_threshold=1,
        )
        client_ref.append(client)
        capture_log(client, "evt_initial")

        wait_until(lambda: len(transport.sent_bodies) == 3)
        self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
        self.assertEqual(
            [event["id"] for event in json.loads(transport.sent_bodies[2])["events"]],
            ["evt_later"],
        )
        self.assertEqual(client.pending_events(), 0)
        client.shutdown()

    def test_terminal_auth_and_quota_pause_until_successful_owned_manual_flush(self) -> None:
        for status, reason in ((401, "authentication"), (429, "quota"), (400, "nonretryable")):
            with self.subTest(status=status):
                transport = ScriptedTransport(status, 202)
                client = create_client(
                    transport,
                    max_retries=0,
                    delivery_interval_seconds=60,
                    delivery_queue_threshold=1,
                )
                capture_log(client, "evt_paused")
                wait_until(lambda current=client: current.delivery_health().lifecycle == "paused")
                capture_log(client, "evt_later")
                time.sleep(0.03)
                self.assertEqual(len(transport.sent_bodies), 1)
                self.assertEqual(client.delivery_health().pause_reason, reason)

                response = client.flush()
                self.assertEqual(response.accepted_events, 2)
                self.assertEqual(client.delivery_health().pause_reason, "none")
                self.assertEqual(client.delivery_health().consecutive_failures, 0)
                client.shutdown()

    def test_retryable_failure_reports_bounded_delay_without_failure_text(self) -> None:
        private_text = "private upstream response text"
        transport = ScriptedTransport(TransportError.network(private_text), 202)
        client = create_client(
            transport,
            max_retries=0,
            delivery_interval_seconds=60,
            delivery_queue_threshold=1,
        )
        with patch("logbrew_sdk._automatic_delivery.random.uniform", return_value=0.75):
            capture_log(client, "evt_retry")
            wait_until(lambda: client.delivery_health().last_outcome == "retry_scheduled")
            health = client.delivery_health()
            self.assertGreaterEqual(health.retry_delay_ms, 700)
            self.assertLessEqual(health.retry_delay_ms, 750)
            self.assertNotIn(private_text, repr(health))
        client.shutdown()

    def test_later_threshold_capture_does_not_bypass_a_frozen_prefix_retry_deadline(self) -> None:
        transport = ScriptedTransport(TransportResponse(503, 1, retry_after_ms=150), 202)
        client = create_client(
            transport,
            max_retries=0,
            delivery_interval_seconds=60,
            delivery_queue_threshold=1,
        )
        capture_log(client, "evt_frozen")
        wait_until(lambda: client.delivery_health().last_outcome == "retry_scheduled")
        capture_log(client, "evt_later")
        time.sleep(0.05)
        self.assertEqual(len(transport.sent_bodies), 1)
        wait_until(lambda: len(transport.sent_bodies) >= 2)
        self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
        client.shutdown()

    def test_unexpected_worker_exception_fails_closed_without_private_text(self) -> None:
        client = create_client(
            UnexpectedFailureTransport(),
            delivery_interval_seconds=60,
            delivery_queue_threshold=1,
        )
        capture_log(client, "evt_internal")
        wait_until(lambda: client.delivery_health().lifecycle == "paused")

        health = client.delivery_health()
        self.assertEqual(health.pause_reason, "internal")
        self.assertNotIn("private callback detail", repr(health))
        self.assertEqual(client.pending_events(), 1)
        with self.assertRaisesRegex(RuntimeError, "private callback detail"):
            client.shutdown()
        client.shutdown(ScriptedTransport(202))

    def test_retryable_shutdown_failure_reopens_and_reschedules_retained_work(self) -> None:
        transport = ScriptedTransport(
            TransportError.network("private failure"),
            202,
        )
        client = create_client(
            transport,
            max_retries=0,
            automatic_delivery=False,
        )
        capture_log(client, "evt_reopened")
        with self.assertRaises(SdkError):
            client.shutdown()
        self.assertEqual(client.pending_events(), 1)
        capture_log(client, "evt_after_failure")
        response = client.shutdown()
        self.assertEqual(response.accepted_events, 2)

    def test_confirmed_acknowledgement_failure_cannot_resend_a_stale_frozen_prefix(self) -> None:
        client = create_client(automatic_delivery=False)
        capture_log(client, "evt_accepted")
        client._queue = AcknowledgeThenFailQueue(client._queue)
        first_transport = ScriptedTransport(202)
        with self.assertRaisesRegex(SdkError, "ambiguous"):
            client.flush(first_transport)

        capture_log(client, "evt_new")
        second_transport = ScriptedTransport(202)
        response = client.flush(second_transport)
        self.assertEqual(response.accepted_events, 1)
        self.assertEqual(
            [event["id"] for event in json.loads(second_transport.sent_bodies[0])["events"]],
            ["evt_new"],
        )
        client.shutdown(ScriptedTransport())

    @unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
    def test_owned_transport_automatically_replays_an_encrypted_retained_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            key = bytes(range(32))
            first = create_client(
                ScriptedTransport(),
                automatic_delivery=False,
                persistent_queue_directory=directory,
                persistent_queue_encryption_key=key,
            )
            capture_log(first, "evt_restart")
            first._queue.close()

            transport = ScriptedTransport(202)
            replacement = create_client(
                transport,
                delivery_interval_seconds=60,
                delivery_queue_threshold=1,
                persistent_queue_directory=directory,
                persistent_queue_encryption_key=key,
            )
            wait_until(lambda: len(transport.sent_bodies) == 1)
            self.assertEqual(
                [event["id"] for event in json.loads(transport.sent_bodies[0])["events"]],
                ["evt_restart"],
            )
            self.assertEqual(replacement.pending_events(), 0)
            replacement.shutdown()

    def test_health_is_frozen_bounded_and_contains_only_the_fixed_public_surface(self) -> None:
        transport = ScriptedTransport(202)
        client = create_client(transport, automatic_delivery=False, max_queue_size=1)
        capture_log(client, "evt_kept")
        capture_log(client, "evt_hidden_identifier")
        health = client.delivery_health()

        self.assertIsInstance(health, DeliveryHealthSnapshot)
        self.assertEqual(
            set(asdict(health)),
            {
                "lifecycle",
                "automatic_delivery",
                "pending_events",
                "pending_event_bytes",
                "dropped_events",
                "delivery_in_flight",
                "wake_coalesced",
                "last_outcome",
                "pause_reason",
                "consecutive_failures",
                "retry_delay_ms",
                "delivery_attempts",
                "accepted_events",
            },
        )
        for forbidden in ("evt_kept", "evt_hidden_identifier", "lb_test_key", "message"):
            self.assertNotIn(forbidden, repr(health))
        with self.assertRaises(FrozenInstanceError):
            health.pending_events = 99  # type: ignore[misc]
        self.assertEqual(_saturating_add(MAX_HEALTH_COUNTER, 1), MAX_HEALTH_COUNTER)
        client.shutdown()

    @unittest.skipUnless(hasattr(os, "fork"), "fork is unavailable")
    def test_inherited_automatic_client_remains_owned_by_the_parent(self) -> None:
        client = create_client(ScriptedTransport(), automatic_delivery=False)
        read_fd, write_fd = os.pipe()
        child_pid = os.fork()
        if child_pid == 0:
            os.close(read_fd)
            try:
                client.delivery_health()
            except SdkError as error:
                os.write(write_fd, error.code.encode("ascii"))
            finally:
                os.close(write_fd)
                os._exit(0)

        os.close(write_fd)
        try:
            self.assertEqual(os.read(read_fd, 128), b"process_ownership_error")
        finally:
            os.close(read_fd)
            os.waitpid(child_pid, 0)
        client.shutdown()

    def test_shutdown_disables_scheduling_rejects_capture_and_joins_inflight_delivery(self) -> None:
        transport = SingleFlightTransport()
        client = create_client(
            transport,
            delivery_interval_seconds=60,
            delivery_queue_threshold=1,
        )
        capture_log(client, "evt_shutdown")
        self.assertTrue(transport.entered.wait(timeout=2))
        results: list[TransportResponse] = []
        shutdown = threading.Thread(target=lambda: results.append(client.shutdown()))
        shutdown.start()
        wait_until(lambda: client.delivery_health().lifecycle == "shutting_down")
        with self.assertRaisesRegex(SdkError, "shut down"):
            capture_log(client, "evt_rejected")
        transport.release.set()
        shutdown.join(timeout=2)

        self.assertFalse(shutdown.is_alive())
        self.assertEqual(client.delivery_health().lifecycle, "closed")
        self.assertEqual(results[0].accepted_events, 0)


class AutomaticDeliveryTransportContractTests(unittest.TestCase):
    def test_http_transport_parses_only_bounded_decimal_retry_after_milliseconds(self) -> None:
        for raw, expected in (
            ("1250", 1250),
            ("0", 0),
            ("300000", 300000),
            ("300001", None),
            ("-1", None),
            ("1.5", None),
            ("private", None),
            ("9" * 100, None),
            (None, None),
        ):
            with self.subTest(raw=raw):
                response = HttpTransport(
                    open_url=lambda *_args, current=raw, **_kwargs: HeaderResponse(503, current),
                ).send("lb_test_key", "{}")
                self.assertEqual(response.retry_after_ms, expected)


if __name__ == "__main__":
    unittest.main()
