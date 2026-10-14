from __future__ import annotations

import threading
import unittest

from logbrew_sdk import TransportResponse
from test_delivery import ScriptedTransport, capture_log, create_client


class InterruptingTransport:
    def __init__(self, error: BaseException) -> None:
        self.error = error
        self.sent_bodies: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.sent_bodies.append(body)
        raise self.error


class ShutdownInterruptionTests(unittest.TestCase):
    def test_another_thread_can_retry_after_shutdown_interruption(self) -> None:
        client = create_client()
        capture_log(client, "evt_before", "before interruption")
        entered, release = threading.Event(), threading.Event()
        outcomes: list[object] = []

        class BlockingInterruption:
            def send(self, api_key: str, body: str) -> TransportResponse:
                entered.set()
                if not release.wait(5):
                    raise AssertionError("transport was not released")
                raise KeyboardInterrupt()

        def close() -> None:
            try:
                client.shutdown(BlockingInterruption())
            except KeyboardInterrupt:
                outcomes.append("interrupted")

        worker = threading.Thread(target=close)
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(outcomes, ["interrupted"])
        response: list[TransportResponse] = []
        retry = threading.Thread(target=lambda: response.append(client.flush(ScriptedTransport(202))))
        retry.start()
        retry.join(5)
        self.assertFalse(retry.is_alive())
        self.assertEqual(response[0].accepted_events, 1)
        client.shutdown(ScriptedTransport())

    def test_transport_interruption_reopens_and_preserves_exact_retry_body(self) -> None:
        for error in (KeyboardInterrupt("private failure text"), SystemExit(7)):
            with self.subTest(error=type(error).__name__):
                client = create_client()
                capture_log(client, "evt_before", "before interruption")
                transport = InterruptingTransport(error)
                with self.assertRaises(type(error)) as caught:
                    client.shutdown(transport)
                self.assertIs(caught.exception, error)
                self.assertFalse(client.closed)
                self.assertEqual(client.pending_events(), 1)
                self.assertNotIn("private failure text", str(client.delivery_health()))
                capture_log(client, "evt_after", "after interruption")
                accepted = ScriptedTransport(202, 202)
                response = client.shutdown(accepted)
                self.assertEqual(accepted.sent_bodies[0], transport.sent_bodies[0])
                self.assertEqual(response.accepted_events, 2)
                self.assertTrue(client.closed)
                self.assertEqual(client.pending_events(), 0)
