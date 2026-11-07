from __future__ import annotations

import json
import subprocess
import sys
import unittest

APP = """
import json
import logging
import sys

from logbrew_sdk import LogBrewClient, RecordingTransport, create_issue_attributes_from_exception


def create_client():
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-basicconfig",
        sdk_version="0.1.0",
        transport=RecordingTransport.always_accept(),
        automatic_delivery=False,
    )


def configure_logging():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s", stream=sys.stdout)


if sys.argv[1] == "client-first":
    client = create_client()
    configure_logging()
else:
    configure_logging()
    client = create_client()
logging.getLogger("checkout").info("hello")
client.issue("evt_issue", "2026-06-02T10:00:00Z", create_issue_attributes_from_exception(ValueError("checkout failed")))
breadcrumbs = json.loads(client.preview_json())["events"][0]["attributes"].get("breadcrumbs", [])
print(json.dumps({
    "rootLevel": logging.getLevelName(logging.getLogger().level),
    "breadcrumbs": [crumb["message"] for crumb in breadcrumbs if crumb["category"] == "logging"],
}))
"""


def run_app(order: str) -> list[str]:
    result = subprocess.run(
        [sys.executable, "-c", APP, order], capture_output=True, text=True, check=True, timeout=30
    )
    return result.stdout.splitlines()


class BasicConfigTests(unittest.TestCase):
    def test_basicconfig_configures_console_logging_in_both_call_orders(self) -> None:
        for order in ("client-first", "logging-first"):
            with self.subTest(order=order):
                output = run_app(order)
                self.assertEqual(output[0], "INFO:checkout:hello")
                self.assertEqual(json.loads(output[1]), {"rootLevel": "INFO", "breadcrumbs": ["hello"]})


if __name__ == "__main__":
    unittest.main()
