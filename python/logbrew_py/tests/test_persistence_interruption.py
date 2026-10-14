from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest.mock import patch

from logbrew_sdk import RecordingTransport
from logbrew_sdk._persistence_crypto import QueueState
from logbrew_sdk._persistent_event_queue import PersistentEventQueue
from test_persistent_delivery import HAS_PERSISTENCE_CRYPTO, capture_log, create_persistent_client


@unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
class PersistenceInterruptionTests(unittest.TestCase):
    def test_partial_transactions_roll_back_and_reraise_original_interruption(self) -> None:
        for operation in ("append", "ack", "purge"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                self.check_operation(Path(directory).resolve(), operation)

    def check_operation(self, directory: Path, operation: str) -> None:
        client = create_persistent_client(directory)
        capture_log(client, "evt_before", "before interruption")
        queue = cast("PersistentEventQueue", client._queue)
        original_write = queue._write_state
        error = KeyboardInterrupt("private failure text")

        def write_then_interrupt(state: QueueState) -> None:
            original_write(state)
            raise error

        try:
            with patch.object(queue, "_write_state", side_effect=write_then_interrupt):
                with self.assertRaises(KeyboardInterrupt) as caught:
                    if operation == "append":
                        capture_log(client, "evt_interrupted", "interrupted admission")
                    elif operation == "ack":
                        client.flush(RecordingTransport.always_accept())
                    else:
                        client.purge_pending_events()
                self.assertIs(caught.exception, error)
            connection = queue._connection
            self.assertFalse(connection is not None and connection.in_transaction)
            self.assertEqual(client.recover_pending_events(), 1)
            capture_log(client, "evt_after", "after interruption")
            self.assertEqual(client.pending_events(), 2)
            self.assertNotIn("private failure text", repr(client.delivery_health()))
            self.assertEqual(client.shutdown(RecordingTransport.always_accept()).accepted_events, 2)
        finally:
            if not client.closed:
                queue.close()

    def test_interruption_after_commit_requires_confirmation_before_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = create_persistent_client(Path(directory).resolve())
            capture_log(client, "evt_before", "before interruption")
            queue = cast("PersistentEventQueue", client._queue)
            try:
                with (
                    patch("logbrew_sdk._persistent_event_queue.os.fsync", side_effect=KeyboardInterrupt()),
                    self.assertRaises(KeyboardInterrupt),
                ):
                    capture_log(client, "evt_committed", "committed admission")
                self.assertEqual(queue._pending_confirmation, ("append", 2))
                self.assertIsNone(queue._connection)
                self.assertEqual(client.recover_pending_events(), 2)
                self.assertIsNone(queue._pending_confirmation)
                self.assertEqual(client.shutdown(RecordingTransport.always_accept()).accepted_events, 2)
            finally:
                if not client.closed:
                    queue.close()
