from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from logbrew_sdk import LogBrewClient, SdkError, TransportResponse

PERSISTENCE_KEY = bytes(range(32))
OTHER_PERSISTENCE_KEY = bytes(reversed(range(32)))


class ScriptedTransport:
    def __init__(self, *statuses: int) -> None:
        self._statuses = list(statuses)

    def send(self, api_key: str, body: str) -> TransportResponse:
        status = self._statuses.pop(0) if self._statuses else 202
        return TransportResponse(status_code=status, attempts=1)


def capture_log(client: LogBrewClient, event_id: str, message: str) -> None:
    client.log(
        event_id,
        "2026-07-14T10:00:00Z",
        {"message": message, "level": "info", "logger": "encrypted-test"},
    )


def create_encrypted_client(
    directory: Path,
    *,
    encryption_key: bytes = PERSISTENCE_KEY,
    **kwargs: Any,
) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_private_encrypted_test_key",
        sdk_name="logbrew-python-encrypted",
        sdk_version="0.1.0",
        persistent_queue_directory=directory,
        persistent_queue_encryption_key=encryption_key,
        **kwargs,
    )


def close_for_reopen(client: LogBrewClient) -> None:
    client._queue.close()


class EncryptedPersistentQueueContractTests(unittest.TestCase):
    def test_memory_default_does_not_load_the_optional_crypto_provider(self) -> None:
        with patch(
            "logbrew_sdk._persistence_crypto.importlib.import_module",
            side_effect=ImportError("injected missing optional dependency"),
        ):
            memory_client = LogBrewClient.create(
                api_key="lb_test_key",
                sdk_name="logbrew-python-memory",
                sdk_version="0.1.0",
            )
            capture_log(memory_client, "evt_memory", "memory remains dependency free")
            self.assertEqual(memory_client.pending_events(), 1)

            with tempfile.TemporaryDirectory() as temporary, self.assertRaises(SdkError) as raised:
                create_encrypted_client(Path(temporary).resolve() / "queue")
            self.assertEqual(raised.exception.code, "configuration_error")

    def test_persistence_requires_an_exact_caller_owned_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            with self.assertRaises(SdkError) as missing:
                LogBrewClient.create(
                    api_key="lb_test_key",
                    sdk_name="logbrew-python-encrypted",
                    sdk_version="0.1.0",
                    persistent_queue_directory=directory,
                )
            self.assertEqual(missing.exception.code, "configuration_error")

            for invalid in (b"", bytes(16), bytes(31), bytes(33), "not-bytes"):
                with self.subTest(length=len(invalid)), self.assertRaises(SdkError) as raised:
                    create_encrypted_client(directory, encryption_key=invalid)  # type: ignore[arg-type]
                self.assertEqual(raised.exception.code, "configuration_error")
                self.assertNotIn(str(directory), str(raised.exception))

    def test_store_contains_only_ciphertext_with_unique_nonces(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_encrypted_client(directory)
            capture_log(client, "evt_sensitive_one", "sensitive payload one")
            capture_log(client, "evt_sensitive_two", "sensitive payload two")

            database = directory / "events.sqlite3"
            stored = database.read_bytes()
            for forbidden in (
                PERSISTENCE_KEY,
                b"lb_private_encrypted_test_key",
                b"logbrew-python-encrypted",
                b"evt_sensitive_one",
                b"evt_sensitive_two",
                b"sensitive payload one",
                b"sensitive payload two",
                b"api.logbrew.co",
                str(directory).encode(),
            ):
                self.assertNotIn(forbidden, stored)

            connection = sqlite3.connect(database)
            try:
                event_columns = [row[1] for row in connection.execute("PRAGMA table_info(events)")]
                rows = connection.execute(
                    "SELECT sequence, nonce, ciphertext FROM events ORDER BY sequence"
                ).fetchall()
                state = connection.execute("SELECT nonce, ciphertext FROM queue_state WHERE id = 1").fetchone()
            finally:
                connection.close()

            self.assertEqual(event_columns, ["sequence", "nonce", "ciphertext"])
            self.assertEqual([row[0] for row in rows], [1, 2])
            self.assertEqual(len({row[1] for row in rows}), 2)
            self.assertTrue(all(len(row[1]) == 12 and row[2] for row in rows))
            self.assertIsNotNone(state)
            assert state is not None
            self.assertEqual(len(state[0]), 12)
            self.assertTrue(state[1])
            client.shutdown(ScriptedTransport(202))

    def test_wrong_key_and_ciphertext_tamper_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_encrypted_client(directory)
            capture_log(client, "evt_original", "original payload")
            close_for_reopen(client)

            with self.assertRaises(SdkError) as wrong_key:
                create_encrypted_client(directory, encryption_key=OTHER_PERSISTENCE_KEY)
            self.assertEqual(wrong_key.exception.code, "persistence_integrity_error")

            connection = sqlite3.connect(directory / "events.sqlite3")
            try:
                ciphertext = connection.execute(
                    "SELECT ciphertext FROM events WHERE sequence = 1"
                ).fetchone()[0]
                replacement = bytes([ciphertext[0] ^ 1]) + ciphertext[1:]
                connection.execute(
                    "UPDATE events SET ciphertext = ? WHERE sequence = 1",
                    (replacement,),
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(SdkError) as tampered:
                create_encrypted_client(directory)
            self.assertEqual(tampered.exception.code, "persistence_integrity_error")

    def test_authenticated_state_tamper_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_encrypted_client(directory)
            capture_log(client, "evt_original", "original payload")
            close_for_reopen(client)

            connection = sqlite3.connect(directory / "events.sqlite3")
            try:
                ciphertext = connection.execute(
                    "SELECT ciphertext FROM queue_state WHERE id = 1"
                ).fetchone()[0]
                connection.execute(
                    "UPDATE queue_state SET ciphertext = ? WHERE id = 1",
                    (ciphertext[:-1] + bytes([ciphertext[-1] ^ 1]),),
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(SdkError) as raised:
                create_encrypted_client(directory)
            self.assertEqual(raised.exception.code, "persistence_integrity_error")

    def test_authenticated_high_water_detects_missing_records(self) -> None:
        scenarios = {
            "sole": (1, (1,)),
            "first": (3, (1,)),
            "interior": (3, (2,)),
            "trailing": (3, (3,)),
        }
        for name, (event_count, removed) in scenarios.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary).resolve() / "queue"
                client = create_encrypted_client(directory)
                for index in range(event_count):
                    capture_log(client, f"evt_{index + 1}", f"payload {index + 1}")
                close_for_reopen(client)

                connection = sqlite3.connect(directory / "events.sqlite3")
                try:
                    connection.executemany(
                        "DELETE FROM events WHERE sequence = ?",
                        ((sequence,) for sequence in removed),
                    )
                    connection.commit()
                finally:
                    connection.close()

                with self.assertRaises(SdkError) as raised:
                    create_encrypted_client(directory)
                self.assertEqual(raised.exception.code, "persistence_integrity_error")

    @unittest.skipUnless(hasattr(os, "link"), "hard links are unavailable")
    def test_database_hardlink_and_live_lock_replacement_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            hardlink_directory = root / "hardlink-queue"
            client = create_encrypted_client(hardlink_directory)
            capture_log(client, "evt_hardlink", "must remain encrypted")
            close_for_reopen(client)
            os.link(hardlink_directory / "events.sqlite3", root / "database-copy")

            with self.assertRaises(SdkError) as hardlink:
                create_encrypted_client(hardlink_directory)
            self.assertEqual(hardlink.exception.code, "persistent_queue_error")

            live_directory = root / "live-queue"
            live = create_encrypted_client(live_directory)
            capture_log(live, "evt_before", "before lock replacement")
            original_lock = root / "original-lock"
            (live_directory / ".lock").rename(original_lock)
            (live_directory / ".lock").write_bytes(b"")
            os.chmod(live_directory / ".lock", 0o600)

            with self.assertRaises(SdkError) as replacement:
                capture_log(live, "evt_rejected", "must not reach replacement")
            self.assertEqual(replacement.exception.code, "persistent_queue_error")
            close_for_reopen(live)
            (live_directory / ".lock").unlink()
            original_lock.rename(live_directory / ".lock")
            recovered = create_encrypted_client(live_directory)
            self.assertEqual([event["id"] for event in recovered.events], ["evt_before"])
            recovered.shutdown(ScriptedTransport(202))

    def test_explicit_recovery_revalidates_without_reordering_or_exposing_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_encrypted_client(directory)
            capture_log(client, "evt_one", "first")
            capture_log(client, "evt_two", "second")

            self.assertEqual(client.recover_pending_events(), 2)
            self.assertEqual([event["id"] for event in client.events], ["evt_one", "evt_two"])
            client.shutdown(ScriptedTransport(202))

    def test_runtime_database_read_failure_uses_a_content_free_sdk_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = create_encrypted_client(Path(temporary).resolve() / "queue")
            capture_log(client, "evt_runtime_failure", "must not reach a driver error")
            queue: Any = client._queue
            connection = queue._connection
            assert connection is not None
            connection.close()

            with self.assertRaises(SdkError) as raised:
                client.recover_pending_events()

            self.assertEqual(raised.exception.code, "persistent_queue_error")
            self.assertEqual(raised.exception.message, "persistent queue read failed")
            self.assertNotIn("sqlite", str(raised.exception).lower())
            queue.close()


if __name__ == "__main__":
    unittest.main()
