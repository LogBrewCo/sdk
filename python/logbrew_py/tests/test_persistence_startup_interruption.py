from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from logbrew_sdk import RecordingTransport
from logbrew_sdk._persistent_event_queue import PersistentEventQueue
from test_persistent_delivery import HAS_PERSISTENCE_CRYPTO, capture_log, create_persistent_client


@unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
class PersistenceStartupInterruptionTests(unittest.TestCase):
    def test_interruption_during_connection_setup_closes_partial_connection(self) -> None:
        connect = sqlite3.connect
        connections: list[sqlite3.Connection] = []

        def tracked_connect(*args: object, **kwargs: object) -> sqlite3.Connection:
            connection = connect(*args, **kwargs)
            connections.append(connection)
            return connection

        with tempfile.TemporaryDirectory() as directory:
            error = KeyboardInterrupt()
            with (
                patch("logbrew_sdk._persistent_event_queue.sqlite3.connect", side_effect=tracked_connect),
                patch.object(PersistentEventQueue, "_assert_storage_identity", side_effect=[None, error]),
                self.assertRaises(KeyboardInterrupt),
            ):
                create_persistent_client(Path(directory).resolve())
            self.assertEqual(len(connections), 1)
            try:
                with self.assertRaises(sqlite3.ProgrammingError):
                    connections[0].execute("SELECT 1")
            finally:
                connections[0].close()

    def test_interrupted_startup_releases_lock_and_preserves_existing_encrypted_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve()
            client = create_persistent_client(path)
            capture_log(client, "evt_retained", "retained across interrupted startup")
            client._queue.close()
            error = KeyboardInterrupt("private failure text")
            with (
                patch.object(PersistentEventQueue, "_validate_recovery", side_effect=error),
                self.assertRaises(KeyboardInterrupt) as caught,
            ):
                create_persistent_client(path)
            self.assertIs(caught.exception, error)
            reopened = create_persistent_client(path)
            try:
                self.assertEqual(reopened.pending_events(), 1)
                self.assertEqual(reopened.shutdown(RecordingTransport.always_accept()).accepted_events, 1)
            finally:
                if not reopened.closed:
                    reopened._queue.close()
