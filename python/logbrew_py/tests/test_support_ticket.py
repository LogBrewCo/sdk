from __future__ import annotations

import json
import unittest

from logbrew_sdk import SdkError, create_support_ticket_draft


class SupportTicketDraftTests(unittest.TestCase):
    def test_builds_local_redacted_payload(self) -> None:
        draft = create_support_ticket_draft(
            source="sdk",
            category="sdk_install_failure",
            title="Python install cannot import package",
            description="Wheel installs, but import fails in production",
            project_id="proj_123",
            environment="production",
            runtime="python 3.13",
            framework="fastapi",
            sdk_package="logbrew-sdk",
            sdk_version="0.1.1",
            release="checkout-api@1.4.0",
            trace_id="4BF92F3577B34DA6A3CE929D0E0E4736",
            event_id="evt_python_support",
            diagnostics={
                "api_key": "hidden",
                "endpoint": "https://api.example.test/v1/events?debug=true#frag",
                "local_path": "/Users/example/service/app.py",
                "headers": {"Authorization": "Bearer hidden", "x-request-id": "req_123"},
                "events": [{"token": "hidden"}, {"ok": True}],
                "error": RuntimeError("private failure message"),
                "callback": lambda: None,
            },
        )

        self.assertEqual(
            draft,
            {
                "source": "sdk",
                "category": "sdk_install_failure",
                "title": "Python install cannot import package",
                "description": "Wheel installs, but import fails in production",
                "project_id": "proj_123",
                "environment": "production",
                "runtime": "python 3.13",
                "framework": "fastapi",
                "sdk_package": "logbrew-sdk",
                "sdk_version": "0.1.1",
                "release": "checkout-api@1.4.0",
                "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
                "event_id": "evt_python_support",
                "diagnostics": {
                    "api_key": "[redacted]",
                    "endpoint": "[redacted-url]/v1/events",
                    "local_path": "[redacted-path]",
                    "headers": {"Authorization": "[redacted]", "x-request-id": "req_123"},
                    "events": [{"token": "[redacted]"}, {"ok": True}],
                    "error": {"type": "RuntimeError"},
                },
            },
        )
        serialized = json.dumps(draft, sort_keys=True)
        self.assertNotIn("hidden", serialized)
        self.assertNotIn("api.example.test", serialized)
        self.assertNotIn("/Users/example", serialized)
        self.assertNotIn("private failure", serialized)
        self.assertNotIn("Authorization: Bearer", serialized)

    def test_rejects_invalid_contract_inputs(self) -> None:
        with self.assertRaisesRegex(SdkError, "support ticket source must be one of: cli, docs, mobile, sdk, website"):
            create_support_ticket_draft(
                source="desktop",  # type: ignore[arg-type]
                category="sdk_install_failure",
                title="Install failed",
                description="Import failed",
            )
        with self.assertRaisesRegex(SdkError, "traceId must not be all zeros"):
            create_support_ticket_draft(
                source="sdk",
                category="sdk_install_failure",
                title="Install failed",
                description="Import failed",
                trace_id="00000000000000000000000000000000",
            )
        with self.assertRaisesRegex(SdkError, "support ticket diagnostics must be an object"):
            create_support_ticket_draft(
                source="sdk",
                category="sdk_install_failure",
                title="Install failed",
                description="Import failed",
                diagnostics=["not", "an", "object"],  # type: ignore[arg-type]
            )


if __name__ == "__main__":
    unittest.main()
