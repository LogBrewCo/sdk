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


if __name__ == "__main__":
    unittest.main()
