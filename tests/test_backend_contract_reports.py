from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_backend_contract_reports.py"
SPEC = importlib.util.spec_from_file_location("check_backend_contract_reports", MODULE_PATH)
assert SPEC is not None
check_backend_contract_reports = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_backend_contract_reports)


VALID_REPORT = """# Backend Contract Report: Example - 2026-06-14

## Status

Backend handoff is pending because no backend automation/thread target is exposed.

## Priority

P1 - Blocks release confidence for the affected SDK workflow.

## User Impact

Developers cannot trust this workflow in production until the backend supports it.

## Expected Backend Capability

Suggested APIs:

- `POST /api/example` with event fields `release`, `environment`, and `service`.

## SDK Gap Observed

The SDK can prepare data locally, but there is no backend endpoint to accept it.

## Verification Needed

- Unit tests for validation failure.
- Local smoke proof for success and retryable failure.
"""
PRIORITY_BLOCK = (
    "## Priority\n\n"
    "P1 - Blocks release confidence for the affected SDK workflow.\n\n"
)


class BackendContractReportTests(unittest.TestCase):
    def test_repo_backend_contract_reports_pass(self) -> None:
        self.assertEqual(check_backend_contract_reports.validate(ROOT), [])

    def test_release_artifact_report_tracks_react_native_native_artifact_paths(self) -> None:
        report = (
            ROOT
            / "docs"
            / "backend-contracts"
            / "release-artifact-symbolication-2026-06-13.md"
        ).read_text(encoding="utf-8")

        self.assertIn("React Native-shaped Android mapping/native `.so`", report)
        self.assertIn("iOS `.xcarchive/dSYMs`", report)

    def test_release_artifact_report_tracks_backend_partial_symbolication_rollout(self) -> None:
        report = (
            ROOT
            / "docs"
            / "backend-contracts"
            / "release-artifact-symbolication-2026-06-13.md"
        ).read_text(encoding="utf-8")

        self.assertIn("sent to backend coordination", report)
        self.assertIn("auth-gated release-artifact upload, lookup, byte retention, and one-frame JavaScript symbolication", report)
        self.assertIn("scoped live upload/lookup/retention/symbolication verification", report)
        self.assertNotIn("no backend release-artifact route/schema/lookup surface", report)
        self.assertNotIn("no backend automation/thread target is exposed", report)

    def test_support_ticket_report_blocks_sdk_network_calls_until_live_verified(self) -> None:
        report = (
            ROOT
            / "docs"
            / "backend-contracts"
            / "support-ticket-routes-2026-06-24.md"
        ).read_text(encoding="utf-8")

        self.assertIn("code-level verified locally but not deploy/live verified", report)
        self.assertIn("redacted post-deploy live verifier", report)
        self.assertIn("does not clear SDK network-call gating", report)
        self.assertIn("SDKs must not call `POST /api/support/tickets`", report)
        self.assertIn("explicit local diagnostics draft", report)

    def test_valid_report_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            report_dir = root / "docs" / "backend-contracts"
            report_dir.mkdir(parents=True)
            (report_dir / "example.md").write_text(VALID_REPORT, encoding="utf-8")

            failures = check_backend_contract_reports.validate(root)

        self.assertEqual(failures, [])

    def test_missing_priority_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            report_dir = root / "docs" / "backend-contracts"
            report_dir.mkdir(parents=True)
            (report_dir / "example.md").write_text(
                VALID_REPORT.replace(PRIORITY_BLOCK, ""),
                encoding="utf-8",
            )

            failures = check_backend_contract_reports.validate(root)

        self.assertTrue(any("missing required '## Priority'" in failure for failure in failures))

    def test_missing_handoff_status_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            report_dir = root / "docs" / "backend-contracts"
            report_dir.mkdir(parents=True)
            (report_dir / "example.md").write_text(
                VALID_REPORT.replace(
                    "Backend handoff is pending because no backend automation/thread target is exposed.",
                    "This report is ready for backend work.",
                ),
                encoding="utf-8",
            )

            failures = check_backend_contract_reports.validate(root)

        self.assertTrue(any("Status must state backend handoff" in failure for failure in failures))


if __name__ == "__main__":
    unittest.main()
