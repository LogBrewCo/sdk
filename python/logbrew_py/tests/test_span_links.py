from __future__ import annotations

import json
import unittest
from typing import Any

from logbrew_sdk import LogBrewClient, SdkError


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class SpanLinkTests(unittest.TestCase):
    def test_span_links_are_privacy_bounded_and_validated(self) -> None:
        client = sample_client()
        attributes: Any = {
            "name": "queue.batch",
            "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
            "spanId": "b7ad6b7169203331",
            "status": "ok",
            "links": [
                {
                    "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "spanId": "bbbbbbbbbbbbbbbb",
                    "sampled": True,
                    "metadata": {
                        "relation": "batch_item",
                        "payload": {"email": "private@example.test"},
                    },
                }
            ],
        }

        client.span(
            "evt_span_links_001",
            "2026-06-02T10:00:04Z",
            attributes,
        )

        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(
            event["attributes"]["links"],
            [
                {
                    "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "spanId": "bbbbbbbbbbbbbbbb",
                    "sampled": True,
                    "metadata": {"relation": "batch_item"},
                }
            ],
        )
        serialized = client.preview_json()
        self.assertNotIn("private@example.test", serialized)
        self.assertNotIn("payload", serialized)

        with self.assertRaisesRegex(SdkError, "span link spanId must not be all zeros"):
            client.span(
                "evt_span_link_invalid",
                "2026-06-02T10:00:04Z",
                {
                    "name": "queue.batch",
                    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                    "spanId": "b7ad6b7169203331",
                    "status": "ok",
                    "links": [
                        {
                            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "spanId": "0000000000000000",
                        }
                    ],
                },
            )


if __name__ == "__main__":
    unittest.main()
