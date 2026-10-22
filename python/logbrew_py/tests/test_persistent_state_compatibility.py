from __future__ import annotations

import tempfile
import unittest
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError
from test_persistent_delivery import HAS_PERSISTENCE_CRYPTO, create_persistent_client

if HAS_PERSISTENCE_CRYPTO:
    from logbrew_sdk._persistence_crypto import QueueState


def log(client: LogBrewClient, event_id: str) -> None:
    client.log(event_id, "2026-06-02T10:00:00Z", {"message": "queued", "level": "info"})


def crash(client: LogBrewClient) -> None:
    """Release the store without shutdown, like a process that stops abruptly."""
    client._queue.close()


def change_state(client: LogBrewClient, change: Callable[[QueueState], QueueState]) -> None:
    queue: Any = client._queue
    queue._ensure_ready()
    queue._require_connection().execute("BEGIN IMMEDIATE")
    queue._write_state(change(queue._read_state(check_count=False)))
    queue._commit_transaction(pending=("report", 0), message="state could not be confirmed")


def state_keys(client: LogBrewClient) -> set[str]:
    queue: Any = client._queue
    row = queue._require_connection().execute("SELECT nonce, ciphertext FROM queue_state WHERE id = 1").fetchone()
    crypto = queue._crypto
    return set(crypto._decrypt_json(row[0], row[1], crypto._state_aad()))


@unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
class PersistentStateCompatibilityTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve() / "queue"

    def test_optional_state_from_a_newer_sdk_is_ignored_and_kept(self) -> None:
        client = create_persistent_client(self.directory, max_queue_size=4)
        log(client, "evt_log_001")
        change_state(client, lambda state: replace(state, extra={"futureFeature": {"mode": 2}}))
        crash(client)

        reopened = create_persistent_client(self.directory, max_queue_size=4)
        self.assertEqual(reopened.pending_events(), 1)
        log(reopened, "evt_log_002")
        crash(reopened)

        again = create_persistent_client(self.directory, max_queue_size=4)
        self.assertIn("futureFeature", state_keys(again))
        transport = RecordingTransport.always_accept()
        again.shutdown(transport)
        self.assertEqual(sum(body.count('"evt_log_') for body in transport.sent_bodies), 2)

    def test_state_without_a_required_field_is_still_rejected(self) -> None:
        client = create_persistent_client(self.directory)
        queue: Any = client._queue
        crypto = queue._crypto
        nonce, ciphertext = crypto._encrypt(b'{"acceptedThrough":0,"lastAdmitted":0}', crypto._state_aad())
        queue._require_connection().execute("UPDATE queue_state SET nonce = ?, ciphertext = ?", (nonce, ciphertext))
        queue._require_connection().commit()
        crash(client)

        with self.assertRaises(SdkError) as raised:
            create_persistent_client(self.directory)
        self.assertEqual(raised.exception.code, "persistence_integrity_error")

    def test_a_drained_store_returns_to_the_state_earlier_versions_open(self) -> None:
        client = create_persistent_client(self.directory, max_queue_size=1)
        log(client, "evt_log_001")
        log(client, "evt_log_002")
        self.assertIn("clientReport", state_keys(client))
        client.flush(RecordingTransport.always_accept())
        client.flush(RecordingTransport.always_accept())
        self.assertEqual(state_keys(client), {"acceptedThrough", "lastAdmitted", "pendingBytes"})
        client.shutdown(RecordingTransport.always_accept())


if __name__ == "__main__":
    unittest.main()
