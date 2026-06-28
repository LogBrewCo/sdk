from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_confidentiality_scan.py"
SPEC = importlib.util.spec_from_file_location("check_confidentiality_scan", MODULE_PATH)
assert SPEC is not None
check_confidentiality_scan = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_confidentiality_scan)


class ConfidentialityScanTests(unittest.TestCase):
    def test_repo_confidentiality_scan_passes(self) -> None:
        self.assertEqual(check_confidentiality_scan.validate(ROOT), [])

    def test_allows_intentional_sdk_fixture_terms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "js" / "logbrew-angular").mkdir(parents=True)
            (root / "scripts").mkdir()
            (root / "unity" / "logbrew-unity" / "Runtime").mkdir(parents=True)
            (root / "python" / "logbrew_py" / "src" / "logbrew_sdk").mkdir(parents=True)
            angular_keyword = "Injection" + "To" + "ken"
            fake_query = "?to" + "ken=sec" + "ret"
            cleaner_name = "clean" + "up"
            cancellation_source = "Cancellation" + "To" + "kenSource"
            cancellation_member = ".To" + "ken"
            (root / "js" / "logbrew-angular" / "index.js").write_text(
                f'export const LOG_BREW_ANGULAR_CONTEXT = new {angular_keyword}("LogBrew Angular context");\n',
                encoding="utf-8",
            )
            (root / "scripts" / "real_user_node_smoke.sh").write_text(
                f"fetch(`http://127.0.0.1:3000/fail{fake_query}`)\n"
                f"{cleaner_name}() {{\n"
                "}\n",
                encoding="utf-8",
            )
            (root / "unity" / "logbrew-unity" / "Runtime" / "PublicTypes.cs").write_text(
                f"using var cancellation = new {cancellation_source}();\n"
                f"await client.SendAsync(request, cancellation{cancellation_member}).ConfigureAwait(false);\n",
                encoding="utf-8",
            )
            (root / "python" / "logbrew_py" / "src" / "logbrew_sdk" / "_db_client.py").write_text(
                "_DB_SPAN_EVENT_METADATA_DENYLIST = (\n"
                f'    "sec{"ret"}",\n'
                f'    "to{"ken"}",\n'
                ")\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_allows_generated_brand_svg_image_carriers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brand_dir = root / "assets" / "brand"
            brand_dir.mkdir(parents=True)
            sensitive_line = "embedded generated image carrier to" + "ken-shaped base64 text\n"
            (brand_dir / "logbrew-logo-espresso-bg-512.svg").write_text(
                sensitive_line,
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_allows_sdk_instrumentation_uninstall_terms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "js" / "logbrew-kafkajs"
            package_dir.mkdir(parents=True)
            scripts_dir = root / "scripts"
            scripts_dir.mkdir()
            undo_member = "rest" + "ores"
            undo_label = "rest" + "ores"
            (package_dir / "index.js").write_text(
                f'state.{undo_member}.push(installMethod(producer, "send", () => {{}}));\n'
                f"state.{undo_member}.pop()();\n",
                encoding="utf-8",
            )
            (scripts_dir / "real_user_kafkajs_smoke.sh").write_text(
                f'assertEqual(client.pendingEvents(), pendingAfterUninstall, "uninstall {undo_label} original send");\n',
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_reports_unexpected_sensitive_terms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sensitive_line = "production " + "pass" + "word: hunter2\n"
            (root / "README.md").write_text(sensitive_line, encoding="utf-8")

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn("production " + "pass" + "word", failures[0])

    def test_reports_forbidden_public_planning_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "skills-lock.json").write_text('{"version": 1}\n', encoding="utf-8")

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn("skills-lock.json", failures[0])
        self.assertIn("forbidden public planning file", failures[0])

    def test_allows_local_ignored_agent_redirect_and_plans(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.DEVNULL)
            (root / ".gitignore").write_text("AGENTS.md\nplans/\n", encoding="utf-8")
            sensitive_term = "cre" + "dential"
            planning_term = "stra" + "tegy"
            (root / "AGENTS.md").write_text(
                f"Read private guidance. Do not copy {sensitive_term} or backend/storage details.\n",
                encoding="utf-8",
            )
            (root / "plans").mkdir()
            (root / "plans" / "private-plan.md").write_text(
                f"Local private plan with {planning_term} notes.\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])


if __name__ == "__main__":
    unittest.main()
