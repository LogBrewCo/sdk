from __future__ import annotations

import json
import os
import unittest
from typing import Any, cast
from unittest.mock import patch

from logbrew_sdk import (
    LogBrewClient,
    SdkError,
    TelemetryContext,
    create_issue_attributes_from_exception,
)

FIXED_TIMESTAMP = "2026-08-03T00:00:00Z"


def capture_log_context(client: LogBrewClient, context: TelemetryContext | None = None) -> dict[str, Any] | None:
    attributes: dict[str, Any] = {"message": "checkout failed", "level": "error"}
    if context is not None:
        attributes["context"] = context
    client.log("evt_log", FIXED_TIMESTAMP, cast(Any, attributes))
    payload = json.loads(client.preview_json())
    return cast(dict[str, Any] | None, payload["events"][0]["attributes"].get("context"))


class PythonRuntimeContextTests(unittest.TestCase):
    def test_default_runtime_context_is_attached_to_every_signal(self) -> None:
        with (
            patch("platform.python_implementation", return_value="CPython"),
            patch("platform.python_version", return_value="3.13.5"),
            patch("platform.system", return_value="Darwin"),
            patch("platform.release", return_value="25.6.0"),
            patch("platform.machine", return_value="arm64"),
        ):
            client = LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-sdk",
                sdk_version="0.1.0",
                automatic_delivery=False,
            )

        client.release("evt_release", "2026-08-03T00:00:00Z", {"version": "worker@1.0.0"})
        client.environment("evt_environment", "2026-08-03T00:00:01Z", {"name": "production"})
        client.issue(
            "evt_issue",
            "2026-08-03T00:00:02Z",
            {"title": "Checkout timeout", "level": "error"},
        )
        client.log(
            "evt_log",
            "2026-08-03T00:00:03Z",
            {"message": "checkout failed", "level": "error"},
        )
        client.span(
            "evt_span",
            "2026-08-03T00:00:04Z",
            {
                "name": "POST /checkout",
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "00f067aa0ba902b7",
                "status": "error",
            },
        )
        client.action(
            "evt_action",
            "2026-08-03T00:00:05Z",
            {"name": "checkout.submit", "status": "failure"},
        )
        client.metric(
            "evt_metric",
            "2026-08-03T00:00:06Z",
            {
                "name": "checkout.failures",
                "kind": "counter",
                "value": 1,
                "unit": "{failure}",
                "temporality": "delta",
            },
        )

        expected_context = {
            "schemaVersion": 1,
            "resource": {
                "runtime": {"name": "CPython", "version": "3.13.5"},
                "operatingSystem": {"name": "Darwin", "version": "25.6.0"},
                "device": {"architecture": "arm64"},
            },
        }
        payload = json.loads(client.preview_json())
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action", "metric"],
        )
        for event in payload["events"]:
            self.assertEqual(event["attributes"]["context"], expected_context, event["type"])

    def test_explicit_client_and_event_contexts_merge_without_mutating_inputs(self) -> None:
        client_context: TelemetryContext = {
            "schemaVersion": 1,
            "resource": {
                "service": {"name": "checkout-api", "version": "1.4.0"},
                "runtime": {"name": "PyPy", "version": "7.3.19"},
                "device": {"model": "container"},
            },
            "trace": {
                "traceId": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "spanId": "BBBBBBBBBBBBBBBB",
                "sampled": True,
            },
            "tags": {"plan": "team", "region": "eu"},
        }
        event_context: TelemetryContext = {
            "schemaVersion": 1,
            "resource": {
                "service": {"name": "checkout-api", "version": "1.5.0"},
                "device": {"architecture": "wasm32"},
                "application": {"name": "checkout-worker", "build": "20260803.1"},
            },
            "trace": {
                "traceId": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                "parentSpanId": "DDDDDDDDDDDDDDDD",
            },
            "subject": {"id": "user_42", "kind": "user"},
            "tags": {"feature": "one-click", "plan": "enterprise"},
        }

        with (
            patch("platform.python_implementation", return_value="CPython"),
            patch("platform.python_version", return_value="3.13.5"),
            patch("platform.system", return_value="Darwin"),
            patch("platform.release", return_value="25.6.0"),
            patch("platform.machine", return_value="arm64"),
        ):
            client = LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-sdk",
                sdk_version="0.1.0",
                automatic_delivery=False,
                context=client_context,
            )

        captured = capture_log_context(client, event_context)
        client_context["tags"]["plan"] = "mutated"
        event_context["tags"]["feature"] = "mutated"

        self.assertEqual(
            captured,
            {
                "schemaVersion": 1,
                "resource": {
                    "service": {"name": "checkout-api", "version": "1.5.0"},
                    "runtime": {"name": "PyPy", "version": "7.3.19"},
                    "operatingSystem": {"name": "Darwin", "version": "25.6.0"},
                    "device": {"model": "container", "architecture": "wasm32"},
                    "application": {"name": "checkout-worker", "build": "20260803.1"},
                },
                "trace": {
                    "traceId": "cccccccccccccccccccccccccccccccc",
                    "parentSpanId": "dddddddddddddddd",
                },
                "subject": {"id": "user_42", "kind": "user"},
                "tags": {"feature": "one-click", "plan": "enterprise", "region": "eu"},
            },
        )

    def test_runtime_context_can_be_disabled_without_changing_explicit_context(self) -> None:
        explicit_context: TelemetryContext = {"schemaVersion": 1, "tags": {"plan": "team"}}
        probes = (
            patch("platform.python_implementation", side_effect=AssertionError("unexpected probe")),
            patch("platform.python_version", side_effect=AssertionError("unexpected probe")),
            patch("platform.system", side_effect=AssertionError("unexpected probe")),
            patch("platform.release", side_effect=AssertionError("unexpected probe")),
            patch("platform.machine", side_effect=AssertionError("unexpected probe")),
        )
        with probes[0], probes[1], probes[2], probes[3], probes[4]:
            explicit_client = LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-sdk",
                sdk_version="0.1.0",
                automatic_delivery=False,
                capture_runtime_context=False,
                context=explicit_context,
            )
            absent_client = LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-sdk",
                sdk_version="0.1.0",
                automatic_delivery=False,
                capture_runtime_context=False,
            )

        self.assertEqual(capture_log_context(explicit_client), explicit_context)
        self.assertIsNone(capture_log_context(absent_client))

    def test_runtime_context_is_privacy_bounded_and_probe_failures_are_nonfatal(self) -> None:
        marker_name = "LOGBREW_RUNTIME_CONTEXT_PRIVATE_MARKER"
        marker_value = "must-not-enter-telemetry"
        os.environ[marker_name] = marker_value
        try:
            with (
                patch("platform.python_implementation", return_value=" invalid\nimplementation "),
                patch("platform.python_version", side_effect=RuntimeError("private failure")),
                patch("platform.system", return_value=None),
                patch("platform.release", side_effect=AssertionError("release should not be read")),
                patch("platform.machine", return_value="x" * 257),
                patch("platform.node", side_effect=AssertionError("hostname must not be read")),
                patch("platform.platform", side_effect=AssertionError("platform build must not be read")),
            ):
                client = LogBrewClient.create(
                    api_key="LOGBREW_API_KEY",
                    sdk_name="logbrew-sdk",
                    sdk_version="0.1.0",
                    automatic_delivery=False,
                )
        finally:
            del os.environ[marker_name]

        captured = capture_log_context(client)
        self.assertEqual(captured, {"schemaVersion": 1, "resource": {"runtime": {"name": "python"}}})
        serialized = json.dumps(captured)
        self.assertNotIn(marker_name, serialized)
        self.assertNotIn(marker_value, serialized)
        self.assertNotIn("private failure", serialized)

    def test_runtime_context_controls_reject_invalid_configuration(self) -> None:
        with self.assertRaisesRegex(SdkError, "capture_runtime_context must be a boolean"):
            LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-sdk",
                sdk_version="0.1.0",
                automatic_delivery=False,
                capture_runtime_context=cast(Any, "yes"),
            )

        invalid_contexts: list[tuple[dict[str, Any], str]] = [
            ({"resource": {"runtime": {"name": "python"}}}, "schemaVersion must be 1"),
            ({"schemaVersion": 1}, "must include resource, trace, session, subject, or tags"),
            (
                {"schemaVersion": 1, "resource": {"runtime": {"version": "3.13"}}},
                "runtime name is required",
            ),
            (
                {"schemaVersion": 1, "trace": {"traceId": "0" * 32}},
                "traceId must be 32 non-zero hex characters",
            ),
            (
                {"schemaVersion": 1, "session": {"id": "same", "previousId": "same"}},
                "previousId must differ from id",
            ),
            (
                {"schemaVersion": 1, "subject": {"id": "user_1", "kind": "customer"}},
                "kind must be anonymous or user",
            ),
            ({"schemaVersion": 1, "tags": {"bad key": "value"}}, "tags key is invalid"),
            ({"schemaVersion": 1, "unknown": "value"}, "unsupported fields: unknown"),
        ]
        for invalid_context, message in invalid_contexts:
            with self.subTest(message=message), self.assertRaisesRegex(SdkError, message):
                LogBrewClient.create(
                    api_key="LOGBREW_API_KEY",
                    sdk_name="logbrew-sdk",
                    sdk_version="0.1.0",
                    automatic_delivery=False,
                    capture_runtime_context=False,
                    context=cast(TelemetryContext, invalid_context),
                )

    def test_exception_helper_preserves_explicit_context_for_client_merge(self) -> None:
        context: TelemetryContext = {
            "schemaVersion": 1,
            "resource": {"application": {"name": "checkout-worker", "version": "1.5.0"}},
            "tags": {"operation": "checkout"},
        }
        attributes = create_issue_attributes_from_exception(
            RuntimeError("inventory unavailable"),
            context=context,
            include_stack_frames=False,
        )
        client_context: TelemetryContext = {"schemaVersion": 1, "tags": {"plan": "team"}}
        client = LogBrewClient.create(
            api_key="LOGBREW_API_KEY",
            sdk_name="logbrew-sdk",
            sdk_version="0.1.0",
            automatic_delivery=False,
            capture_runtime_context=False,
            context=client_context,
        )
        client.issue("evt_issue", FIXED_TIMESTAMP, attributes)

        captured = json.loads(client.preview_json())["events"][0]["attributes"]["context"]
        self.assertEqual(
            captured,
            {
                "schemaVersion": 1,
                "resource": {"application": {"name": "checkout-worker", "version": "1.5.0"}},
                "tags": {"operation": "checkout", "plan": "team"},
            },
        )


if __name__ == "__main__":
    unittest.main()
