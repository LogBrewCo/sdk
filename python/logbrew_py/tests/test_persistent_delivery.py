from __future__ import annotations

import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from logbrew_sdk import LogBrewClient, SdkError, TransportResponse

PERSISTENCE_KEY = bytes(range(32))


class ScriptedTransport:
    def __init__(self, *statuses: int) -> None:
        self._statuses = list(statuses)
        self.sent_bodies: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.sent_bodies.append(body)
        status = self._statuses.pop(0) if self._statuses else 202
        return TransportResponse(status_code=status, attempts=1)


def capture_log(client: LogBrewClient, event_id: str, message: str) -> None:
    client.log(
        event_id,
        "2026-07-14T10:00:00Z",
        {"message": message, "level": "info", "logger": "persistent-test"},
    )


def create_persistent_client(directory: Path, **kwargs: Any) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_private_test_key",
        sdk_name="logbrew-python-persistent",
        sdk_version="0.1.0",
        persistent_queue_directory=directory,
        persistent_queue_encryption_key=PERSISTENCE_KEY,
        **kwargs,
    )


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat(follow_symlinks=False).st_mode)


def close_queue_for_reopen(client: LogBrewClient) -> None:
    client._queue.close()


class CommitThenFailConnection:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def execute(self, *args: Any, **kwargs: Any) -> sqlite3.Cursor:
        return self._connection.execute(*args, **kwargs)

    def commit(self) -> None:
        self._connection.commit()
        raise sqlite3.OperationalError("injected ambiguous commit")

    def rollback(self) -> None:
        self._connection.rollback()

    def close(self) -> None:
        self._connection.close()


class PersistentQueueSafetyTests(unittest.TestCase):
    def test_path_must_be_normalized_absolute_and_parent_must_exist(self) -> None:
        with self.assertRaisesRegex(SdkError, "persistent queue directory must be a normalized absolute path"):
            create_persistent_client(Path("relative-queue"))

        with tempfile.TemporaryDirectory() as temporary:
            missing_parent = Path(temporary).resolve() / "missing" / "queue"
            with self.assertRaisesRegex(SdkError, "persistent queue parent directory is unavailable"):
                create_persistent_client(missing_parent)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks are unavailable")
    def test_symlink_components_and_final_symlink_fail_closed_without_path_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            real_parent = root / "real"
            real_parent.mkdir(mode=0o700)
            linked_parent = root / "linked"
            linked_parent.symlink_to(real_parent, target_is_directory=True)

            for directory in (linked_parent / "queue", root / "queue-link"):
                if directory == root / "queue-link":
                    target = root / "target"
                    target.mkdir(mode=0o700)
                    directory.symlink_to(target, target_is_directory=True)
                with self.subTest(directory=directory.name):
                    with self.assertRaises(SdkError) as raised:
                        create_persistent_client(directory)
                    self.assertEqual(raised.exception.code, "persistent_queue_error")
                    self.assertNotIn(str(root), str(raised.exception))

    def test_store_uses_owner_only_files_hides_sensitive_config_and_has_one_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory)
            capture_log(client, "evt_persisted", "persisted telemetry")

            self.assertEqual(mode(directory), 0o700)
            self.assertEqual({path.name for path in directory.iterdir()}, {".lock", "events.sqlite3"})
            self.assertEqual(mode(directory / ".lock"), 0o600)
            self.assertEqual(mode(directory / "events.sqlite3"), 0o600)
            stored_bytes = (directory / "events.sqlite3").read_bytes()
            self.assertNotIn(b"lb_private_test_key", stored_bytes)
            self.assertNotIn(PERSISTENCE_KEY, stored_bytes)
            self.assertNotIn(b"https://api.logbrew", stored_bytes)
            self.assertNotIn(b"logbrew-python-persistent", stored_bytes)
            self.assertNotIn(str(directory).encode(), stored_bytes)

            with self.assertRaises(SdkError) as raised:
                create_persistent_client(directory)
            self.assertEqual(raised.exception.code, "persistent_queue_error")
            self.assertNotIn(str(directory), str(raised.exception))

            client.purge_pending_events()
            client.shutdown(ScriptedTransport())
            replacement = create_persistent_client(directory)
            self.assertEqual(replacement.pending_events(), 0)
            replacement.shutdown(ScriptedTransport())

    def test_broad_permissions_and_unexpected_entries_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            broad = root / "broad"
            broad.mkdir(mode=0o755)
            os.chmod(broad, 0o755)
            with self.assertRaisesRegex(SdkError, "persistent queue directory must be owner-only"):
                create_persistent_client(broad)

            unexpected = root / "unexpected"
            unexpected.mkdir(mode=0o700)
            (unexpected / "notes.txt").write_text("not a queue file", encoding="utf-8")
            with self.assertRaisesRegex(SdkError, "persistent queue directory contains unexpected entries"):
                create_persistent_client(unexpected)

    @unittest.skipUnless(hasattr(os, "link"), "hard links are unavailable")
    def test_preexisting_hard_link_queue_files_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            outside = root / "outside"
            outside.write_bytes(b"")
            os.chmod(outside, 0o600)
            directory = root / "queue"
            directory.mkdir(mode=0o700)
            os.link(outside, directory / ".lock")

            with self.assertRaisesRegex(SdkError, "persistent queue contains an unsafe file"):
                create_persistent_client(directory)

    def test_directory_replacement_is_detected_before_new_disk_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory = root / "queue"
            moved = root / "moved"
            client = create_persistent_client(directory)
            capture_log(client, "evt_original", "original")
            directory.rename(moved)
            directory.mkdir(mode=0o700)

            with self.assertRaisesRegex(SdkError, "persistent queue directory identity changed"):
                capture_log(client, "evt_rejected", "must not reach replacement")

            self.assertEqual(list(directory.iterdir()), [])
            close_queue_for_reopen(client)


class PersistentQueueRecoveryTests(unittest.TestCase):
    def test_ambiguous_append_commit_is_confirmed_before_later_admission(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory)
            queue = cast(Any, client._queue)
            queue._connection = CommitThenFailConnection(queue._connection)

            with self.assertRaises(SdkError) as raised:
                capture_log(client, "evt_ambiguous", "committed before failure")
            self.assertEqual(raised.exception.code, "persistence_commit_error")

            capture_log(client, "evt_later", "confirmed before later admission")
            self.assertEqual(
                [event["id"] for event in client.events],
                ["evt_ambiguous", "evt_later"],
            )
            client.shutdown(ScriptedTransport(202))

    def test_ambiguous_accepted_prefix_commit_is_confirmed_before_any_resend(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory, max_retries=0)
            capture_log(client, "evt_accepted", "must not be resent")
            queue = cast(Any, client._queue)
            queue._connection = CommitThenFailConnection(queue._connection)
            first_transport = ScriptedTransport(202)

            with self.assertRaises(SdkError) as raised:
                client.flush(first_transport)
            self.assertEqual(raised.exception.code, "persistence_commit_error")

            second_transport = ScriptedTransport()
            response = client.flush(second_transport)
            self.assertEqual(response.status_code, 204)
            self.assertEqual(second_transport.sent_bodies, [])
            self.assertEqual(client.pending_events(), 0)
            client.shutdown(ScriptedTransport())

    def test_unavailable_commit_confirmation_blocks_later_queue_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory)
            queue = cast(Any, client._queue)
            queue._connection = CommitThenFailConnection(queue._connection)

            with self.assertRaisesRegex(SdkError, "could not be confirmed"):
                capture_log(client, "evt_ambiguous", "unknown outcome")

            with patch.object(
                queue,
                "_connect",
                side_effect=sqlite3.OperationalError("injected unavailable"),
            ), self.assertRaises(SdkError) as raised:
                capture_log(client, "evt_blocked", "must not bypass confirmation")
            self.assertEqual(raised.exception.code, "persistence_commit_error")

            self.assertEqual(
                [event["id"] for event in client.events],
                ["evt_ambiguous"],
            )
            client.shutdown(ScriptedTransport(202))

    def test_database_replacement_during_commit_confirmation_fails_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory = root / "queue"
            client = create_persistent_client(directory)
            capture_log(client, "evt_original", "original durable state")
            queue = cast(Any, client._queue)
            queue._connection = CommitThenFailConnection(queue._connection)
            with self.assertRaisesRegex(SdkError, "could not be confirmed"):
                capture_log(client, "evt_ambiguous", "committed before replacement")

            database = directory / "events.sqlite3"
            held_database = root / "held.sqlite3"
            database.rename(held_database)
            database.write_bytes(b"")
            os.chmod(database, 0o600)

            with self.assertRaises(SdkError) as raised:
                capture_log(client, "evt_rejected", "must not mutate replacement")
            self.assertEqual(raised.exception.code, "persistence_commit_error")
            self.assertNotIn(str(root), str(raised.exception))
            self.assertEqual(database.read_bytes(), b"")
            queue.close()

    @unittest.skipUnless(hasattr(os, "fork"), "fork is unavailable")
    def test_inherited_client_fails_before_disk_or_transport_and_parent_remains_usable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory)
            capture_log(client, "evt_parent", "owned by parent")
            read_fd, write_fd = os.pipe()
            child_pid = os.fork()
            if child_pid == 0:
                os.close(read_fd)
                outcome = "unexpected-success"
                try:
                    capture_log(client, "evt_child", "must be rejected")
                except SdkError as error:
                    outcome = error.code
                os.write(write_fd, outcome.encode("ascii"))
                os.close(write_fd)
                os._exit(0)

            os.close(write_fd)
            outcome = os.read(read_fd, 128).decode("ascii")
            os.close(read_fd)
            _, status = os.waitpid(child_pid, 0)

            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            self.assertEqual(outcome, "process_ownership_error")
            self.assertEqual([event["id"] for event in client.events], ["evt_parent"])
            capture_log(client, "evt_parent_later", "parent still owns the queue")
            transport = ScriptedTransport(202)
            client.shutdown(transport)
            self.assertEqual(
                [event["id"] for event in json.loads(transport.sent_bodies[0])["events"]],
                ["evt_parent", "evt_parent_later"],
            )

    def test_committed_events_recover_in_order_after_hard_process_exit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            script = """
import os
from pathlib import Path
from logbrew_sdk import LogBrewClient

client = LogBrewClient.create(
    api_key="lb_subprocess_key",
    sdk_name="logbrew-python-persistent",
    sdk_version="0.1.0",
    persistent_queue_directory=Path(os.environ["QUEUE_DIR"]),
    persistent_queue_encryption_key=bytes.fromhex(os.environ["QUEUE_KEY_HEX"]),
)
for index in range(3):
    client.log(
        f"evt_{index}",
        "2026-07-14T10:00:00Z",
        {"message": f"event {index}", "level": "info", "logger": "hard-exit"},
    )
os._exit(0)
"""
            env = {
                **os.environ,
                "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
                "QUEUE_DIR": str(directory),
                "QUEUE_KEY_HEX": PERSISTENCE_KEY.hex(),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            result = subprocess.run(
                [sys.executable, "-c", script],
                check=False,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")

            recovered = create_persistent_client(directory)
            self.assertEqual([event["id"] for event in recovered.events], ["evt_0", "evt_1", "evt_2"])
            self.assertGreater(recovered.pending_event_bytes(), 0)
            recovered.shutdown(ScriptedTransport(202))

    def test_failed_shutdown_reopens_capture_and_replacement_recovers_both_events(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory, max_retries=0)
            capture_log(client, "evt_before_shutdown", "before failed shutdown")

            with self.assertRaisesRegex(SdkError, "unexpected transport status 400"):
                client.shutdown(ScriptedTransport(400))
            capture_log(client, "evt_after_shutdown", "capture reopened")
            close_queue_for_reopen(client)

            recovered = create_persistent_client(directory, max_retries=0)
            self.assertEqual(
                [event["id"] for event in recovered.events],
                ["evt_before_shutdown", "evt_after_shutdown"],
            )
            recovered.shutdown(ScriptedTransport(202))

    def test_sdk_identity_mismatch_and_corrupt_rows_fail_without_deleting_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory)
            capture_log(client, "evt_original", "original")
            close_queue_for_reopen(client)

            with self.assertRaises(SdkError) as mismatched_sdk:
                LogBrewClient.create(
                    api_key="lb_other_key",
                    sdk_name="another-sdk",
                    sdk_version="9.9.9",
                    persistent_queue_directory=directory,
                    persistent_queue_encryption_key=PERSISTENCE_KEY,
                )
            self.assertEqual(mismatched_sdk.exception.code, "persistence_integrity_error")

            connection = sqlite3.connect(directory / "events.sqlite3")
            ciphertext = connection.execute(
                "SELECT ciphertext FROM events WHERE sequence = 1"
            ).fetchone()[0]
            connection.execute(
                "UPDATE events SET ciphertext = ? WHERE sequence = 1",
                (bytes([ciphertext[0] ^ 1]) + ciphertext[1:],),
            )
            connection.commit()
            connection.close()

            with self.assertRaises(SdkError) as raised:
                create_persistent_client(directory)
            self.assertEqual(raised.exception.code, "persistence_integrity_error")

    def test_accepted_prefix_persists_and_explicit_purge_securely_removes_pending_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "queue"
            client = create_persistent_client(directory, max_retries=0, max_batch_events=2)
            for index in range(3):
                capture_log(client, f"evt_{index}", f"event {index}")

            with self.assertRaisesRegex(SdkError, "unexpected transport status 400"):
                client.flush(ScriptedTransport(202, 400))
            self.assertEqual([event["id"] for event in client.events], ["evt_2"])
            close_queue_for_reopen(client)

            recovered = create_persistent_client(directory, max_retries=0, max_batch_events=2)
            self.assertEqual([event["id"] for event in recovered.events], ["evt_2"])
            self.assertEqual(recovered.purge_pending_events(), 1)
            self.assertEqual(recovered.purge_pending_events(), 0)
            self.assertEqual(recovered.pending_event_bytes(), 0)
            stored_bytes = (directory / "events.sqlite3").read_bytes()
            self.assertNotIn(b"evt_0", stored_bytes)
            self.assertNotIn(b"evt_1", stored_bytes)
            self.assertNotIn(b"evt_2", stored_bytes)
            recovered.shutdown(ScriptedTransport())


if __name__ == "__main__":
    unittest.main()
