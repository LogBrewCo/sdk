from __future__ import annotations

import json
import threading
import time
import unittest

from logbrew_sdk import LogBrewClient, TransportResponse


class TimedTransport:
    def __init__(self) -> None:
        self.sends: list[tuple[float, int]] = []
        self.first_send = threading.Event()

    def send(self, _api_key: str, body: str) -> TransportResponse:
        self.sends.append((time.monotonic(), len(json.loads(body)["events"])))
        self.first_send.set()
        return TransportResponse(status_code=202, attempts=1)


def create_client(transport: TimedTransport) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-latency",
        sdk_version="0.1.0",
        transport=transport,
    )


def log(client: LogBrewClient, event_id: str) -> None:
    client.log(event_id, "2026-06-02T10:00:00Z", {"message": "checkout ready", "level": "info"})


class DeliveryLatencyTests(unittest.TestCase):
    def test_a_single_event_is_delivered_within_about_one_second_by_default(self) -> None:
        transport = TimedTransport()
        client = create_client(transport)
        captured_at = time.monotonic()
        log(client, "evt_log_001")

        delivered = transport.first_send.wait(1.5)

        client.shutdown()
        self.assertTrue(delivered, "the default interval must deliver one event within 1.5 s")
        self.assertGreaterEqual(transport.sends[0][0] - captured_at, 0.9)

    def test_a_burst_inside_the_delivery_window_still_goes_out_as_one_request(self) -> None:
        transport = TimedTransport()
        client = create_client(transport)
        for index in range(20):
            log(client, f"evt_log_{index:03d}")

        delivered = transport.first_send.wait(1.5)

        client.shutdown()
        self.assertTrue(delivered)
        self.assertEqual(transport.sends[0][1], 20)


if __name__ == "__main__":
    unittest.main()
