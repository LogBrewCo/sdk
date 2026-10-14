from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from logbrew_sdk import RecordingTransport, TransportResponse
from test_automatic_delivery import capture_log, create_client, wait_until


class WorkerAbortTests(unittest.TestCase):
    def test_worker_abort_pauses_without_losing_queue_or_private_text(self) -> None:
        for error in (KeyboardInterrupt("private failure text"), SystemExit(7)):
            with self.subTest(error=type(error).__name__):
                self.check_abort(error)

    def check_abort(self, error: BaseException) -> None:
        captured = threading.Event()
        failures: list[BaseException] = []
        sent: list[str] = []

        class AbortingTransport:
            def send(self, api_key: str, body: str) -> TransportResponse:
                sent.append(body)
                raise error

        def exception_hook(args: threading.ExceptHookArgs) -> None:
            if args.exc_value is not None:
                failures.append(args.exc_value)
            captured.set()

        client = create_client(
            AbortingTransport(), delivery_queue_threshold=1, delivery_interval_seconds=60
        )
        try:
            with patch("threading.excepthook", side_effect=exception_hook):
                capture_log(client, "evt_before")
                self.assertTrue(captured.wait(5))
                wait_until(lambda: client._automatic_delivery._thread is None)
            self.assertEqual(failures, [error])
            health = client.delivery_health()
            self.assertEqual(health.lifecycle, "paused")
            self.assertEqual(health.pause_reason, "internal")
            self.assertFalse(health.delivery_in_flight)
            self.assertNotIn("private failure text", repr(health))
            self.assertEqual(client.pending_events(), 1)
            capture_log(client, "evt_after")
            self.assertEqual(client.pending_events(), 2)
            self.assertEqual(len(sent), 1)
            accepted = RecordingTransport.always_accept()
            self.assertEqual(client.shutdown(accepted).accepted_events, 2)
            self.assertEqual(accepted.sent_bodies[0], sent[0])
        finally:
            if not client.closed:
                client.shutdown(RecordingTransport.always_accept())
