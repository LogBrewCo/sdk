from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE_COMMAND = "bash scripts/real_user_js_release_artifact_smoke.sh"


class ReleaseArtifactSmokeGateTests(unittest.TestCase):
    def test_workflows_run_release_artifact_smoke(self) -> None:
        for workflow in (
            ROOT / ".github" / "workflows" / "ci.yml",
            ROOT / ".github" / "workflows" / "release-readiness.yml",
        ):
            text = workflow.read_text(encoding="utf-8")

            with self.subTest(workflow=workflow.name):
                self.assertIn("Run JavaScript release artifact smoke", text)
                self.assertIn(f"run: {SMOKE_COMMAND}", text)

    def test_readiness_checklist_mentions_release_artifact_smoke(self) -> None:
        checklist = (ROOT / "docs" / "sdk-readiness-checklist.md").read_text(encoding="utf-8")

        self.assertIn(f"JavaScript release-artifact dry-run proof: `{SMOKE_COMMAND}`", checklist)


if __name__ == "__main__":
    unittest.main()
