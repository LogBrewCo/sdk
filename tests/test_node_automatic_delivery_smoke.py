from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "real_user_node_automatic_delivery_smoke.sh"
SMOKE_COMMAND = "bash scripts/real_user_node_automatic_delivery_smoke.sh"


class NodeAutomaticDeliverySmokeTests(unittest.TestCase):
    def test_smoke_proves_installed_esm_and_commonjs_automatic_delivery(self) -> None:
        text = SMOKE.read_text(encoding="utf-8")

        self.assertIn("npm pack", text)
        self.assertIn("type-proof.ts", text)
        self.assertIn("type-proof.cts", text)
        self.assertIn("esm-proof.mjs", text)
        self.assertIn("cjs-proof.cjs", text)
        self.assertIn("deliveryIntervalMs", text)
        self.assertIn("deliveryQueueThreshold", text)
        self.assertIn("stableRetry", text)
        self.assertIn("deliveryHealth()", text)
        self.assertIn("await client.shutdown()", text)

    def test_ci_and_release_readiness_run_the_installed_smoke(self) -> None:
        for workflow in (
            ROOT / ".github" / "workflows" / "ci.yml",
            ROOT / ".github" / "workflows" / "release-readiness.yml",
        ):
            text = workflow.read_text(encoding="utf-8")

            with self.subTest(workflow=workflow.name):
                self.assertIn("Run Node automatic delivery installed-artifact smoke test", text)
                self.assertIn(f"run: {SMOKE_COMMAND}", text)
                self.assertLess(
                    text.index("Run JavaScript high-load installed-artifact smoke test"),
                    text.index("Run Node automatic delivery installed-artifact smoke test"),
                )
                self.assertLess(
                    text.index("Run Node automatic delivery installed-artifact smoke test"),
                    text.index("Run JavaScript OpenTelemetry installed-artifact smoke test"),
                )


if __name__ == "__main__":
    unittest.main()
