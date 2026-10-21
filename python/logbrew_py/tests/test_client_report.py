from __future__ import annotations

import json
import re
import threading
import unittest
from pathlib import Path
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    ScriptedTransportResponse,
    SdkError,
    TransportError,
    TransportResponse,
)

FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "valid-batch-client-report.json"


def create_client(**kwargs: Any) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-client-report",
        sdk_version="0.1.0",
        max_retries=0,
        **kwargs,
    )


def log(client: LogBrewClient, event_id: str, message: str = "queued") -> None:
    client.log(event_id, "2026-06-02T10:00:00Z", {"message": message, "level": "info"})


def without_id(report: Any) -> Any:
    if report is None:
        return None
    stripped = dict(report)
    assert re.fullmatch(r"[0-9a-f]{32}", stripped.pop("report_id"))
    return stripped


def report_ids(transport: RecordingTransport) -> list[Any]:
    return [(json.loads(body).get("client_report") or {}).get("report_id") for body in transport.sent_bodies]


def reports(transport: RecordingTransport) -> list[Any]:
    return [without_id(json.loads(body).get("client_report")) for body in transport.sent_bodies]


class ClientReportTests(unittest.TestCase):
    def test_drop_counts_ride_in_the_next_batch_and_clear_after_a_2xx(self) -> None:
        client = create_client(max_queue_size=1)
        log(client, "evt_log_001")
        log(client, "evt_log_002")
        log(client, "evt_log_003")
        log(client, "evt_log_big", "x" * (300 * 1024))
        transport = RecordingTransport.always_accept()

        client.flush(transport)
        log(client, "evt_log_004")
        client.flush(transport)

        self.assertEqual(
            reports(transport),
            [{"dropped_events": {"queue_overflow": 2, "event_too_large": 1}}, None],
        )
        self.assertEqual(client.dropped_events_by_reason()["queue_overflow"], 2)

    def test_report_matches_the_shared_wire_shape(self) -> None:
        client = create_client(max_queue_size=1)
        log(client, "evt_log_001")
        log(client, "evt_log_002")
        transport = RecordingTransport.always_accept()
        client.flush(transport)

        body = json.loads(transport.sent_bodies[0])
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(list(body), list(fixture))
        self.assertEqual(set(body["client_report"]), set(fixture["client_report"]))

    def test_a_batch_without_drops_carries_no_client_report(self) -> None:
        client = create_client()
        log(client, "evt_log_001")
        transport = RecordingTransport.always_accept()
        client.flush(transport)

        self.assertEqual(list(json.loads(transport.sent_bodies[0])), ["sdk", "events"])

    def test_drop_counts_stay_pending_after_a_failure_and_the_resent_body_reports_them_once(self) -> None:
        failures: tuple[ScriptedTransportResponse | Exception, ...] = (
            {"status_code": 503},
            TransportError.network("offline"),
        )
        for failure in failures:
            with self.subTest(failure=failure):
                client = create_client(max_queue_size=1)
                log(client, "evt_log_001")
                log(client, "evt_log_002")
                transport = RecordingTransport([failure, {"status_code": 202}, {"status_code": 202}])

                with self.assertRaises(SdkError):
                    client.flush(transport)
                client.flush(transport)
                log(client, "evt_log_003")
                client.flush(transport)

                self.assertEqual(transport.sent_bodies[1], transport.sent_bodies[0])
                self.assertEqual(
                    reports(transport),
                    [
                        {"dropped_events": {"queue_overflow": 1}},
                        {"dropped_events": {"queue_overflow": 1}},
                        None,
                    ],
                )

    def test_a_report_resent_in_a_different_batch_keeps_its_report_id(self) -> None:
        client = create_client(max_queue_size=1)
        log(client, "evt_log_001")
        log(client, "evt_log_002")
        transport = RecordingTransport(
            [TransportError.network("offline"), {"status_code": 202}, {"status_code": 202}]
        )

        with self.assertRaises(SdkError):
            client.flush(transport)
        client.purge_pending_events()
        log(client, "evt_log_003")
        client.flush(transport)
        log(client, "evt_log_004")
        log(client, "evt_log_005")
        client.flush(transport)

        ids = report_ids(transport)
        self.assertNotEqual(transport.sent_bodies[1], transport.sent_bodies[0])
        self.assertEqual(ids[1], ids[0])
        self.assertNotEqual(ids[2], ids[0])
        self.assertEqual(reports(transport), [{"dropped_events": {"queue_overflow": 1}}] * 3)

    def test_drops_during_an_in_flight_batch_stay_pending_for_the_next_batch(self) -> None:
        client = create_client(max_queue_size=1)
        log(client, "evt_log_001")
        log(client, "evt_log_002")
        sent: list[Any] = []
        in_flight = threading.Event()
        release = threading.Event()

        class BlockingTransport:
            def send(self, _api_key: str, body: str) -> TransportResponse:
                sent.append(without_id(json.loads(body).get("client_report")))
                if len(sent) == 1:
                    in_flight.set()
                    release.wait(5)
                return TransportResponse(status_code=202, attempts=1)

        transport = BlockingTransport()
        worker = threading.Thread(target=client.flush, args=(transport,))
        worker.start()
        self.assertTrue(in_flight.wait(5))
        log(client, "evt_log_003")
        log(client, "evt_log_004")
        release.set()
        worker.join(5)
        log(client, "evt_log_005")
        client.flush(transport)

        self.assertEqual(
            sent,
            [{"dropped_events": {"queue_overflow": 1}}, {"dropped_events": {"queue_overflow": 2}}],
        )

    def test_a_client_report_never_pushes_a_batch_over_max_batch_bytes(self) -> None:
        probe = create_client()
        log(probe, "evt_log_001", "m" * 200)
        probe_transport = RecordingTransport.always_accept()
        probe.flush(probe_transport)
        exact_bytes = len(probe_transport.sent_bodies[0].encode("utf-8"))

        client = create_client(max_batch_bytes=exact_bytes)
        log(client, "evt_log_001", "m" * 200)
        log(client, "evt_log_big", "x" * exact_bytes)
        transport = RecordingTransport.always_accept()
        client.flush(transport)
        log(client, "evt_log_002", "short")
        client.flush(transport)

        self.assertTrue(all(len(body.encode("utf-8")) <= exact_bytes for body in transport.sent_bodies))
        self.assertEqual(reports(transport), [None, {"dropped_events": {"event_too_large": 1}}])


if __name__ == "__main__":
    unittest.main()
