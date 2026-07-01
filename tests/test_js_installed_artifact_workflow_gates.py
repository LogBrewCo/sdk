from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JS_HIGH_LOAD_SMOKE_COMMAND = "bash scripts/real_user_js_high_load_smoke.sh"
JS_OPENTELEMETRY_SMOKE_COMMAND = "bash scripts/real_user_js_opentelemetry_smoke.sh"


class JsInstalledArtifactWorkflowGateTests(unittest.TestCase):
    def test_workflows_run_js_installed_artifact_smokes_before_browser(self) -> None:
        for workflow in (
            ROOT / ".github" / "workflows" / "ci.yml",
            ROOT / ".github" / "workflows" / "release-readiness.yml",
        ):
            text = workflow.read_text(encoding="utf-8")

            with self.subTest(workflow=workflow.name):
                self.assertIn("Run JavaScript high-load installed-artifact smoke test", text)
                self.assertIn(f"run: {JS_HIGH_LOAD_SMOKE_COMMAND}", text)
                self.assertIn("Run JavaScript OpenTelemetry installed-artifact smoke test", text)
                self.assertIn(f"run: {JS_OPENTELEMETRY_SMOKE_COMMAND}", text)
                self.assertLess(
                    text.index("Run JavaScript real-user smoke test"),
                    text.index("Run JavaScript high-load installed-artifact smoke test"),
                )
                self.assertLess(
                    text.index("Run JavaScript high-load installed-artifact smoke test"),
                    text.index("Run JavaScript OpenTelemetry installed-artifact smoke test"),
                )
                self.assertLess(
                    text.index("Run JavaScript OpenTelemetry installed-artifact smoke test"),
                    text.index("Run Browser real-user smoke test"),
                )


if __name__ == "__main__":
    unittest.main()
