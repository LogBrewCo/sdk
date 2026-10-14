from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from logbrew_sdk import RecordingTransport, TransportResponse
from logbrew_sdk._automatic_delivery import AutomaticDeliveryController
from test_automatic_delivery import capture_log, create_client, wait_until


class WorkerJoinInterruptionTests(unittest.TestCase):
    def test_worker_exit_after_abort_restarts_without_losing_ownership(self) -> None:
        exiting, release = threading.Event(), threading.Event()
        controller = AutomaticDeliveryController(
            enabled=True, interval_seconds=60, queue_threshold=10, deliver=lambda: (0, 0)
        )

        def delayed_exit() -> None:
            exiting.set()
            if not release.wait(5):
                raise AssertionError("worker exit was not released")

        worker = None
        try:
            with patch.object(controller, "_run_worker", side_effect=delayed_exit):
                controller.event_retained(1)
                self.assertTrue(exiting.wait(5))
                worker = controller.begin_shutdown()
                controller.abort_shutdown(1)
                self.assertIs(controller._thread, worker)
            release.set()
            assert worker is not None
            worker.join(5)
            self.assertFalse(worker.is_alive())
            wait_until(lambda: controller._thread is not None and controller._thread is not worker)
        finally:
            release.set()
            current = controller.begin_shutdown()
            if current is not None:
                current.join(5)
                self.assertFalse(current.is_alive())
            controller.mark_closed()

    def test_interrupted_join_reuses_worker_and_preserves_later_capture(self) -> None:
        entered, release = threading.Event(), threading.Event()
        sent: list[str] = []

        class BlockingTransport:
            def send(self, api_key: str, body: str) -> TransportResponse:
                sent.append(body)
                entered.set()
                if not release.wait(5):
                    raise AssertionError("transport was not released")
                return TransportResponse(202, 1)

        client = create_client(
            BlockingTransport(), delivery_queue_threshold=1, delivery_interval_seconds=60
        )
        capture_log(client, "evt_before")
        worker = None
        try:
            self.assertTrue(entered.wait(5))
            worker = client._automatic_delivery._thread
            self.assertIsNotNone(worker)
            assert worker is not None
            error = KeyboardInterrupt("private failure text")
            with patch.object(worker, "join", side_effect=error), self.assertRaises(KeyboardInterrupt) as caught:
                client.shutdown()
            self.assertIs(caught.exception, error)
            self.assertIs(client._automatic_delivery._thread, worker)
            self.assertNotIn("private failure text", repr(client.delivery_health()))
            capture_log(client, "evt_after")
            self.assertEqual(client.pending_events(), 2)
            release.set()
            wait_until(lambda: client.pending_events() == 0)
            self.assertEqual(len(sent), 2)
        finally:
            release.set()
            client.shutdown(RecordingTransport.always_accept())
            if worker is not None:
                worker.join(5)
                self.assertFalse(worker.is_alive())
