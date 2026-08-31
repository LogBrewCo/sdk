from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

from scripts.validate_fixtures import ValidationError, validate_payload


ROOT = Path(__file__).resolve().parent.parent


class ValidateFixturesTests(unittest.TestCase):
    def load_schema(self) -> dict:
        return json.loads((ROOT / "spec" / "event-batch.schema.json").read_text())

    def load_valid_payload(self) -> dict:
        return json.loads((ROOT / "fixtures" / "valid-batch.json").read_text())

    def metric_event(self) -> dict:
        return {
            "type": "metric",
            "timestamp": "2026-06-02T10:00:06Z",
            "id": "evt_metric_001",
            "attributes": {
                "name": "checkout.requests",
                "description": "Number of checkout requests accepted by the application.",
                "kind": "counter",
                "value": 42,
                "unit": "{request}",
                "temporality": "delta",
                "metadata": {"service": "checkout"},
            },
        }

    def issue_attributes(self, payload: dict) -> dict:
        return next(
            event["attributes"]
            for event in payload["events"]
            if event["type"] == "issue"
        )

    def test_valid_fixture_passes(self) -> None:
        payload = self.load_valid_payload()
        validate_payload(payload)

    def test_invalid_fixture_fails(self) -> None:
        payload = json.loads((ROOT / "fixtures" / "invalid-batch.json").read_text())
        with self.assertRaises(ValidationError):
            validate_payload(payload)

    def test_rejects_unknown_top_level_field(self) -> None:
        payload = self.load_valid_payload()
        payload["extra"] = True
        with self.assertRaisesRegex(ValidationError, "payload has unsupported fields: extra"):
            validate_payload(payload)

    def test_rejects_unknown_event_field(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][0]["unexpected"] = "value"
        with self.assertRaisesRegex(ValidationError, "event 0 has unsupported fields: unexpected"):
            validate_payload(payload)

    def test_rejects_unknown_attribute_field(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][0]["attributes"]["buildHost"] = "fake-host"
        with self.assertRaisesRegex(
            ValidationError, "event 0 attributes has unsupported fields: buildHost"
        ):
            validate_payload(payload)

    def test_rejects_non_object_metadata(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][0]["attributes"]["metadata"] = ["not", "an", "object"]
        with self.assertRaisesRegex(ValidationError, "event 0 attribute metadata must be an object"):
            validate_payload(payload)

    def test_rejects_nested_metadata_values(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][0]["attributes"]["metadata"] = {"nested": {"nope": True}}
        with self.assertRaisesRegex(
            ValidationError,
            "event 0 metadata value for nested must be a string, number, boolean, or null",
        ):
            validate_payload(payload)

    def test_shared_telemetry_context_passes_for_every_signal(self) -> None:
        payload = self.load_valid_payload()
        context = {
            "schemaVersion": 1,
            "resource": {
                "service": {"name": "checkout-api", "version": "2.4.0"},
                "deployment": {
                    "environment": "production",
                    "release": "checkout@2.4.0",
                },
                "runtime": {"name": "node", "version": "22"},
                "framework": {"name": "fastify", "version": "5"},
                "operatingSystem": {"name": "linux", "version": "6"},
                "device": {"architecture": "arm64"},
                "application": {"name": "checkout", "build": "240"},
            },
            "trace": {
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "b7ad6b7169203331",
                "sampled": True,
            },
            "session": {"id": "session_01", "previousId": "session_00"},
            "subject": {"id": "subject_01", "kind": "user"},
            "tags": {"plan": "team", "region": "eu"},
        }

        for event in payload["events"]:
            event["attributes"]["context"] = context

        validate_payload(payload)

    def test_schema_exposes_one_bounded_context_contract_on_every_signal(self) -> None:
        schema = self.load_schema()
        definitions = schema["$defs"]
        for event_definition in (
            "releaseEvent",
            "environmentEvent",
            "issueEvent",
            "logEvent",
            "spanEvent",
            "actionEvent",
            "metricEvent",
        ):
            with self.subTest(event=event_definition):
                attributes = definitions[event_definition]["allOf"][1]["properties"][
                    "attributes"
                ]
                self.assertEqual(
                    {"$ref": "#/$defs/telemetryContext"},
                    attributes["properties"]["context"],
                )

        context = definitions["telemetryContext"]
        self.assertFalse(context["additionalProperties"])
        self.assertEqual(["schemaVersion"], context["required"])
        self.assertEqual(2, context["minProperties"])
        self.assertEqual(32, definitions["telemetryTags"]["maxProperties"])

    def test_rejects_invalid_shared_telemetry_context(self) -> None:
        invalid_contexts = (
            {"schemaVersion": 2, "tags": {"plan": "team"}},
            {"schemaVersion": 1, "email": "person@example.test"},
            {"schemaVersion": 1, "resource": {"device": {}}},
            {
                "schemaVersion": 1,
                "trace": {"traceId": "00000000000000000000000000000000"},
            },
            {"schemaVersion": 1, "session": {"id": "same", "previousId": "same"}},
            {
                "schemaVersion": 1,
                "subject": {"id": "subject_01", "kind": "identified"},
            },
            {
                "schemaVersion": 1,
                "tags": {f"tag_{index}": "value" for index in range(33)},
            },
            {"schemaVersion": 1, "tags": {"unsafe key": "value"}},
            {"schemaVersion": 1, "tags": {"plan": "safe\u0085unsafe"}},
        )

        for context in invalid_contexts:
            with self.subTest(context=context):
                payload = self.load_valid_payload()
                payload["events"][0]["attributes"]["context"] = context
                with self.assertRaises(ValidationError):
                    validate_payload(payload)

    def test_rejects_timestamp_without_timezone(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][0]["timestamp"] = "2026-06-02T10:00:00"
        with self.assertRaisesRegex(
            ValidationError,
            "timestamp must include a timezone offset: 2026-06-02T10:00:00",
        ):
            validate_payload(payload)

    def test_rejects_boolean_duration(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][4]["attributes"]["durationMs"] = True
        with self.assertRaisesRegex(
            ValidationError,
            "event 4 attribute durationMs must be a non-negative number",
        ):
            validate_payload(payload)

    def test_issue_stack_frames_pass_with_bounded_generated_positions(self) -> None:
        payload = self.load_valid_payload()
        self.issue_attributes(payload)["stackFrames"] = [
            {
                "filename": "/assets/app.js",
                "line": 12,
                "column": 34,
                "function": "checkout",
                "module": "@example/checkout",
                "inApp": True,
                "debugId": "11111111-2222-4333-8444-555555555555",
            },
            {"filename": "/assets/vendor.js", "line": 1, "column": 2},
        ]

        validate_payload(payload)

        self.issue_attributes(payload)["stackFrames"][0]["function"] = "🧪" * 256
        validate_payload(payload)

    def test_rejects_invalid_issue_stack_frame_shape(self) -> None:
        payload = self.load_valid_payload()
        self.issue_attributes(payload)["stackFrames"] = [
            {"filename": "/assets/app.js?private=value", "line": 0, "column": 2}
        ]

        with self.assertRaisesRegex(
            ValidationError,
            "event 2 issue stack frame 0 filename is invalid",
        ):
            validate_payload(payload)

    def test_rejects_invalid_issue_stack_frame_identity(self) -> None:
        cases = (
            ({"function": "x" * 257}, "function is invalid"),
            ({"function": "🧪" * 257}, "function is invalid"),
            ({"function": None}, "function is invalid"),
            ({"function": "   "}, "function is invalid"),
            ({"module": "@example/checkout?private=value"}, "module is invalid"),
            ({"module": None}, "module is invalid"),
            ({"module": "   "}, "module is invalid"),
            ({"inApp": "yes"}, "inApp must be a boolean"),
            ({"inApp": None}, "inApp must be a boolean"),
            ({"debugId": "not-a-uuid"}, "debugId must be a UUID"),
        )
        for extra, expected in cases:
            with self.subTest(extra=extra):
                payload = self.load_valid_payload()
                self.issue_attributes(payload)["stackFrames"] = [
                    {"filename": "/assets/app.js", "line": 1, "column": 2, **extra}
                ]
                with self.assertRaisesRegex(ValidationError, expected):
                    validate_payload(payload)

    def test_rejects_too_many_issue_stack_frames(self) -> None:
        payload = self.load_valid_payload()
        self.issue_attributes(payload)["stackFrames"] = [
            {"filename": f"frame-{index}.js", "line": index + 1, "column": 2}
            for index in range(33)
        ]

        with self.assertRaisesRegex(
            ValidationError,
            "event 2 issue stackFrames must contain 1-32 entries",
        ):
            validate_payload(payload)

    def test_issue_diagnostics_accept_bounded_exception_and_breadcrumbs(self) -> None:
        payload = self.load_valid_payload()
        attributes = self.issue_attributes(payload)
        attributes["exception"] = {
            "type": "CheckoutError",
            "mechanism": {"type": "react.error_boundary", "handled": True},
        }
        attributes["breadcrumbs"] = [
            {
                "timestamp": "2026-06-02T09:59:58.123Z",
                "type": "navigation",
                "category": "navigation",
                "level": "info",
                "message": "Opened /checkout/:step",
                "data": {
                    "route": "/checkout/:step",
                    "cached": False,
                    "attempt": 2,
                },
            }
        ]
        attributes["breadcrumbsTruncated"] = True

        validate_payload(payload)

    def test_issue_exception_chain_preserves_reported_wrapper_and_underlying_cause(self) -> None:
        payload = self.load_valid_payload()
        attributes = self.issue_attributes(payload)
        reported_frame = {
            "filename": "checkout.py",
            "line": 41,
            "column": 1,
            "function": "submit",
            "module": "checkout.api",
            "inApp": True,
        }
        cause_frame = {
            "filename": "payments.py",
            "line": 17,
            "column": 1,
            "function": "authorize",
            "module": "checkout.payments",
            "inApp": True,
        }
        attributes["exception"] = {
            "type": "CheckoutError",
            "mechanism": {"type": "python.middleware", "handled": False},
        }
        attributes["stackFrames"] = [reported_frame]
        attributes["exceptionChain"] = {
            "entries": [
                {
                    "id": 0,
                    "relationship": "reported",
                    "type": "CheckoutError",
                    "message": "Checkout could not complete",
                    "messageState": "captured",
                    "module": "checkout.api",
                    "mechanism": {"type": "python.middleware", "handled": False},
                    "stackFrames": [reported_frame],
                    "stackFramesState": "captured",
                },
                {
                    "id": 1,
                    "parentId": 0,
                    "relationship": "cause",
                    "type": "PaymentTimeout",
                    "messageState": "redacted",
                    "module": "checkout.payments",
                    "mechanism": {"type": "python.cause", "handled": True},
                    "stackFrames": [cause_frame],
                    "stackFramesState": "truncated",
                },
            ],
            "truncated": False,
        }

        validate_payload(payload)

    def test_issue_exception_chain_rejects_contradictory_or_unbounded_evidence(self) -> None:
        def attributes_with_chain() -> dict:
            payload = self.load_valid_payload()
            attributes = self.issue_attributes(payload)
            frame = {"filename": "checkout.py", "line": 41, "column": 1}
            attributes["exception"] = {"type": "CheckoutError"}
            attributes["stackFrames"] = [frame]
            attributes["exceptionChain"] = {
                "entries": [
                    {
                        "id": 0,
                        "relationship": "reported",
                        "type": "CheckoutError",
                        "message": "Checkout could not complete",
                        "messageState": "captured",
                        "stackFrames": [frame],
                        "stackFramesState": "captured",
                    },
                    {
                        "id": 1,
                        "parentId": 0,
                        "relationship": "cause",
                        "type": "PaymentTimeout",
                        "messageState": "not_captured",
                        "stackFramesState": "not_captured",
                    },
                ],
                "truncated": False,
            }
            return attributes

        cases = (
            (
                lambda value: value["exceptionChain"]["entries"][1].update({"parentId": 1}),
                "must reference an earlier parent",
            ),
            (
                lambda value: value["exceptionChain"]["entries"][1].update(
                    {"message": "must not survive"}
                ),
                "message must be absent for not_captured",
            ),
            (
                lambda value: value["exceptionChain"]["entries"][1].update(
                    {"stackFrames": [{"filename": "x.py", "line": 1, "column": 1}]}
                ),
                "stackFrames must be absent for not_captured",
            ),
            (
                lambda value: value["exception"].update({"type": "DifferentError"}),
                "reported exception must match exception",
            ),
            (
                lambda value: value.update(
                    {"stackFrames": [{"filename": "different.py", "line": 1, "column": 1}]}
                ),
                "reported stack must match stackFrames",
            ),
        )
        for mutate, expected in cases:
            with self.subTest(expected=expected):
                payload = self.load_valid_payload()
                attributes = attributes_with_chain()
                next(
                    event for event in payload["events"] if event["type"] == "issue"
                )["attributes"] = attributes
                mutate(attributes)
                with self.assertRaisesRegex(ValidationError, expected):
                    validate_payload(payload)

        payload = self.load_valid_payload()
        attributes = attributes_with_chain()
        next(event for event in payload["events"] if event["type"] == "issue")[
            "attributes"
        ] = attributes
        template = attributes["exceptionChain"]["entries"][1]
        attributes["exceptionChain"]["entries"] = [
            {
                **template,
                "id": index,
                **(
                    {"relationship": "reported", "parentId": None}
                    if index == 0
                    else {"relationship": "cause", "parentId": index - 1}
                ),
            }
            for index in range(9)
        ]
        del attributes["exceptionChain"]["entries"][0]["parentId"]
        with self.assertRaisesRegex(ValidationError, "must contain 1-8 exceptions"):
            validate_payload(payload)

    def test_schema_exposes_bounded_exception_chain_states(self) -> None:
        definitions = self.load_schema()["$defs"]
        chain = definitions["issueExceptionChain"]
        entry = definitions["issueExceptionChainEntry"]
        self.assertEqual(8, chain["properties"]["entries"]["maxItems"])
        self.assertEqual(
            ["captured", "truncated", "redacted", "not_captured"],
            entry["properties"]["messageState"]["enum"],
        )
        self.assertEqual(
            ["captured", "truncated", "not_captured"],
            entry["properties"]["stackFramesState"]["enum"],
        )
        issue_attributes = definitions["issueEvent"]["allOf"][1]["properties"][
            "attributes"
        ]
        self.assertEqual(
            {"$ref": "#/$defs/issueExceptionChain"},
            issue_attributes["properties"]["exceptionChain"],
        )

    def test_issue_diagnostics_reject_invalid_or_unbounded_values(self) -> None:
        cases = (
            ({"exception": {"type": "CheckoutError", "mechanism": {"type": "react.error_boundary"}}}, "handled"),
            ({"exception": {"type": "x" * 257}}, "exception type is invalid"),
            ({"breadcrumbs": []}, "must contain 1-64 entries"),
            (
                {
                    "breadcrumbs": [
                        {
                            "timestamp": "2026-06-02T09:59:58Z",
                            "category": "navigation",
                            "data": {"nested": {"private": True}},
                        }
                    ]
                },
                "data value for nested must be a string, number, boolean, or null",
            ),
            (
                {
                    "breadcrumbs": [
                        {
                            "timestamp": "2026-06-02T09:59:58Z",
                            "category": "navigation",
                            "data": {f"field_{index}": index for index in range(9)},
                        }
                    ]
                },
                "data must contain at most 8 fields",
            ),
            (
                {
                    "breadcrumbs": [
                        {
                            "timestamp": "2026-06-02T09:59:58",
                            "category": "navigation",
                        }
                    ]
                },
                "timestamp must include a timezone offset",
            ),
            ({"breadcrumbsTruncated": "yes"}, "breadcrumbsTruncated must be a boolean"),
        )

        for diagnostics, expected in cases:
            with self.subTest(diagnostics=diagnostics):
                payload = self.load_valid_payload()
                self.issue_attributes(payload).update(diagnostics)
                with self.assertRaisesRegex(ValidationError, expected):
                    validate_payload(payload)

        payload = self.load_valid_payload()
        self.issue_attributes(payload)["breadcrumbs"] = [
            {
                "timestamp": "2026-06-02T09:59:58Z",
                "category": f"step.{index}",
            }
            for index in range(65)
        ]
        with self.assertRaisesRegex(ValidationError, "must contain 1-64 entries"):
            validate_payload(payload)

    def test_span_events_pass_with_primitive_metadata(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][4]["attributes"]["events"] = [
            {
                "name": "db.pool.wait",
                "timestamp": "2026-06-02T10:00:04Z",
                "metadata": {"phase": "before_query", "attempt": 1, "retryable": False},
            }
        ]
        validate_payload(payload)

    def test_rejects_nested_span_event_metadata_values(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][4]["attributes"]["events"] = [
            {"name": "db.pool.wait", "metadata": {"nested": {"nope": True}}}
        ]
        with self.assertRaisesRegex(
            ValidationError,
            "event 4 span event 0 metadata value for nested must be a string, number, boolean, or null",
        ):
            validate_payload(payload)

    def test_rejects_too_many_span_events(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][4]["attributes"]["events"] = [{"name": f"step.{index}"} for index in range(9)]
        with self.assertRaisesRegex(ValidationError, "event 4 span events must contain at most 8 entries"):
            validate_payload(payload)

    def test_span_links_pass_with_primitive_metadata(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][4]["attributes"]["links"] = [
            {
                "traceId": "11111111111111111111111111111111",
                "spanId": "2222222222222222",
                "sampled": True,
                "metadata": {"relation": "batch_item", "shard": 3},
            }
        ]
        validate_payload(payload)

    def test_rejects_nested_span_link_metadata_values(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][4]["attributes"]["links"] = [
            {
                "traceId": "11111111111111111111111111111111",
                "spanId": "2222222222222222",
                "metadata": {"nested": {"nope": True}},
            }
        ]
        with self.assertRaisesRegex(
            ValidationError,
            "event 4 span link 0 metadata value for nested must be a string, number, boolean, or null",
        ):
            validate_payload(payload)

    def test_rejects_too_many_span_links(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][4]["attributes"]["links"] = [
            {"traceId": f"{index + 1:032x}", "spanId": "2222222222222222"} for index in range(9)
        ]
        with self.assertRaisesRegex(ValidationError, "event 4 span links must contain at most 8 entries"):
            validate_payload(payload)

    def test_metric_event_passes(self) -> None:
        payload = self.load_valid_payload()
        payload["events"].append(self.metric_event())
        validate_payload(payload)

    def test_metric_description_accepts_the_public_character_limit(self) -> None:
        payload = self.load_valid_payload()
        payload["events"].append(self.metric_event())
        payload["events"][6]["attributes"]["description"] = "M" * 1024
        validate_payload(payload)

    def test_rejects_invalid_metric_descriptions(self) -> None:
        invalid_descriptions = [
            None,
            "",
            "   ",
            "M" * 1025,
            "request\u0085count",
            "request\u2028count",
            "request\ud800count",
        ]
        for description in invalid_descriptions:
            with self.subTest(description=repr(description)):
                payload = self.load_valid_payload()
                payload["events"].append(self.metric_event())
                payload["events"][6]["attributes"]["description"] = description
                with self.assertRaisesRegex(
                    ValidationError,
                    "event 6 attribute description must be a non-blank string of at most "
                    "1024 non-control characters",
                ):
                    validate_payload(payload)

    def test_rejects_boolean_metric_value(self) -> None:
        payload = self.load_valid_payload()
        payload["events"].append(self.metric_event())
        payload["events"][6]["attributes"]["value"] = True
        with self.assertRaisesRegex(
            ValidationError,
            "event 6 attribute value must be a finite number",
        ):
            validate_payload(payload)

    def test_rejects_negative_counter_value(self) -> None:
        payload = self.load_valid_payload()
        payload["events"].append(self.metric_event())
        payload["events"][6]["attributes"]["value"] = -1
        with self.assertRaisesRegex(
            ValidationError,
            "event 6 attribute value for counter must be non-negative",
        ):
            validate_payload(payload)

    def test_rejects_metric_temporality_for_kind(self) -> None:
        payload = self.load_valid_payload()
        payload["events"].append(self.metric_event())
        payload["events"][6]["attributes"]["kind"] = "gauge"
        payload["events"][6]["attributes"]["temporality"] = "delta"
        with self.assertRaisesRegex(
            ValidationError,
            "event 6 attribute temporality for gauge must be one of: instant",
        ):
            validate_payload(payload)

    def test_rejects_non_string_optional_attribute(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][3]["attributes"]["logger"] = {"name": "job-runner"}
        with self.assertRaisesRegex(
            ValidationError,
            "event 3 attribute logger must be a string",
        ):
            validate_payload(payload)

    def test_rejects_empty_optional_non_empty_string_attribute(self) -> None:
        payload = self.load_valid_payload()
        payload["events"][0]["attributes"]["commit"] = ""
        with self.assertRaisesRegex(
            ValidationError,
            "event 0 attribute commit must be a non-empty string",
        ):
            validate_payload(payload)

    def test_cli_supports_json_output(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "validate_fixtures.py"),
                str(ROOT / "fixtures" / "valid-batch.json"),
                "--json",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "ok": True,
                "fixture": str(ROOT / "fixtures" / "valid-batch.json"),
                "message": "valid",
            },
        )

    def test_cli_reports_invalid_json_cleanly(self) -> None:
        fixture = ROOT / "fixtures" / "malformed-batch.json"
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "validate_fixtures.py"),
                str(fixture),
                "--json",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        response = json.loads(result.stdout)
        self.assertEqual(response["ok"], False)
        self.assertEqual(response["fixture"], str(fixture))
        self.assertTrue(response["message"].startswith("invalid JSON: "))

    def test_schema_event_types_match_validator(self) -> None:
        schema = self.load_schema()
        event_types = set(schema["$defs"]["eventBase"]["properties"]["type"]["enum"])
        self.assertEqual(event_types, set(validate_payload.__globals__["ALLOWED_TYPES"]))

    def test_schema_required_attributes_match_validator(self) -> None:
        schema = self.load_schema()
        required_attributes = validate_payload.__globals__["REQUIRED_ATTRIBUTES"]
        for event_type, required_keys in required_attributes.items():
            schema_required = set(
                schema["$defs"][f"{event_type}Event"]["allOf"][1]["properties"]["attributes"]["required"]
            )
            self.assertEqual(
                schema_required,
                required_keys,
                msg=f"schema required keys drifted for {event_type}",
            )

    def test_schema_enum_constraints_match_validator(self) -> None:
        schema = self.load_schema()
        enums = validate_payload.__globals__["ENUMS"]
        for (event_type, attribute_name), allowed_values in enums.items():
            schema_values = set(
                schema["$defs"][f"{event_type}Event"]["allOf"][1]["properties"]["attributes"]["properties"][
                    attribute_name
                ]["enum"]
            )
            self.assertEqual(
                schema_values,
                allowed_values,
                msg=f"schema enum drifted for {event_type}.{attribute_name}",
            )

    def test_schema_metric_temporalities_match_validator(self) -> None:
        schema = self.load_schema()
        temporalities_by_kind = validate_payload.__globals__["METRIC_TEMPORALITIES_BY_KIND"]
        validator_temporalities = set().union(*temporalities_by_kind.values())
        schema_temporalities = set(
            schema["$defs"]["metricEvent"]["allOf"][1]["properties"]["attributes"]["properties"]["temporality"][
                "enum"
            ]
        )
        self.assertEqual(schema_temporalities, validator_temporalities)

    def test_schema_describes_bounded_metric_descriptions(self) -> None:
        schema = self.load_schema()
        description = schema["$defs"]["metricEvent"]["allOf"][1]["properties"]["attributes"][
            "properties"
        ]["description"]

        self.assertEqual(description["type"], "string")
        self.assertEqual(description["minLength"], 1)
        self.assertEqual(description["maxLength"], 1024)
        self.assertIn("\\S", description["pattern"])
        self.assertIn("\\ud800-\\udfff", description["pattern"])

    def test_schema_describes_bounded_span_links(self) -> None:
        schema = self.load_schema()
        definitions = schema["$defs"]
        span_properties = definitions["spanEvent"]["allOf"][1]["properties"]["attributes"][
            "properties"
        ]

        self.assertEqual(
            span_properties["links"],
            {
                "type": "array",
                "maxItems": 8,
                "items": {"$ref": "#/$defs/spanLinkSummary"},
            },
        )
        link = definitions["spanLinkSummary"]
        self.assertFalse(link["additionalProperties"])
        self.assertEqual(set(link["required"]), {"traceId", "spanId"})
        self.assertEqual(link["properties"]["sampled"], {"type": "boolean"})
        self.assertEqual(link["properties"]["metadata"], {"$ref": "#/$defs/metadata"})
        self.assertEqual(link["properties"]["traceId"]["pattern"], "^[0-9a-fA-F]{32}$")
        self.assertEqual(
            link["properties"]["traceId"]["not"],
            {"const": "00000000000000000000000000000000"},
        )
        self.assertEqual(link["properties"]["spanId"]["pattern"], "^[0-9a-fA-F]{16}$")
        self.assertEqual(
            link["properties"]["spanId"]["not"],
            {"const": "0000000000000000"},
        )

    def test_schema_describes_issue_stack_frames(self) -> None:
        schema = self.load_schema()
        issue_properties = schema["$defs"]["issueEvent"]["allOf"][1]["properties"]["attributes"][
            "properties"
        ]
        self.assertIn("stackFrames", issue_properties)
        self.assertEqual(
            issue_properties["stackFrames"],
            {
                "type": "array",
                "minItems": 1,
                "maxItems": 32,
                "items": {"$ref": "#/$defs/issueStackFrame"},
            },
        )
        native = schema["$defs"]["nativeStackFrame"]
        self.assertEqual(set(native["required"]), {"imageUuid", "architecture", "instructionOffset"})
        self.assertEqual(issue_properties["nativeStackFrames"]["maxItems"], 32)
        self.assertEqual(issue_properties["nativeStackFrames"]["items"], {"$ref": "#/$defs/nativeStackFrame"})

    def test_native_issue_frames_are_canonical_and_bounded(self) -> None:
        payload = self.load_valid_payload()
        frame = {
            "imageUuid": "01234567-89ab-cdef-0123-456789abcdef",
            "architecture": "arm64",
            "instructionOffset": "0000000000001234",
        }
        self.issue_attributes(payload)["nativeStackFrames"] = [frame]
        validate_payload(payload)

        for invalid in (
            [],
            [{**frame, "imageUuid": frame["imageUuid"].upper()}],
            [{**frame, "architecture": "arm64-v8a"}],
            [{**frame, "instructionOffset": "1234"}],
        ):
            with self.subTest(invalid=invalid):
                self.issue_attributes(payload)["nativeStackFrames"] = invalid
                with self.assertRaises(ValidationError):
                    validate_payload(payload)

    def test_schema_describes_bounded_issue_diagnostics(self) -> None:
        schema = self.load_schema()
        definitions = schema["$defs"]
        issue_properties = definitions["issueEvent"]["allOf"][1]["properties"]["attributes"][
            "properties"
        ]

        self.assertEqual(issue_properties["exception"], {"$ref": "#/$defs/issueException"})
        self.assertEqual(
            issue_properties["breadcrumbs"],
            {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "items": {"$ref": "#/$defs/issueBreadcrumb"},
            },
        )
        self.assertEqual(issue_properties["breadcrumbsTruncated"], {"type": "boolean"})
        self.assertEqual(
            issue_properties["evidence"],
            {"$ref": "#/$defs/issueDiagnosticEvidence"},
        )

        exception = definitions["issueException"]
        self.assertFalse(exception["additionalProperties"])
        self.assertEqual(exception["required"], ["type"])
        self.assertEqual(
            exception["properties"]["mechanism"],
            {"$ref": "#/$defs/issueExceptionMechanism"},
        )
        mechanism = definitions["issueExceptionMechanism"]
        self.assertFalse(mechanism["additionalProperties"])
        self.assertEqual(set(mechanism["required"]), {"type", "handled"})

        breadcrumb = definitions["issueBreadcrumb"]
        self.assertFalse(breadcrumb["additionalProperties"])
        self.assertEqual(set(breadcrumb["required"]), {"timestamp", "category"})
        self.assertEqual(
            breadcrumb["properties"]["data"],
            {"$ref": "#/$defs/issueBreadcrumbData"},
        )
        self.assertEqual(definitions["issueBreadcrumbData"]["maxProperties"], 8)
        evidence = definitions["issueDiagnosticEvidence"]
        self.assertFalse(evidence["additionalProperties"])
        self.assertEqual(evidence["properties"]["likelyFixArea"], {
            "$ref": "#/$defs/issueLikelyFixArea"
        })
        self.assertEqual(definitions["issueEvidenceFields"]["maxItems"], 32)

    def test_issue_diagnostic_evidence_is_bounded_and_state_consistent(self) -> None:
        payload = self.load_valid_payload()
        evidence = {
            "likelyRootCause": "The payment provider exhausted its retry budget.",
            "likelyFixArea": {
                "component": "checkout-api",
                "file": "src/payments/gateway.py",
                "line": 42,
                "inApp": True,
            },
            "impact": {
                "failedAction": "checkout.submit",
                "userVisibleOutcome": "The order was not confirmed.",
            },
            "capturedFields": ["provider.status"],
            "redactedFields": ["provider.message"],
        }
        self.issue_attributes(payload)["evidence"] = evidence
        validate_payload(payload)

        cases = (
            ({}, "must be a non-empty object"),
            ({"likelyFixArea": {"inApp": True}}, "must identify a code location"),
            ({"likelyFixArea": {"file": "/srv/example/app.py"}}, "safe relative path"),
            ({"likelyFixArea": {"file": " /srv/example/app.py"}}, "safe relative path"),
            (
                {"capturedFields": ["provider.status"], "missingFields": ["provider.status"]},
                "has conflicting states",
            ),
            ({"capturedFields": ["bad field"]}, "unique bounded fields"),
        )
        for invalid, expected in cases:
            with self.subTest(invalid=invalid):
                self.issue_attributes(payload)["evidence"] = invalid
                with self.assertRaisesRegex(ValidationError, expected):
                    validate_payload(payload)

    def test_schema_issue_stack_frame_bounds_match_validator(self) -> None:
        schema = self.load_schema()
        self.assertIn("issueStackFrame", schema["$defs"])
        frame = schema["$defs"]["issueStackFrame"]
        self.assertEqual(frame["type"], "object")
        self.assertEqual(frame["additionalProperties"], False)
        self.assertEqual(set(frame["required"]), {"filename", "line", "column"})
        self.assertEqual(
            frame["properties"],
            {
                "filename": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048,
                    "pattern": r"^[^?#\u0000-\u001f\u007f]+$",
                },
                "line": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
                "column": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
                "function": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 256,
                    "pattern": r"^(?=.*\S)[^\u0000-\u001f\u007f]+$",
                },
                "module": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512,
                    "pattern": r"^(?=.*\S)[^?#\u0000-\u001f\u007f]+$",
                },
                "inApp": {"type": "boolean"},
                "debugId": {
                    "type": "string",
                    "pattern": (
                        r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                        r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
                    ),
                },
            },
        )


if __name__ == "__main__":
    unittest.main()
