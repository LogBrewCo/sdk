from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ci_unit_test_targets.py"
SPEC = importlib.util.spec_from_file_location("ci_unit_test_targets", SCRIPT)
assert SPEC is not None
ci_unit_test_targets = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ci_unit_test_targets)


class CiUnitTestTargetsTests(unittest.TestCase):
    def test_ci_workflow_change_runs_workflow_unit_tests_not_every_test(self) -> None:
        targets = ci_unit_test_targets.select_targets([".github/workflows/ci.yml"])

        self.assertFalse(targets.run_all)
        self.assertIn("tests.test_ci_changed_areas", targets.modules)
        self.assertIn("tests.test_ci_duplicate_static_checks", targets.modules)
        self.assertIn("tests.test_github_release_safety_gates", targets.modules)
        self.assertNotIn("tests.test_rust_dependency_smoke_gates", targets.modules)

    def test_maven_smoke_change_runs_only_maven_unit_test(self) -> None:
        targets = ci_unit_test_targets.select_targets(
            ["scripts/real_user_maven_central_public_smoke.sh"]
        )

        self.assertFalse(targets.run_all)
        self.assertEqual(targets.modules, ("tests.test_maven_central_public_smoke",))

    def test_changed_test_file_runs_that_module(self) -> None:
        targets = ci_unit_test_targets.select_targets(["tests/test_ci_changed_areas.py"])

        self.assertFalse(targets.run_all)
        self.assertEqual(targets.modules, ("tests.test_ci_changed_areas",))

    def test_unknown_python_script_falls_back_to_full_discovery(self) -> None:
        targets = ci_unit_test_targets.select_targets(["scripts/new_unknown_helper.py"])

        self.assertTrue(targets.run_all)
        self.assertEqual(targets.modules, ())

    def test_ingest_contract_changes_select_only_the_endpoint_contract(self) -> None:
        targets = ci_unit_test_targets.select_targets(
            [
                "js/logbrew-node/index.js",
                "scripts/real_user_node_ingest_contract_smoke.sh",
                "tests/test_default_ingest_endpoints.py",
            ]
        )

        self.assertFalse(targets.run_all)
        self.assertEqual(targets.modules, ("tests.test_default_ingest_endpoints",))


if __name__ == "__main__":
    unittest.main()
