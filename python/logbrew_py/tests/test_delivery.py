from __future__ import annotations

import json
import threading
import time
import unittest
from typing import Any

from logbrew_sdk import LogBrewClient, SdkError, TransportResponse


def create_client(**kwargs: Any) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-delivery",
        sdk_version="0.1.0",
        **kwargs,
    )


def capture_log(client: LogBrewClient, event_id: str, message: str) -> None:
    client.log(
        event_id,
        "2026-07-14T10:00:00Z",
        {"message": message, "level": "info", "logger": "delivery-test"},
    )


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class LogBrewDeliveryAdmissionTests(unittest.TestCase):
    def test_public_sdk_error_keeps_its_original_module_identity(self) -> None:
        self.assertEqual(SdkError.__module__, "logbrew_sdk")

    def test_delivery_limits_must_be_positive_non_boolean_integers(self) -> None:
        for option in ("max_queue_bytes", "max_batch_events", "max_batch_bytes"):
            for invalid in (0, -1, True, 1.5, "100"):
                with self.subTest(option=option, invalid=invalid), self.assertRaisesRegex(
                    SdkError,
                    rf"{option} must be a positive integer",
                ):
                    create_client(**{option: invalid})

    def test_admission_counts_exact_compact_utf8_bytes_and_exposes_snapshot_events(self) -> None:
        client = create_client()
        capture_log(client, "evt_utf8", "cafe \u2615")

        event = json.loads(client.preview_json())["events"][0]
        expected_bytes = len(compact_json(event).encode("utf-8"))

        self.assertEqual(client.pending_event_bytes(), expected_bytes)
        snapshot = client.events
        snapshot[0]["attributes"]["message"] = "changed outside the queue"
        self.assertEqual(
            json.loads(client.preview_json())["events"][0]["attributes"]["message"],
            "cafe \u2615",
        )

    def test_queue_byte_pressure_and_single_request_limit_drop_newest_event(self) -> None:
        probe = create_client()
        capture_log(probe, "evt_kept", "kept context")
        kept_event = json.loads(probe.preview_json())["events"][0]
        kept_bytes = len(compact_json(kept_event).encode("utf-8"))

        byte_bounded = create_client(max_queue_bytes=kept_bytes)
        capture_log(byte_bounded, "evt_kept", "kept context")
        capture_log(byte_bounded, "evt_dropped", "later context")

        self.assertEqual(byte_bounded.pending_events(), 1)
        self.assertEqual(byte_bounded.pending_event_bytes(), kept_bytes)
        self.assertEqual(byte_bounded.dropped_events(), 1)
        self.assertEqual(
            json.loads(byte_bounded.preview_json())["events"][0]["id"],
            "evt_kept",
        )

        sdk_json = compact_json(probe.sdk)
        one_event_request_bytes = len(
            f'{{"sdk":{sdk_json},"events":[{compact_json(kept_event)}]}}'.encode()
        )
        request_bounded = create_client(max_batch_bytes=one_event_request_bytes - 1)
        capture_log(request_bounded, "evt_kept", "kept context")

        self.assertEqual(request_bounded.pending_events(), 0)
        self.assertEqual(request_bounded.pending_event_bytes(), 0)
        self.assertEqual(request_bounded.dropped_events(), 1)


class ScriptedTransport:
    def __init__(self, *statuses: int) -> None:
        self._statuses = list(statuses)
        self.sent_bodies: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.sent_bodies.append(body)
        if not self._statuses:
            raise AssertionError("transport script exhausted")
        return TransportResponse(status_code=self._statuses.pop(0), attempts=1)


class CaptureDuringRetryTransport:
    def __init__(self, client: LogBrewClient) -> None:
        self.client = client
        self.sent_bodies: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.sent_bodies.append(body)
        if len(self.sent_bodies) == 1:
            capture_log(self.client, "evt_later", "captured during transport")
            return TransportResponse(status_code=503, attempts=1)
        return TransportResponse(status_code=202, attempts=1)


class BlockingTransport:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.sent_bodies: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.sent_bodies.append(body)
        self.entered.set()
        if not self.release.wait(timeout=5):
            raise AssertionError("test did not release transport")
        return TransportResponse(status_code=202, attempts=1)


class ReentrantTransport:
    def __init__(self, client: LogBrewClient) -> None:
        self.client = client
        self.reentrant_error: SdkError | None = None
        self.attempted = False

    def send(self, api_key: str, body: str) -> TransportResponse:
        if not self.attempted:
            self.attempted = True
            try:
                self.client.flush(self)
            except SdkError as error:
                self.reentrant_error = error
        return TransportResponse(status_code=202, attempts=1)


class CaptureDuringShutdownTransport:
    def __init__(self, client: LogBrewClient) -> None:
        self.client = client
        self.capture_error: SdkError | None = None

    def send(self, api_key: str, body: str) -> TransportResponse:
        try:
            capture_log(self.client, "evt_late_shutdown", "must be rejected")
        except SdkError as error:
            self.capture_error = error
        return TransportResponse(status_code=202, attempts=1)


class LogBrewDeliveryFlushTests(unittest.TestCase):
    def test_flush_splits_exact_count_prefixes_and_reports_aggregate_result(self) -> None:
        client = create_client(max_batch_events=2)
        for index in range(5):
            capture_log(client, f"evt_{index}", f"event {index}")
        transport = ScriptedTransport(202, 202, 202)

        response = client.flush(transport)

        self.assertEqual([len(json.loads(body)["events"]) for body in transport.sent_bodies], [2, 2, 1])
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.attempts, 3)
        self.assertEqual(response.batches, 3)
        self.assertEqual(response.accepted_events, 5)
        self.assertEqual(client.pending_events(), 0)

    def test_flush_splits_on_exact_compact_utf8_request_bytes(self) -> None:
        probe = create_client()
        capture_log(probe, "evt_a", "alpha \u2615")
        capture_log(probe, "evt_b", "bravo \u2615")
        events = json.loads(probe.preview_json())["events"]
        exact_two_event_body = compact_json({"sdk": probe.sdk, "events": events})
        exact_limit = len(exact_two_event_body.encode("utf-8"))

        client = create_client(max_batch_bytes=exact_limit)
        capture_log(client, "evt_a", "alpha \u2615")
        capture_log(client, "evt_b", "bravo \u2615")
        capture_log(client, "evt_c", "charlie \u2615")
        transport = ScriptedTransport(202, 202)

        response = client.flush(transport)

        self.assertEqual([len(json.loads(body)["events"]) for body in transport.sent_bodies], [2, 1])
        self.assertTrue(all(len(body.encode("utf-8")) <= exact_limit for body in transport.sent_bodies))
        self.assertEqual(response.accepted_events, 3)

    def test_retry_reuses_one_body_and_retains_transport_time_capture(self) -> None:
        client = create_client(max_retries=1)
        capture_log(client, "evt_initial", "initial")
        transport = CaptureDuringRetryTransport(client)

        response = client.flush(transport)

        self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
        self.assertEqual(response.attempts, 2)
        self.assertEqual(response.batches, 1)
        self.assertEqual(response.accepted_events, 1)
        self.assertEqual([event["id"] for event in client.events], ["evt_later"])

    def test_later_batch_failure_keeps_only_the_unaccepted_prefix(self) -> None:
        client = create_client(max_retries=0, max_batch_events=2)
        for index in range(3):
            capture_log(client, f"evt_{index}", f"event {index}")
        transport = ScriptedTransport(202, 400)

        with self.assertRaisesRegex(SdkError, "unexpected transport status 400"):
            client.flush(transport)

        self.assertEqual([event["id"] for event in client.events], ["evt_2"])
        self.assertEqual([len(json.loads(body)["events"]) for body in transport.sent_bodies], [2, 1])

    def test_competing_flush_waits_and_does_not_duplicate_the_active_snapshot(self) -> None:
        client = create_client()
        capture_log(client, "evt_once", "send once")
        transport = BlockingTransport()
        responses: list[TransportResponse] = []
        second_started = threading.Event()

        first = threading.Thread(target=lambda: responses.append(client.flush(transport)))

        def second_flush() -> None:
            second_started.set()
            responses.append(client.flush(transport))

        second = threading.Thread(target=second_flush)
        first.start()
        self.assertTrue(transport.entered.wait(timeout=5))
        second.start()
        self.assertTrue(second_started.wait(timeout=5))
        time.sleep(0.05)

        try:
            self.assertEqual(len(transport.sent_bodies), 1)
        finally:
            transport.release.set()
            first.join(timeout=5)
            second.join(timeout=5)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(sorted(response.status_code for response in responses), [202, 204])
        self.assertEqual(len(transport.sent_bodies), 1)

    def test_purge_rejects_an_active_delivery_without_changing_its_snapshot(self) -> None:
        client = create_client()
        capture_log(client, "evt_once", "send once")
        transport = BlockingTransport()
        response: list[TransportResponse] = []
        delivery = threading.Thread(target=lambda: response.append(client.flush(transport)))
        delivery.start()
        self.assertTrue(transport.entered.wait(timeout=5))

        try:
            with self.assertRaises(SdkError) as raised:
                client.purge_pending_events()
            self.assertEqual(raised.exception.code, "queue_busy_error")
            self.assertEqual(client.pending_events(), 1)
        finally:
            transport.release.set()
            delivery.join(timeout=5)

        self.assertFalse(delivery.is_alive())
        self.assertEqual(response[0].accepted_events, 1)
        self.assertEqual(client.pending_events(), 0)

    def test_same_thread_reentrant_flush_fails_before_an_extra_send(self) -> None:
        client = create_client()
        capture_log(client, "evt_once", "send once")
        transport = ReentrantTransport(client)

        response = client.flush(transport)

        self.assertEqual(response.status_code, 202)
        self.assertIsNotNone(transport.reentrant_error)
        assert transport.reentrant_error is not None
        self.assertEqual(transport.reentrant_error.code, "queue_reentrant_error")

    def test_shutdown_rejects_transport_time_capture_and_failed_shutdown_reopens(self) -> None:
        client = create_client(max_retries=0)
        capture_log(client, "evt_shutdown", "shutdown")
        accepting = CaptureDuringShutdownTransport(client)

        response = client.shutdown(accepting)

        self.assertEqual(response.accepted_events, 1)
        self.assertIsNotNone(accepting.capture_error)
        assert accepting.capture_error is not None
        self.assertEqual(accepting.capture_error.code, "shutdown_error")
        self.assertEqual(client.pending_events(), 0)

        retryable = create_client(max_retries=0)
        capture_log(retryable, "evt_retry", "retry")
        with self.assertRaisesRegex(SdkError, "unexpected transport status 400"):
            retryable.shutdown(ScriptedTransport(400))
        self.assertEqual(retryable.delivery_health()["lifecycle"], "active")
        self.assertEqual(retryable.delivery_health()["failures"], 1)
        capture_log(retryable, "evt_after_failure", "capture remains open")
        self.assertEqual(retryable.pending_events(), 2)


if __name__ == "__main__":
    unittest.main()
