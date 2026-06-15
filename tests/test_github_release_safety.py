from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_github_release_safety.py"
SPEC = importlib.util.spec_from_file_location("check_github_release_safety", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
check_github_release_safety = importlib.util.module_from_spec(SPEC)
sys.modules["check_github_release_safety"] = check_github_release_safety
SPEC.loader.exec_module(check_github_release_safety)


def branch_protection(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "required_status_checks": {
            "strict": True,
            "contexts": ["Contract checks"],
            "checks": [{"context": "Contract checks"}],
        },
        "allow_force_pushes": {"enabled": False},
        "allow_deletions": {"enabled": False},
    }
    payload.update(overrides)
    return payload


def environment(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "release",
        "deployment_branch_policy": {
            "protected_branches": True,
            "custom_branch_policies": False,
        },
        "protection_rules": [{"type": "branch_policy"}],
        "can_admins_bypass": True,
    }
    payload.update(overrides)
    return payload


def branch_summary(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "main",
        "protected": True,
        "protection": {
            "enabled": True,
            "required_status_checks": {
                "contexts": ["Contract checks"],
                "checks": [{"context": "Contract checks"}],
            },
        },
    }
    payload.update(overrides)
    return payload


class GitHubReleaseSafetyTests(unittest.TestCase):
    def test_accepts_current_release_safety_shape(self) -> None:
        failures = check_github_release_safety.release_safety_failures(
            branch_protection(),
            environment(),
        )

        self.assertEqual(failures, [])

    def test_requires_strict_contract_checks(self) -> None:
        failures = check_github_release_safety.release_safety_failures(
            branch_protection(required_status_checks={"strict": False, "contexts": []}),
            environment(),
        )

        self.assertIn("main: required status checks must be strict", failures)
        self.assertIn("main: required status check 'Contract checks' is missing", failures)

    def test_rejects_force_push_and_branch_deletion(self) -> None:
        failures = check_github_release_safety.release_safety_failures(
            branch_protection(
                allow_force_pushes={"enabled": True},
                allow_deletions={"enabled": True},
            ),
            environment(),
        )

        self.assertIn("main: force pushes must stay disabled", failures)
        self.assertIn("main: branch deletion must stay disabled", failures)

    def test_requires_explicit_force_push_and_deletion_state(self) -> None:
        payload = branch_protection()
        del payload["allow_force_pushes"]
        del payload["allow_deletions"]

        failures = check_github_release_safety.release_safety_failures(payload, environment())

        self.assertIn("main: force-push protection state is missing", failures)
        self.assertIn("main: branch-deletion protection state is missing", failures)

    def test_requires_protected_branch_environment_policy(self) -> None:
        failures = check_github_release_safety.release_safety_failures(
            branch_protection(),
            environment(
                deployment_branch_policy={
                    "protected_branches": False,
                    "custom_branch_policies": True,
                },
                protection_rules=[],
            ),
        )

        self.assertIn("release: deployments must be restricted to protected branches", failures)
        self.assertIn("release: custom branch policies should stay disabled", failures)
        self.assertIn("release: branch policy protection rule is missing", failures)

    def test_accepts_public_branch_summary_shape_for_ci_auth(self) -> None:
        failures = check_github_release_safety.public_summary_release_safety_failures(
            branch_summary(),
            environment(),
        )

        self.assertEqual(failures, [])

    def test_public_branch_summary_requires_protected_branch_and_context(self) -> None:
        failures = check_github_release_safety.public_summary_release_safety_failures(
            branch_summary(protected=False, protection={"enabled": True, "required_status_checks": {}}),
            environment(),
        )

        self.assertIn("main: branch must be protected", failures)
        self.assertIn("main: required status check 'Contract checks' is missing", failures)

    def test_main_supports_fixture_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            branch_path = root / "branch.json"
            environment_path = root / "environment.json"
            branch_path.write_text(json.dumps(branch_protection()), encoding="utf-8")
            environment_path.write_text(json.dumps(environment()), encoding="utf-8")

            result = check_github_release_safety.main(
                [
                    "--branch-protection-json",
                    str(branch_path),
                    "--environment-json",
                    str(environment_path),
                ]
            )

        self.assertEqual(result, 0)

    def test_main_supports_public_branch_summary_fixture_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            branch_path = root / "branch.json"
            environment_path = root / "environment.json"
            branch_path.write_text(json.dumps(branch_summary()), encoding="utf-8")
            environment_path.write_text(json.dumps(environment()), encoding="utf-8")

            result = check_github_release_safety.main(
                [
                    "--branch-summary-json",
                    str(branch_path),
                    "--environment-json",
                    str(environment_path),
                ]
            )

        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main()
