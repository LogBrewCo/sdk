from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ci_changed_areas.py"
SPEC = importlib.util.spec_from_file_location("ci_changed_areas", SCRIPT)
assert SPEC is not None
ci_changed_areas = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ci_changed_areas)


class CiChangedAreasTests(unittest.TestCase):
    def test_maven_smoke_change_does_not_enable_other_sdk_smokes(self) -> None:
        areas = ci_changed_areas.classify(
            [
                "scripts/real_user_maven_central_public_smoke.sh",
                "tests/test_maven_central_public_smoke.py",
            ]
        )

        self.assertTrue(areas["maven"])
        for area in ("release_artifacts", "rust", "javascript", "swift", "objc", "kotlin"):
            with self.subTest(area=area):
                self.assertFalse(areas[area])

    def test_maven_publish_workflow_change_keeps_dotfile_path(self) -> None:
        areas = ci_changed_areas.classify([".github/workflows/publish-packages.yml"])

        self.assertTrue(areas["maven"])
        self.assertFalse(areas["javascript"])

    def test_language_owned_paths_enable_only_that_language_area(self) -> None:
        cases = {
            "rust/logbrew/src/lib.rs": "rust",
            "js/logbrew-js/src/index.ts": "javascript",
            "python/logbrew_py/src/logbrew/__init__.py": "python",
            "go/logbrew/logbrew.go": "go",
            "java/logbrew-java/src/main/java/co/logbrew/sdk/LogBrewClient.java": "java",
            "swift/logbrew-swift/Sources/LogBrew/LogBrew.swift": "swift",
            "objc/logbrew-objc/Sources/LogBrew.m": "objc",
            "kotlin/logbrew-kotlin/src/main/kotlin/LogBrew.kt": "kotlin",
        }
        for path, expected_area in cases.items():
            with self.subTest(path=path):
                areas = ci_changed_areas.classify([path])
                self.assertTrue(areas[expected_area])
                self.assertFalse(areas["maven"])

    def test_release_artifact_scripts_enable_only_release_artifact_area(self) -> None:
        areas = ci_changed_areas.classify(
            ["scripts/real_user_next_release_artifact_smoke.sh"]
        )

        self.assertTrue(areas["release_artifacts"])
        self.assertFalse(areas["maven"])
        self.assertFalse(areas["rust"])

    def test_native_release_public_smoke_enables_only_c_area(self) -> None:
        areas = ci_changed_areas.classify(
            ["scripts/real_user_native_release_public_smoke.sh"]
        )

        self.assertTrue(areas["c"])
        self.assertFalse(areas["release_artifacts"])
        for area in ("javascript", "cpp", "swift", "objc"):
            with self.subTest(area=area):
                self.assertFalse(areas[area])

    def test_ci_workflow_uses_changed_areas_instead_of_repo_presence(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("name: Detect changed SDK areas", workflow)
        self.assertIn("needs: changed-areas", workflow)
        self.assertIn("unit_test_run_all", workflow)
        self.assertIn("unit_test_modules", workflow)
        self.assertIn("Run focused unit tests", workflow)
        self.assertIn("Run full unit tests", workflow)
        self.assertIn("needs.changed-areas.outputs.maven == 'true'", workflow)
        self.assertIn("Run Maven Central public install smoke", workflow)
        self.assertIn("needs.changed-areas.outputs.rust == 'true'", workflow)
        self.assertIn("needs.changed-areas.outputs.javascript == 'true'", workflow)
        self.assertIn("needs.changed-areas.outputs.swift == 'true'", workflow)
        self.assertIn("needs.changed-areas.outputs.objc == 'true'", workflow)
        self.assertIn("needs.changed-areas.outputs.kotlin == 'true'", workflow)
        self.assertNotIn("hashFiles(", workflow)

    def test_contract_checks_budget_preserves_changed_area_gates(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        contract_job = workflow.split("\n  contract-checks:\n", 1)[1].split(
            "\n  dotnet-durability:\n", 1
        )[0]

        self.assertIn("timeout-minutes: 60", contract_job)
        for area in (
            "release_artifacts",
            "rust",
            "javascript",
            "python",
            "go",
            "c",
            "cpp",
            "java",
            "dotnet",
            "unity",
            "ruby",
            "php",
            "kotlin",
            "maven",
        ):
            with self.subTest(area=area):
                self.assertIn(f"needs.changed-areas.outputs.{area}", contract_job)


if __name__ == "__main__":
    unittest.main()
