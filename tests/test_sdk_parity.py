from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_sdk_parity.py"


class SdkParityTests(unittest.TestCase):
    def _run(self, expected: dict[str, Any], actual: dict[str, Any], *args: str):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            expected_path = temp_root / "expected.json"
            actual_path = temp_root / "actual.json"
            expected_path.write_text(json.dumps(expected), encoding="utf-8")
            actual_path.write_text(json.dumps(actual), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(SCRIPT), *args, str(expected_path), str(actual_path)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

    @staticmethod
    def _payload() -> dict[str, Any]:
        return {
            "events": [
                {
                    "type": "log",
                    "timestamp": "2026-08-03T10:00:00Z",
                    "id": "evt_log_001",
                    "attributes": {"message": "worker started", "level": "info"},
                }
            ]
        }

    def test_exact_payload_passes(self) -> None:
        payload = self._payload()

        result = self._run(payload, payload)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("sdk parity ok", result.stdout)

    def test_additive_context_requires_explicit_mode(self) -> None:
        expected = self._payload()
        actual = self._payload()
        actual["events"][0]["attributes"]["context"] = {
            "schemaVersion": 1,
            "resource": {"runtime": {"name": "rust"}},
        }

        result = self._run(expected, actual)

        self.assertEqual(result.returncode, 1)
        self.assertIn("parity failed", result.stderr)

    def test_explicit_mode_allows_only_additive_context(self) -> None:
        expected = self._payload()
        actual = self._payload()
        actual["events"][0]["attributes"]["context"] = {
            "schemaVersion": 1,
            "resource": {"runtime": {"name": "rust"}},
        }

        result = self._run(expected, actual, "--allow-additive-context")

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_explicit_mode_still_rejects_other_drift(self) -> None:
        expected = self._payload()
        actual = self._payload()
        actual["events"][0]["attributes"]["context"] = {
            "schemaVersion": 1,
            "resource": {"runtime": {"name": "rust"}},
        }
        actual["events"][0]["attributes"]["level"] = "error"

        result = self._run(expected, actual, "--allow-additive-context")

        self.assertEqual(result.returncode, 1)
        self.assertIn("parity failed", result.stderr)

    def test_explicit_mode_does_not_ignore_non_object_context(self) -> None:
        expected = self._payload()
        actual = self._payload()
        actual["events"][0]["attributes"]["context"] = "invalid"

        result = self._run(expected, actual, "--allow-additive-context")

        self.assertEqual(result.returncode, 1)
        self.assertIn("parity failed", result.stderr)

    def test_explicit_mode_does_not_ignore_expected_context(self) -> None:
        expected = self._payload()
        expected["events"][0]["attributes"]["context"] = {
            "schemaVersion": 1,
            "resource": {"runtime": {"name": "expected"}},
        }
        actual = self._payload()
        actual["events"][0]["attributes"]["context"] = {
            "schemaVersion": 1,
            "resource": {"runtime": {"name": "actual"}},
        }

        result = self._run(expected, actual, "--allow-additive-context")

        self.assertEqual(result.returncode, 1)
        self.assertIn("parity failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
