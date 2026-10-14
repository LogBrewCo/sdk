from __future__ import annotations

import unittest

from logbrew_sdk import TransportResponse
from test_delivery import capture_log, create_client


class ManualFlushInterruptionTests(unittest.TestCase):
    def test_interruption_reports_failure_and_preserves_retry_prefix(self) -> None:
        for owned in (False, True):
            for error in (KeyboardInterrupt("private failure text"), SystemExit(7)):
                with self.subTest(owned=owned, error=type(error).__name__):
                    self.check_interruption(owned, error)

    def check_interruption(self, owned: bool, error: BaseException) -> None:
        sent: list[str] = []

        class InterruptOnce:
            def send(self, api_key: str, body: str) -> TransportResponse:
                sent.append(body)
                if len(sent) == 1:
                    raise error
                return TransportResponse(202, 1)

        transport = InterruptOnce()
        client = create_client(transport=transport if owned else None, automatic_delivery=False)
        capture_log(client, "evt_before", "before interruption")
        with self.assertRaises(type(error)) as caught:
            client.flush(None if owned else transport)
        self.assertIs(caught.exception, error)
        health = client.delivery_health()
        self.assertEqual(health.last_outcome, "paused" if owned else "failed")
        self.assertEqual(health.pause_reason, "internal" if owned else "none")
        self.assertFalse(health.delivery_in_flight)
        self.assertNotIn("private failure text", repr(health))
        self.assertEqual(client.pending_events(), 1)
        capture_log(client, "evt_after", "after interruption")
        self.assertEqual(client.flush(None if owned else transport).accepted_events, 2)
        self.assertEqual(sent[0], sent[1])
        self.assertEqual(client.pending_events(), 0)
        client.shutdown(None if owned else transport)
