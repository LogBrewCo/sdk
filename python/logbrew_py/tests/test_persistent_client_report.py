from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError
from test_persistent_delivery import (
    HAS_PERSISTENCE_CRYPTO,
    PERSISTENCE_KEY,
    CommitThenFailConnection,
    ScriptedTransport,
)


def create_client(directory: Path, **kwargs: Any) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-client-report",
        sdk_version="0.1.0",
        max_retries=0,
        max_queue_size=1,
        breadcrumbs=False,
        persistent_queue_directory=directory,
        persistent_queue_encryption_key=PERSISTENCE_KEY,
        **kwargs,
    )


def log(client: LogBrewClient, event_id: str, message: str = "queued") -> None:
    client.log(event_id, "2026-06-02T10:00:00Z", {"message": message, "level": "info"})


def crash(client: LogBrewClient) -> None:
    """Release the store without shutdown, like a process that exits without cleanup."""
    client._queue.close()


def client_reports(transport: RecordingTransport | ScriptedTransport) -> list[Any]:
    return [json.loads(body).get("client_report") for body in transport.sent_bodies]


@unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
class PersistentClientReportTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve() / "queue"

    def test_unreported_drop_counts_survive_a_crash(self) -> None:
        client = create_client(self.directory)
        log(client, "evt_log_001")
        log(client, "evt_log_002")
        log(client, "evt_log_big", "x" * (300 * 1024))
        crash(client)

        restarted = create_client(self.directory)
        transport = RecordingTransport.always_accept()
        restarted.flush(transport)

        [report] = client_reports(transport)
        self.assertEqual(report["dropped_events"], {"queue_overflow": 1, "event_too_large": 1})
        self.assertEqual(restarted.dropped_events(), 0)
        log(restarted, "evt_log_003")
        restarted.flush(transport)
        self.assertIsNone(client_reports(transport)[1])
        restarted.shutdown(transport)

    def test_a_report_sent_before_a_crash_keeps_its_report_id(self) -> None:
        client = create_client(self.directory)
        log(client, "evt_log_001")
        log(client, "evt_log_002")
        failed = ScriptedTransport(503)
        with self.assertRaises(SdkError):
            client.flush(failed)
        log(client, "evt_log_003")
        crash(client)

        restarted = create_client(self.directory)
        transport = RecordingTransport.always_accept()
        restarted.flush(transport)
        log(restarted, "evt_log_004")
        restarted.flush(transport)

        [sent_before_crash] = client_reports(failed)
        resent, carried_later = client_reports(transport)
        self.assertEqual(resent, sent_before_crash)
        self.assertEqual(resent["dropped_events"], {"queue_overflow": 1})
        # The drop of evt_log_003 waited under a new report ID.
        self.assertEqual(carried_later["dropped_events"], {"queue_overflow": 1})
        self.assertNotEqual(carried_later["report_id"], resent["report_id"])
        restarted.shutdown(transport)

        reopened = create_client(self.directory)
        log(reopened, "evt_log_005")
        final = RecordingTransport.always_accept()
        reopened.shutdown(final)
        self.assertEqual(client_reports(final), [None])

    def test_a_drop_burst_saves_at_most_once_a_second_and_shutdown_saves_the_rest(self) -> None:
        client = create_client(self.directory)
        log(client, "evt_log_001")
        queue: Any = client._queue
        saves: list[dict[str, Any]] = []
        original_save = queue.save_client_report

        def record_save(state: dict[str, Any]) -> None:
            saves.append(state)
            original_save(state)

        with (
            patch.object(queue, "save_client_report", side_effect=record_save),
            patch("logbrew_sdk.time.monotonic", side_effect=[100.0, 100.2, 100.5, 101.1, 101.2] + [102.0] * 10),
        ):
            for index in range(5):
                log(client, f"evt_dropped_{index}")
            self.assertEqual([state["unreported"] for state in saves], [{"queue_overflow": 1}, {"queue_overflow": 4}])
            with self.assertRaises(SdkError):
                client.shutdown(ScriptedTransport(400))
        self.assertEqual(saves[-1]["pending"]["dropped_events"], {"queue_overflow": 5})
        crash(client)

        restarted = create_client(self.directory)
        transport = RecordingTransport.always_accept()
        restarted.shutdown(transport)
        self.assertEqual(client_reports(transport)[0]["dropped_events"], {"queue_overflow": 5})

    def test_unreadable_saved_counts_are_ignored(self) -> None:
        client = create_client(self.directory)
        client._queue.save_client_report(
            {
                "pending": {"report_id": "short", "dropped_events": {"queue_overflow": 2}},
                "unreported": {"Not-A-Reason": 1, "queue_overflow": "3", "event_too_large": 0, "evicted_for_fatal": 2},
            }
        )
        crash(client)

        restarted = create_client(self.directory)
        log(restarted, "evt_log_001")
        transport = RecordingTransport.always_accept()
        restarted.shutdown(transport)
        self.assertEqual(client_reports(transport)[0]["dropped_events"], {"evicted_for_fatal": 2})

    def test_a_failed_save_never_blocks_capture(self) -> None:
        client = create_client(self.directory)
        log(client, "evt_log_001")
        failure = SdkError("persistent_queue_error", "persistent queue is unavailable")
        with patch.object(client._queue, "save_client_report", side_effect=failure):
            log(client, "evt_log_002")
            self.assertEqual(client.dropped_events(), 1)
            transport = RecordingTransport.always_accept()
            client.flush(transport)
        self.assertEqual(client_reports(transport)[0]["dropped_events"], {"queue_overflow": 1})
        client.shutdown(transport)

    def test_an_interrupted_save_is_settled_before_later_capture(self) -> None:
        for committed in (True, False):
            with self.subTest(committed=committed):
                directory = self.directory.with_name(f"queue-{committed}")
                client = create_client(directory)
                log(client, "evt_log_001")
                queue: Any = client._queue
                queue._connection = CommitThenFailConnection(queue._connection, commit=committed)
                log(client, "evt_log_002")
                self.assertEqual(queue._pending_confirmation, ("report", 0))
                transport = RecordingTransport.always_accept()
                client.shutdown(transport)
                self.assertEqual(client_reports(transport)[0]["dropped_events"], {"queue_overflow": 1})


if __name__ == "__main__":
    unittest.main()
