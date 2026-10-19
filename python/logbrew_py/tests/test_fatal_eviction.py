from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from logbrew_sdk import EventDrop, IssueAttributes, LogBrewClient, RecordingTransport, SdkError

TIMESTAMP = "2026-06-02T10:00:00Z"
HAS_PERSISTENCE_CRYPTO = importlib.util.find_spec("cryptography") is not None
FATAL: IssueAttributes = {"title": "App crashed", "level": "fatal", "message": "worker crashed"}


def create_client(drops: list[EventDrop] | None = None, **kwargs: Any) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-fatal-eviction",
        sdk_version="0.1.0",
        max_retries=0,
        on_event_dropped=None if drops is None else drops.append,
        **kwargs,
    )


def log(client: LogBrewClient, event_id: str, message: str = "queued") -> None:
    client.log(event_id, TIMESTAMP, {"message": message, "level": "info"})


def queued_ids(client: LogBrewClient) -> list[str]:
    return [event["id"] for event in json.loads(client.preview_json())["events"]]


def event_bytes(client: LogBrewClient, index: int) -> int:
    event = json.loads(client.preview_json())["events"][index]
    return len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class FatalEvictionTests(unittest.TestCase):
    def test_a_crash_report_at_the_count_limit_evicts_the_oldest_non_crash_event(self) -> None:
        drops: list[EventDrop] = []
        client = create_client(drops, max_queue_size=3)
        log(client, "evt_log_001")
        client.issue("evt_fatal_001", TIMESTAMP, FATAL)
        log(client, "evt_log_002")

        client.issue("evt_fatal_002", TIMESTAMP, FATAL)

        self.assertEqual(queued_ids(client), ["evt_fatal_001", "evt_log_002", "evt_fatal_002"])
        self.assertEqual(drops, [EventDrop("evt_log_001", "log", "evicted_for_fatal", 1)])
        self.assertEqual(client.dropped_events_by_reason(), {"evicted_for_fatal": 1})

    def test_evictions_reach_logbrew_in_the_next_client_report(self) -> None:
        client = create_client(max_queue_size=1)
        log(client, "evt_log_001")
        client.issue("evt_fatal_001", TIMESTAMP, FATAL)
        transport = RecordingTransport.always_accept()

        client.flush(transport)

        body = json.loads(transport.sent_bodies[0])
        self.assertEqual([event["id"] for event in body["events"]], ["evt_fatal_001"])
        self.assertEqual(body["client_report"], {"dropped_events": {"evicted_for_fatal": 1}})

    def test_a_drop_callback_cannot_refill_the_room_an_eviction_made(self) -> None:
        client: LogBrewClient

        def refill(drop: EventDrop) -> None:
            if drop.reason == "evicted_for_fatal":
                log(client, "evt_log_reentry")

        client = LogBrewClient.create(
            api_key="lb_test_key",
            sdk_name="logbrew-python-fatal-eviction",
            sdk_version="0.1.0",
            max_queue_size=1,
            on_event_dropped=refill,
        )
        log(client, "evt_log_001")
        client.issue("evt_fatal_001", TIMESTAMP, FATAL)

        self.assertEqual(queued_ids(client), ["evt_fatal_001"])
        self.assertEqual(client.dropped_events_by_reason()["queue_overflow"], 1)

    def test_a_crash_report_at_the_byte_limit_evicts_oldest_events_until_it_fits(self) -> None:
        probe = create_client()
        log(probe, "evt_log_001")
        probe.issue("evt_fatal_001", TIMESTAMP, FATAL)
        log_bytes, fatal_bytes = event_bytes(probe, 0), event_bytes(probe, 1)
        self.assertTrue(log_bytes < fatal_bytes <= log_bytes * 2)
        drops: list[EventDrop] = []
        client = create_client(drops, max_queue_bytes=log_bytes * 3)
        for event_id in ("evt_log_001", "evt_log_002", "evt_log_003"):
            log(client, event_id)

        client.issue("evt_fatal_001", TIMESTAMP, FATAL)

        self.assertEqual(queued_ids(client), ["evt_log_003", "evt_fatal_001"])
        self.assertEqual(
            [(drop.event_id, drop.reason) for drop in drops],
            [("evt_log_001", "evicted_for_fatal"), ("evt_log_002", "evicted_for_fatal")],
        )
        self.assertEqual(client.pending_event_bytes(), log_bytes + fatal_bytes)

    def test_a_queue_of_crash_reports_rejects_the_newest_without_partial_eviction(self) -> None:
        drops: list[EventDrop] = []
        client = create_client(drops, max_queue_size=2)
        client.issue("evt_fatal_001", TIMESTAMP, FATAL)
        client.issue("evt_fatal_002", TIMESTAMP, FATAL)
        client.issue("evt_fatal_003", TIMESTAMP, FATAL)

        self.assertEqual(queued_ids(client), ["evt_fatal_001", "evt_fatal_002"])
        self.assertEqual([(drop.event_id, drop.reason) for drop in drops], [("evt_fatal_003", "queue_overflow")])

    def test_a_non_crash_event_at_a_full_queue_is_still_rejected(self) -> None:
        drops: list[EventDrop] = []
        client = create_client(drops, max_queue_size=1)
        log(client, "evt_log_001")
        client.issue("evt_error_001", TIMESTAMP, {**FATAL, "level": "error"})

        self.assertEqual(queued_ids(client), ["evt_log_001"])
        self.assertEqual([drop.event_id for drop in drops], ["evt_error_001"])

    def test_a_crash_report_never_evicts_events_in_a_body_waiting_for_retry(self) -> None:
        drops: list[EventDrop] = []
        client = create_client(drops, max_queue_size=3, max_batch_events=2)
        for event_id in ("evt_log_001", "evt_log_002", "evt_log_003"):
            log(client, event_id)
        transport = RecordingTransport([{"status_code": 503}, {"status_code": 202}, {"status_code": 202}])
        with self.assertRaises(SdkError):
            client.flush(transport)

        client.issue("evt_fatal_001", TIMESTAMP, FATAL)
        client.issue("evt_fatal_002", TIMESTAMP, FATAL)
        client.flush(transport)

        self.assertEqual(
            [(drop.event_id, drop.reason) for drop in drops],
            [("evt_log_003", "evicted_for_fatal"), ("evt_fatal_002", "queue_overflow")],
        )
        sent = [[event["id"] for event in json.loads(body)["events"]] for body in transport.sent_bodies]
        self.assertEqual(sent, [["evt_log_001", "evt_log_002"], ["evt_log_001", "evt_log_002"], ["evt_fatal_001"]])

    @unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
    def test_a_persistent_queue_keeps_rejecting_at_a_full_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            drops: list[EventDrop] = []
            client = create_client(
                drops,
                max_queue_size=1,
                persistent_queue_directory=Path(temporary).resolve() / "queue",
                persistent_queue_encryption_key=bytes(32),
            )
            log(client, "evt_log_001")
            client.issue("evt_fatal_001", TIMESTAMP, FATAL)

            self.assertEqual([(drop.event_id, drop.reason) for drop in drops], [("evt_fatal_001", "queue_overflow")])
            client.shutdown(RecordingTransport.always_accept())


if __name__ == "__main__":
    unittest.main()
