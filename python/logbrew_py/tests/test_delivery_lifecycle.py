from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from collections.abc import Mapping
from email.message import Message
from pathlib import Path
from typing import Any, cast
from unittest import mock
from urllib.error import HTTPError

from logbrew_sdk import HttpTransport, LogBrewClient, SdkError, TransportResponse

HAS_PERSISTENCE_CRYPTO = importlib.util.find_spec("cryptography") is not None
PERSISTENCE_KEY = bytes(range(32))


def create_client(**kwargs: Any) -> LogBrewClient:
    options: dict[str, Any] = {
        "api_key": "lb_test_key",
        "sdk_name": "logbrew-python-delivery-lifecycle",
        "sdk_version": "0.1.0",
    }
    options.update(kwargs)
    return LogBrewClient.create(**options)


def capture_log(client: LogBrewClient, event_id: str) -> None:
    client.log(
        event_id,
        "2026-07-16T08:00:00Z",
        {"message": "delivery lifecycle", "level": "info", "logger": "lifecycle-test"},
    )


class ThreadSafeScriptedTransport:
    def __init__(self, *statuses: int) -> None:
        self._statuses = list(statuses)
        self._lock = threading.Lock()
        self._sent = threading.Condition(self._lock)
        self.sent_bodies: list[str] = []
        self.send_times: list[float] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        with self._sent:
            self.sent_bodies.append(body)
            self.send_times.append(time.monotonic())
            status = self._statuses.pop(0) if self._statuses else 202
            self._sent.notify_all()
        return TransportResponse(status_code=status, attempts=1)

    def wait_for_sends(self, count: int, timeout: float = 2.0) -> None:
        deadline = time.monotonic() + timeout
        with self._sent:
            while len(self.sent_bodies) < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"expected {count} sends, observed {len(self.sent_bodies)}")
                self._sent.wait(remaining)


class BlockingThenAcceptingTransport(ThreadSafeScriptedTransport):
    def __init__(self, *statuses: int) -> None:
        super().__init__(*(statuses or (202, 202)))
        self.first_send_entered = threading.Event()
        self.release_first_send = threading.Event()

    def send(self, api_key: str, body: str) -> TransportResponse:
        with self._sent:
            self.sent_bodies.append(body)
            self.send_times.append(time.monotonic())
            send_index = len(self.sent_bodies)
            status = self._statuses.pop(0) if self._statuses else 202
            self._sent.notify_all()
        if send_index == 1:
            self.first_send_entered.set()
            if not self.release_first_send.wait(timeout=2):
                raise AssertionError("test did not release the first transport send")
        return TransportResponse(status_code=status, attempts=1)


def wait_for_health(client: LogBrewClient, key: str, expected: Any, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    health = cast(Mapping[str, object], client.delivery_health())
    while health[key] != expected:
        if time.monotonic() >= deadline:
            raise AssertionError(
                f"expected delivery health {key}={expected!r}, observed {health[key]!r}"
            )
        time.sleep(0.005)
        health = cast(Mapping[str, object], client.delivery_health())


class FakeHttpResponse:
    def __init__(self, status: int, retry_after: object | None = None) -> None:
        self.status = status
        self.headers = {} if retry_after is None else {"Retry-After": retry_after}
        self.closed = False

    def close(self) -> None:
        self.closed = True


class LogBrewAutomaticDeliveryContractTests(unittest.TestCase):
    def test_http_transport_parses_only_bounded_numeric_retry_after_hints(self) -> None:
        for value, expected in (
            ("2", 2000),
            ("0.125", 125),
            ("999999", 3_600_000),
            ("not-a-number", None),
            ("-1", None),
            (float("inf"), None),
        ):
            with self.subTest(value=value):
                response = FakeHttpResponse(202, value)
                transport = HttpTransport(open_url=mock.Mock(return_value=response))
                result = transport.send("lb_test_key", '{"events":[]}')
                self.assertEqual(result.retry_after_ms, expected)
                self.assertTrue(response.closed)

        error_headers = Message()
        error_headers["Retry-After"] = "3"
        error = HTTPError(
            url="https://example.invalid/v1/events",
            code=503,
            msg="retry",
            hdrs=error_headers,
            fp=None,
        )
        transport = HttpTransport(open_url=mock.Mock(side_effect=error))
        result = transport.send("lb_test_key", '{"events":[]}')
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.retry_after_ms, 3000)

    def test_manual_default_and_owned_transport_opt_out_preserve_explicit_delivery(self) -> None:
        explicit_transport = ThreadSafeScriptedTransport(202)
        manual = create_client()
        capture_log(manual, "evt_manual")
        time.sleep(0.04)
        self.assertEqual(manual.pending_events(), 1)
        self.assertFalse(manual.delivery_health()["automatic_delivery"])
        self.assertFalse(manual.delivery_health()["scheduled"])
        manual.flush(explicit_transport)
        manual.shutdown(explicit_transport)

        owned_transport = ThreadSafeScriptedTransport(202)
        opted_out = create_client(transport=owned_transport, automatic_delivery=False)
        capture_log(opted_out, "evt_opted_out")
        time.sleep(0.04)
        self.assertEqual(len(owned_transport.sent_bodies), 0)
        self.assertFalse(opted_out.delivery_health()["automatic_delivery"])
        opted_out.flush()
        self.assertEqual(len(owned_transport.sent_bodies), 1)
        opted_out.shutdown()

    def test_delivery_configuration_is_bounded_and_typed(self) -> None:
        transport = ThreadSafeScriptedTransport()
        for value in (0, -1, True, float("inf"), "5"):
            with self.subTest(interval=value), self.assertRaisesRegex(
                SdkError,
                "delivery_interval_seconds must be between",
            ):
                create_client(transport=transport, delivery_interval_seconds=value)
        for value in (0, -1, True, 1.5, "5"):
            with self.subTest(threshold=value), self.assertRaisesRegex(
                SdkError,
                "delivery_queue_threshold must be a positive integer",
            ):
                create_client(transport=transport, delivery_queue_threshold=value)
        with self.assertRaisesRegex(SdkError, "delivery_queue_threshold cannot exceed max_queue_size"):
            create_client(transport=transport, max_queue_size=2, delivery_queue_threshold=3)
        with self.assertRaisesRegex(SdkError, "automatic_delivery must be a boolean"):
            create_client(transport=transport, automatic_delivery="yes")

    def test_default_threshold_tracks_a_smaller_compatible_queue(self) -> None:
        manual = create_client(max_queue_size=2)
        capture_log(manual, "evt_small_manual")
        self.assertEqual(manual.pending_events(), 1)
        manual.shutdown(ThreadSafeScriptedTransport(202))

        transport = ThreadSafeScriptedTransport(202)
        automatic = create_client(
            transport=transport,
            max_queue_size=2,
            delivery_interval_seconds=5,
        )
        capture_log(automatic, "evt_small_auto_1")
        capture_log(automatic, "evt_small_auto_2")
        transport.wait_for_sends(1)
        automatic.shutdown()

    def test_interval_sends_after_first_accepted_event_without_manual_flush(self) -> None:
        transport = ThreadSafeScriptedTransport(202)
        client = create_client(
            transport=transport,
            delivery_interval_seconds=0.02,
            delivery_queue_threshold=50,
        )

        capture_log(client, "evt_interval")
        transport.wait_for_sends(1)

        self.assertEqual(json.loads(transport.sent_bodies[0])["events"][0]["id"], "evt_interval")
        self.assertEqual(client.pending_events(), 0)
        client.shutdown()

    @unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
    def test_owned_persistent_client_schedules_authenticated_recovered_work_without_new_capture(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            original = create_client(
                persistent_queue_directory=directory,
                persistent_queue_encryption_key=PERSISTENCE_KEY,
            )
            capture_log(original, "evt_recovered_automatic")
            original._queue.close()

            transport = ThreadSafeScriptedTransport(202)
            recovered = create_client(
                transport=transport,
                delivery_interval_seconds=0.02,
                persistent_queue_directory=directory,
                persistent_queue_encryption_key=PERSISTENCE_KEY,
            )
            transport.wait_for_sends(1)

            self.assertEqual(
                [event["id"] for event in json.loads(transport.sent_bodies[0])["events"]],
                ["evt_recovered_automatic"],
            )
            self.assertEqual(recovered.pending_events(), 0)
            recovered.shutdown()

    def test_owned_transport_starts_lazily_and_threshold_sends_without_manual_flush(self) -> None:
        transport = ThreadSafeScriptedTransport(202)
        client = create_client(
            transport=transport,
            delivery_interval_seconds=5.0,
            delivery_queue_threshold=2,
        )

        self.assertEqual(
            client.delivery_health(),
            {
                "automatic_delivery": True,
                "lifecycle": "active",
                "queue_events": 0,
                "queue_bytes": 0,
                "dropped_events": 0,
                "scheduled": False,
                "in_flight": False,
                "coalesced": False,
                "last_outcome": "idle",
                "paused_reason": "none",
                "consecutive_failures": 0,
                "retry_delay_ms": 0,
                "flushes": 0,
                "failures": 0,
                "attempts": 0,
                "batches": 0,
                "accepted_events": 0,
            },
        )

        capture_log(client, "evt_threshold_1")
        self.assertEqual(len(transport.sent_bodies), 0)
        self.assertTrue(client.delivery_health()["scheduled"])

        capture_log(client, "evt_threshold_2")
        transport.wait_for_sends(1)

        self.assertEqual(
            [event["id"] for event in json.loads(transport.sent_bodies[0])["events"]],
            ["evt_threshold_1", "evt_threshold_2"],
        )
        self.assertEqual(client.pending_events(), 0)
        health = client.delivery_health()
        self.assertEqual(health["last_outcome"], "accepted")
        self.assertEqual(health["flushes"], 1)
        self.assertEqual(health["attempts"], 1)
        self.assertEqual(health["batches"], 1)
        self.assertEqual(health["accepted_events"], 2)
        self.assertFalse(health["scheduled"])
        client.shutdown()

    def test_scheduler_is_one_lazy_daemon_owned_and_stopped_by_the_client(self) -> None:
        existing_schedulers = {
            id(thread) for thread in threading.enumerate() if thread.name == "logbrew-delivery"
        }
        transport = ThreadSafeScriptedTransport(202)
        client = create_client(
            transport=transport,
            delivery_interval_seconds=5,
            delivery_queue_threshold=50,
        )

        capture_log(client, "evt_daemon")
        schedulers = [
            thread
            for thread in threading.enumerate()
            if thread.name == "logbrew-delivery" and id(thread) not in existing_schedulers
        ]
        self.assertEqual(len(schedulers), 1)
        self.assertTrue(schedulers[0].daemon)

        client.shutdown()
        self.assertFalse(schedulers[0].is_alive())

    def test_authentication_failure_pauses_until_explicit_owned_transport_recovery(self) -> None:
        transport = ThreadSafeScriptedTransport(401, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            delivery_interval_seconds=0.02,
            delivery_queue_threshold=1,
        )

        capture_log(client, "evt_auth_initial")
        transport.wait_for_sends(1)
        deadline = time.monotonic() + 1
        while client.delivery_health()["failures"] < 1:
            if time.monotonic() >= deadline:
                self.fail("automatic authentication failure was not recorded")
            time.sleep(0.005)

        health = client.delivery_health()
        self.assertEqual(health["paused_reason"], "authentication")
        self.assertEqual(health["last_outcome"], "failed")
        self.assertEqual(health["consecutive_failures"], 1)
        self.assertEqual(health["retry_delay_ms"], 0)
        self.assertFalse(health["scheduled"])
        self.assertEqual(client.pending_events(), 1)

        capture_log(client, "evt_auth_later")
        time.sleep(0.08)
        self.assertEqual(len(transport.sent_bodies), 1)
        self.assertEqual(client.pending_events(), 2)

        response = client.flush()
        self.assertEqual(response.status_code, 202)
        transport.wait_for_sends(3)
        self.assertEqual(client.pending_events(), 0)
        recovered_health = client.delivery_health()
        self.assertEqual(recovered_health["paused_reason"], "none")
        self.assertEqual(recovered_health["consecutive_failures"], 0)
        client.shutdown()

    def test_capture_during_automatic_io_coalesces_one_ordered_trailing_delivery(self) -> None:
        transport = BlockingThenAcceptingTransport()
        client = create_client(
            transport=transport,
            delivery_interval_seconds=5,
            delivery_queue_threshold=1,
        )

        capture_log(client, "evt_active")
        self.assertTrue(transport.first_send_entered.wait(timeout=2))
        capture_log(client, "evt_later")
        wait_for_health(client, "coalesced", True)
        self.assertTrue(client.delivery_health()["in_flight"])
        transport.release_first_send.set()
        transport.wait_for_sends(2)

        self.assertEqual(
            [[event["id"] for event in json.loads(body)["events"]] for body in transport.sent_bodies],
            [["evt_active"], ["evt_later"]],
        )
        wait_for_health(client, "in_flight", False)
        self.assertFalse(client.delivery_health()["coalesced"])
        client.shutdown()

    def test_retryable_exhaustion_freezes_prefix_and_later_capture_cannot_bypass_backoff(self) -> None:
        transport = ThreadSafeScriptedTransport(503, 202, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            delivery_interval_seconds=0.2,
            delivery_queue_threshold=1,
        )

        with mock.patch("logbrew_sdk._delivery_lifecycle.random.random", return_value=0.0):
            capture_log(client, "evt_retry")
            transport.wait_for_sends(1)
            wait_for_health(client, "failures", 1)
            self.assertEqual(client.delivery_health()["retry_delay_ms"], 100)

            capture_log(client, "evt_retry_later")
            time.sleep(0.04)
            self.assertEqual(len(transport.sent_bodies), 1)

            transport.wait_for_sends(2)
            self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
            transport.wait_for_sends(3)

        self.assertEqual(
            [[event["id"] for event in json.loads(body)["events"]] for body in transport.sent_bodies],
            [["evt_retry"], ["evt_retry"], ["evt_retry_later"]],
        )
        wait_for_health(client, "in_flight", False)
        health = client.delivery_health()
        self.assertEqual(health["last_outcome"], "accepted")
        self.assertEqual(health["consecutive_failures"], 0)
        self.assertEqual(health["retry_delay_ms"], 0)
        self.assertEqual(health["attempts"], 3)
        client.shutdown()

    def test_failed_later_batch_health_keeps_accepted_prefix_accounting(self) -> None:
        transport = ThreadSafeScriptedTransport(202, 503, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            max_batch_events=1,
            delivery_interval_seconds=0.2,
            delivery_queue_threshold=2,
        )

        with mock.patch("logbrew_sdk._delivery_lifecycle.random.random", return_value=0.0):
            capture_log(client, "evt_prefix_accepted")
            capture_log(client, "evt_prefix_failed")
            transport.wait_for_sends(2)
            wait_for_health(client, "failures", 1)
            failed_health = client.delivery_health()
            self.assertEqual(failed_health["attempts"], 2)
            self.assertEqual(failed_health["batches"], 1)
            self.assertEqual(failed_health["accepted_events"], 1)
            self.assertEqual(client.pending_events(), 1)
            transport.wait_for_sends(3)

        wait_for_health(client, "last_outcome", "accepted")
        accepted_health = client.delivery_health()
        self.assertEqual(accepted_health["attempts"], 3)
        self.assertEqual(accepted_health["batches"], 2)
        self.assertEqual(accepted_health["accepted_events"], 2)
        client.shutdown()

    def test_capture_during_failed_io_keeps_one_immediate_coalesced_cohort_after_retry(self) -> None:
        transport = BlockingThenAcceptingTransport(503, 202, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            delivery_interval_seconds=0.5,
            delivery_queue_threshold=50,
        )
        capture_log(client, "evt_failed_active")
        self.assertTrue(transport.first_send_entered.wait(timeout=2))
        capture_log(client, "evt_failed_later")
        wait_for_health(client, "coalesced", True)

        with mock.patch("logbrew_sdk._delivery_lifecycle.random.random", return_value=0.0):
            transport.release_first_send.set()
            transport.wait_for_sends(3)

        self.assertLess(transport.send_times[2] - transport.send_times[1], 0.2)
        self.assertEqual(
            [[event["id"] for event in json.loads(body)["events"]] for body in transport.sent_bodies],
            [["evt_failed_active"], ["evt_failed_active"], ["evt_failed_later"]],
        )
        client.shutdown()

    def test_manual_success_cancels_stale_automatic_backoff(self) -> None:
        transport = ThreadSafeScriptedTransport(503, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            delivery_interval_seconds=0.2,
            delivery_queue_threshold=1,
        )

        with mock.patch("logbrew_sdk._delivery_lifecycle.random.random", return_value=0.0):
            capture_log(client, "evt_manual_recovery")
            transport.wait_for_sends(1)
            wait_for_health(client, "failures", 1)
            response = client.flush()
            self.assertEqual(response.status_code, 202)
            self.assertEqual(client.delivery_health()["flushes"], 1)
            self.assertFalse(client.delivery_health()["scheduled"])
            time.sleep(0.14)

        self.assertEqual(len(transport.sent_bodies), 2)
        self.assertEqual(client.delivery_health()["flushes"], 1)
        self.assertEqual(client.delivery_health()["retry_delay_ms"], 0)
        client.shutdown()

    def test_retryable_manual_recovery_failure_keeps_bounded_automatic_retry(self) -> None:
        transport = ThreadSafeScriptedTransport(503, 503, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            delivery_interval_seconds=0.2,
            delivery_queue_threshold=1,
        )

        with mock.patch("logbrew_sdk._delivery_lifecycle.random.random", return_value=0.0):
            capture_log(client, "evt_manual_retry_failure")
            transport.wait_for_sends(1)
            wait_for_health(client, "failures", 1)
            with self.assertRaisesRegex(SdkError, "unexpected transport status 503"):
                client.flush()
            self.assertEqual(client.delivery_health()["failures"], 2)
            self.assertEqual(client.delivery_health()["retry_delay_ms"], 200)
            transport.wait_for_sends(3)

        self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
        self.assertEqual(transport.sent_bodies[1], transport.sent_bodies[2])
        wait_for_health(client, "last_outcome", "accepted")
        client.shutdown()

    def test_rate_limit_and_nonretryable_failures_pause_without_status_in_health(self) -> None:
        for status, expected_reason in ((429, "rate_limit"), (400, "non_retryable")):
            with self.subTest(status=status):
                transport = ThreadSafeScriptedTransport(status, 202)
                client = create_client(
                    api_key="private-api-key",
                    transport=transport,
                    max_retries=0,
                    delivery_interval_seconds=0.02,
                    delivery_queue_threshold=1,
                )
                capture_log(client, f"private-event-{status}")
                transport.wait_for_sends(1)
                wait_for_health(client, "failures", 1)

                health = client.delivery_health()
                self.assertEqual(health["paused_reason"], expected_reason)
                self.assertFalse(health["scheduled"])
                serialized = json.dumps(health, sort_keys=True)
                for forbidden in ("private-api-key", f"private-event-{status}", str(status)):
                    self.assertNotIn(forbidden, serialized)

                client.flush()
                self.assertEqual(client.delivery_health()["paused_reason"], "none")
                client.shutdown()

    def test_explicit_purge_cancels_terminal_pause_before_new_work(self) -> None:
        transport = ThreadSafeScriptedTransport(429, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            delivery_interval_seconds=0.02,
            delivery_queue_threshold=1,
        )
        capture_log(client, "evt_purge_paused")
        transport.wait_for_sends(1)
        wait_for_health(client, "paused_reason", "rate_limit")

        self.assertEqual(client.purge_pending_events(), 1)
        health = client.delivery_health()
        self.assertEqual(health["queue_events"], 0)
        self.assertEqual(health["paused_reason"], "none")
        self.assertEqual(health["retry_delay_ms"], 0)
        self.assertFalse(health["scheduled"])

        capture_log(client, "evt_after_purge")
        transport.wait_for_sends(2)
        wait_for_health(client, "last_outcome", "accepted")
        client.shutdown()

    def test_shutdown_waits_for_active_delivery_rejects_later_capture_and_closes(self) -> None:
        transport = BlockingThenAcceptingTransport()
        client = create_client(
            transport=transport,
            delivery_interval_seconds=5,
            delivery_queue_threshold=1,
        )
        capture_log(client, "evt_shutdown")
        self.assertTrue(transport.first_send_entered.wait(timeout=2))

        responses: list[TransportResponse] = []
        shutdown_thread = threading.Thread(target=lambda: responses.append(client.shutdown()))
        shutdown_thread.start()
        wait_for_health(client, "lifecycle", "shutting_down")
        with self.assertRaisesRegex(SdkError, "client is already shut down"):
            capture_log(client, "evt_after_shutdown")
        transport.release_first_send.set()
        shutdown_thread.join(timeout=2)

        self.assertFalse(shutdown_thread.is_alive())
        self.assertEqual(len(responses), 1)
        self.assertEqual(client.delivery_health()["lifecycle"], "closed")
        self.assertFalse(client.delivery_health()["scheduled"])
        with self.assertRaisesRegex(SdkError, "client is already shut down"):
            client.flush()

    def test_failed_shutdown_reopens_and_next_shutdown_drains_frozen_prefix_then_later_work(self) -> None:
        transport = ThreadSafeScriptedTransport(400, 202, 202)
        client = create_client(
            transport=transport,
            automatic_delivery=False,
            max_retries=0,
            max_batch_events=1,
        )
        capture_log(client, "evt_failed_shutdown")

        with self.assertRaisesRegex(SdkError, "unexpected transport status 400"):
            client.shutdown()

        self.assertEqual(client.delivery_health()["lifecycle"], "active")
        self.assertEqual(client.delivery_health()["failures"], 1)
        self.assertEqual(client.delivery_health()["paused_reason"], "non_retryable")
        capture_log(client, "evt_after_failed_shutdown")

        response = client.shutdown()

        self.assertEqual(response.accepted_events, 2)
        self.assertEqual(
            [[event["id"] for event in json.loads(body)["events"]] for body in transport.sent_bodies],
            [["evt_failed_shutdown"], ["evt_failed_shutdown"], ["evt_after_failed_shutdown"]],
        )
        self.assertEqual(client.delivery_health()["lifecycle"], "closed")

    def test_retryable_shutdown_failure_reopens_with_bounded_automatic_backoff(self) -> None:
        transport = ThreadSafeScriptedTransport(503, 202)
        client = create_client(
            transport=transport,
            max_retries=0,
            delivery_interval_seconds=0.2,
            delivery_queue_threshold=50,
        )
        capture_log(client, "evt_retryable_shutdown")

        with mock.patch("logbrew_sdk._delivery_lifecycle.random.random", return_value=0.0):
            with self.assertRaisesRegex(SdkError, "unexpected transport status 503"):
                client.shutdown()
            self.assertEqual(client.delivery_health()["lifecycle"], "active")
            self.assertEqual(client.delivery_health()["retry_delay_ms"], 100)
            self.assertFalse(client.delivery_health()["coalesced"])
            transport.wait_for_sends(2)

        wait_for_health(client, "last_outcome", "accepted")
        self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
        self.assertEqual(client.pending_events(), 0)
        client.shutdown()

    def test_failed_external_shutdown_retries_retained_body_through_owned_transport(self) -> None:
        owned_transport = ThreadSafeScriptedTransport(202)
        external_transport = ThreadSafeScriptedTransport(400)
        client = create_client(
            transport=owned_transport,
            max_retries=0,
            delivery_interval_seconds=0.2,
            delivery_queue_threshold=50,
        )
        capture_log(client, "evt_external_shutdown")

        with mock.patch("logbrew_sdk._delivery_lifecycle.random.random", return_value=0.0):
            with self.assertRaisesRegex(SdkError, "unexpected transport status 400"):
                client.shutdown(external_transport)
            health = client.delivery_health()
            self.assertEqual(health["lifecycle"], "active")
            self.assertEqual(health["paused_reason"], "none")
            self.assertEqual(health["retry_delay_ms"], 100)
            self.assertEqual(health["attempts"], 1)
            owned_transport.wait_for_sends(1)

        self.assertEqual(external_transport.sent_bodies[0], owned_transport.sent_bodies[0])
        wait_for_health(client, "last_outcome", "accepted")
        self.assertEqual(client.pending_events(), 0)
        client.shutdown()

    def test_non_owner_process_cannot_read_health_or_start_delivery(self) -> None:
        client = create_client(
            transport=ThreadSafeScriptedTransport(),
            delivery_interval_seconds=5,
            delivery_queue_threshold=1,
        )
        with (
            mock.patch("logbrew_sdk.os.getpid", return_value=os.getpid() + 1),
            self.assertRaisesRegex(SdkError, "client cannot be used after fork"),
        ):
            client.delivery_health()
        client.shutdown()

    def test_automatic_delivery_requires_owned_transport_when_explicitly_enabled(self) -> None:
        with self.assertRaisesRegex(SdkError, "automatic_delivery requires an owned transport"):
            create_client(automatic_delivery=True)


if __name__ == "__main__":
    unittest.main()
