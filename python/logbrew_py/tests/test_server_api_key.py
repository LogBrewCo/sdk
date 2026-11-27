from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from logbrew_sdk import LogBrewClient, SdkError, TransportResponse


class KeyRecordingTransport:
    def __init__(self) -> None:
        self.api_keys: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.api_keys.append(api_key)
        return TransportResponse(status_code=202, attempts=1)


def sent_api_key(client: LogBrewClient) -> list[str]:
    transport = KeyRecordingTransport()
    client.log("evt_server_key_001", "2026-11-27T10:00:00Z", {"message": "first event", "level": "info"})
    client.flush(transport)
    return transport.api_keys


class ServerApiKeyTests(unittest.TestCase):
    def test_client_without_key_sends_with_server_api_key_variable(self) -> None:
        with patch.dict(os.environ, {"LOGBREW_SERVER_API_KEY": "env-server-key"}):
            client = LogBrewClient.create(automatic_delivery=False)

        self.assertEqual(sent_api_key(client), ["env-server-key"])

    def test_explicit_key_wins_over_server_api_key_variable(self) -> None:
        with patch.dict(os.environ, {"LOGBREW_SERVER_API_KEY": "env-server-key"}):
            client = LogBrewClient.create(api_key="explicit-key", automatic_delivery=False)

        self.assertEqual(sent_api_key(client), ["explicit-key"])

    def test_missing_key_names_the_server_api_key_variable(self) -> None:
        with patch.dict(os.environ, {"LOGBREW_SERVER_API_KEY": " "}), self.assertRaises(SdkError) as raised:
            LogBrewClient.create(automatic_delivery=False)

        self.assertEqual(raised.exception.code, "configuration_error")
        self.assertIn("LOGBREW_SERVER_API_KEY", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
