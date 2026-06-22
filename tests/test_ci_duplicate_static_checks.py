from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_ci_no_duplicate_static_checks.py"
SPEC = importlib.util.spec_from_file_location("check_ci_no_duplicate_static_checks", MODULE_PATH)
assert SPEC is not None
check_ci_no_duplicate_static_checks = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_ci_no_duplicate_static_checks)


class CiDuplicateStaticChecksTests(unittest.TestCase):
    def test_repo_workflows_do_not_directly_run_local_static_gates(self) -> None:
        self.assertEqual(check_ci_no_duplicate_static_checks.validate(ROOT), [])

    def test_blacksmith_workflow_rejects_direct_static_script(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "publish-packages.yml").write_text(
                """
jobs:
  pypi:
    runs-on: blacksmith-2vcpu-ubuntu-2404
    steps:
      - name: Run shell static checks
        run: bash scripts/check_shell_static.sh
""",
                encoding="utf-8",
            )

            failures = check_ci_no_duplicate_static_checks.validate(root)

        self.assertTrue(any("check_shell_static.sh" in failure for failure in failures))

    def test_package_and_real_user_evidence_steps_are_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "ci.yml").write_text(
                """
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - name: Run JavaScript package checks
        run: bash scripts/check_js_package.sh
      - name: Run JavaScript real-user smoke test
        run: bash scripts/real_user_js_smoke.sh
""",
                encoding="utf-8",
            )

            failures = check_ci_no_duplicate_static_checks.validate(root)

        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
