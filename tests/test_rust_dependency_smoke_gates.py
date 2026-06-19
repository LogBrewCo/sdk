from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUST_DEPENDENCY_SMOKE_COMMAND = "bash scripts/real_user_rust_dependency_smoke.sh"


class RustDependencySmokeGateTests(unittest.TestCase):
    def test_workflows_run_rust_dependency_smoke(self) -> None:
        for workflow in (
            ROOT / ".github" / "workflows" / "ci.yml",
            ROOT / ".github" / "workflows" / "release-readiness.yml",
        ):
            text = workflow.read_text(encoding="utf-8")

            with self.subTest(workflow=workflow.name):
                self.assertIn("Run Rust dependency-span real-user smoke test", text)
                self.assertIn(f"run: {RUST_DEPENDENCY_SMOKE_COMMAND}", text)

    def test_public_verifier_runs_rust_dependency_smoke(self) -> None:
        script = (ROOT / "scripts" / "check_public_sdks.sh").read_text(encoding="utf-8")

        self.assertIn('"Rust dependency-span real-user smoke"', script)
        self.assertIn(f'run_shell_step "{RUST_DEPENDENCY_SMOKE_COMMAND}"', script)


if __name__ == "__main__":
    unittest.main()
