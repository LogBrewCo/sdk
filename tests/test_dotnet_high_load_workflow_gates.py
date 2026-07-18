from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
RELEASE_READINESS = ROOT / ".github" / "workflows" / "release-readiness.yml"
SMOKE = ROOT / "scripts" / "real_user_dotnet_high_load_smoke.sh"


class DotnetHighLoadWorkflowGateTests(unittest.TestCase):
    def test_smoke_exercises_installed_high_load_retry_flush_and_shutdown(self) -> None:
        smoke = SMOKE.read_text(encoding="utf-8")

        self.assertIn("dotnet add", smoke)
        self.assertIn("dotnet remove", smoke)
        self.assertIn("HighVolumeLogs = 1500", smoke)
        self.assertIn('"droppedEvents":504', smoke)
        self.assertIn('"flushedEvents":1000', smoke)
        self.assertIn('"retryAttempts":11', smoke)
        self.assertIn('"automaticRequests":3', smoke)
        self.assertIn('"terminalRequests":3', smoke)
        self.assertIn("CreateAutomatic", smoke)
        self.assertIn("DeliveryHealth", smoke)
        self.assertIn("RecoverAutomaticDelivery", smoke)
        self.assertIn("Shutdown", smoke)
        self.assertIn("lbw_ingest_dotnet_high_load_fake", smoke)

    def test_release_readiness_runs_dotnet_high_load_after_core_smoke(self) -> None:
        workflow = RELEASE_READINESS.read_text(encoding="utf-8")
        expected_order = (
            "Run .NET package checks",
            "bash scripts/check_dotnet_package.sh",
            "Run .NET real-user smoke test",
            "bash scripts/real_user_dotnet_smoke.sh",
            "Run .NET high-load installed-artifact smoke test",
            "bash scripts/real_user_dotnet_high_load_smoke.sh",
        )
        positions = {step: workflow.find(step) for step in expected_order}

        self.assertEqual(
            {step: position for step, position in positions.items() if position == -1},
            {},
            ".NET release-readiness high-load smoke step is missing",
        )
        self.assertEqual(
            [positions[step] for step in expected_order],
            sorted(positions.values()),
            ".NET high-load smoke should run after package and core installed-artifact smokes",
        )


if __name__ == "__main__":
    unittest.main()
