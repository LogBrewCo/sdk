from __future__ import annotations

import json
import unittest
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    SdkError,
    create_logbrew_trace_context,
    set_logbrew_user,
    use_logbrew_trace,
)

TIMESTAMP = "2026-06-02T10:00:00Z"


def client() -> LogBrewClient:
    return LogBrewClient.create(api_key="lb_test_key", sdk_name="logbrew-python-user", sdk_version="0.1.0")


def log_context(target: LogBrewClient, context: Any = None) -> Any:
    attributes: dict[str, Any] = {"message": "checkout", "level": "info"}
    if context is not None:
        attributes["context"] = context
    target.log("evt_log", TIMESTAMP, attributes)  # type: ignore[arg-type]
    return json.loads(target.preview_json())["events"][-1]["attributes"].get("context", {})


class UserContextTests(unittest.TestCase):
    def test_user_reaches_every_event_of_its_request_only(self) -> None:
        target = client()
        with use_logbrew_trace(create_logbrew_trace_context()):
            self.assertTrue(set_logbrew_user("user-42"))
            self.assertEqual(log_context(target)["subject"], {"id": "user-42", "kind": "user"})
        with use_logbrew_trace(create_logbrew_trace_context()):
            self.assertNotIn("subject", log_context(target))
        self.assertNotIn("subject", log_context(target))

    def test_outside_a_request_the_call_does_nothing(self) -> None:
        target = client()
        self.assertFalse(set_logbrew_user("user-42"))
        self.assertNotIn("subject", log_context(target))

    def test_explicit_event_subject_wins_and_anonymous_users_are_supported(self) -> None:
        target = client()
        with use_logbrew_trace(create_logbrew_trace_context()):
            set_logbrew_user("visitor-7", kind="anonymous")
            explicit = log_context(target, {"schemaVersion": 1, "subject": {"id": "user-9", "kind": "user"}})
            anonymous = log_context(target)
        self.assertEqual(explicit["subject"], {"id": "user-9", "kind": "user"})
        self.assertEqual(anonymous["subject"], {"id": "visitor-7", "kind": "anonymous"})

    def test_invalid_ids_and_kinds_are_rejected(self) -> None:
        with use_logbrew_trace(create_logbrew_trace_context()):
            for user_id, kind in (("", "user"), ("x" * 201, "user"), ("user-1", "admin")):
                with self.subTest(user_id=user_id[:10], kind=kind), self.assertRaises(SdkError):
                    set_logbrew_user(user_id, kind=kind)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
