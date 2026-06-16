from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMMAND = "python3 scripts/check_github_release_safety.py"
WORKFLOW_COMMAND = f"{COMMAND} --allow-public-branch-summary"


class GitHubReleaseSafetyGateTests(unittest.TestCase):
    def test_workflows_run_release_safety_with_github_auth_env(self) -> None:
        auth_env = "GH_" + "TO" + "KEN: ${{ github." + "to" + "ken }}"
        for workflow in (
            ROOT / ".github" / "workflows" / "ci.yml",
            ROOT / ".github" / "workflows" / "release-readiness.yml",
        ):
            text = workflow.read_text(encoding="utf-8")

            with self.subTest(workflow=workflow.name):
                self.assertIn("Check GitHub release safety", text)
                self.assertIn(auth_env, text)
                self.assertIn(f"run: {WORKFLOW_COMMAND}", text)

    def test_public_verifier_runs_release_safety_before_docs_checks(self) -> None:
        script = (ROOT / "scripts" / "check_public_sdks.sh").read_text(encoding="utf-8")

        self.assertIn('"GitHub release safety checks"', script)
        self.assertIn(f'run_shell_step "{COMMAND}"', script)
        release_step = re.search(r'begin_next_step "GitHub release safety checks"', script)
        docs_step = re.search(r'begin_next_step "Markdown link checks"', script)
        self.assertIsNotNone(release_step)
        self.assertIsNotNone(docs_step)
        self.assertLess(
            release_step.start(),
            docs_step.start(),
        )

    def test_readiness_checklist_mentions_release_safety(self) -> None:
        checklist = (ROOT / "docs" / "sdk-readiness-checklist.md").read_text(encoding="utf-8")

        self.assertIn(f"GitHub release safety settings before publishing: `{COMMAND}`", checklist)


if __name__ == "__main__":
    unittest.main()
