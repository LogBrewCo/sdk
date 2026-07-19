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
            (root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew").mkdir(parents=True)
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
            (root / "scripts" / "real_user_dotnet_smoke.sh").write_text(
                f"private readonly Cancellation{cancellation_member}Source cancellation = new {cancellation_source}();\n",
                encoding="utf-8",
            )
            (root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew" / "LogBrew.cs").write_text(
                "#pragma warning " + "rest" + "ore CA1031\n"
                "return SendAsync(request, cancellation" + "To" + "ken);\n",
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

    def test_allows_fixed_dotnet_durability_terms_only_at_owned_syntax(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            source_dir = root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew"
            test_dir = root / "dotnet" / "logbrew-dotnet" / "tests" / "LogBrew.Tests"
            workflow_dir.mkdir(parents=True)
            source_dir.mkdir(parents=True)
            test_dir.mkdir(parents=True)
            workflow_word = "stra" + "tegy"
            sensitive_word = "sec" + "ret"
            maintenance_word = "clean" + "up"
            windows_share_read = "WindowsS" + "hareRead"
            windows_share_write = "WindowsS" + "hareWrite"
            windows_share_delete = "WindowsS" + "hareDelete"
            windows_archive_semantics = "WindowsBack" + "upSemantics"
            (workflow_dir / "ci.yml").write_text(
                f"    {workflow_word}:\n",
                encoding="utf-8",
            )
            (root / "dotnet" / "logbrew-dotnet" / "README.md").write_text(
                "Only one process may own a store. Recovery fails closed for missing or wrong keys, "
                "corruption, unknown files, unsafe ownership, links, or replacement. Supply one primary "
                "key and a bounded list of previous keys to rotate records during recovery; new records "
                f"always use the primary key. Key IDs identify keys but are not {sensitive_word} and must contain "
                "only stable letters, numbers, `.`, `_`, or `-`.\n",
                encoding="utf-8",
            )
            (source_dir / "DurableEventStore.cs").write_text(
                f"Clean{maintenance_word[5:]}Acknowledged(recordNames);\n",
                encoding="utf-8",
            )
            (source_dir / "DurableStoreFileSystem.cs").write_text(
                f"private const uint {windows_share_read} = 1;\n"
                f"private const uint {windows_share_write} = 2;\n"
                f"private const uint {windows_share_delete} = 4;\n"
                f"private const uint {windows_archive_semantics} = 0x02000000;\n"
                f"{windows_share_read} | {windows_share_delete},\n"
                f"{windows_share_read} | (allowDelete ? {windows_share_delete} : 0),\n"
                f"{windows_share_read} | {windows_share_write},\n"
                f"{windows_archive_semantics} | WindowsOpenReparsePoint,\n",
                encoding="utf-8",
            )
            (test_dir / "DurableDeliveryContractTests.cs").write_text(
                f"AcknowledgedPrefixClean{maintenance_word[5:]}ResumesAfterExit();\n"
                f'"acknowledged prefix reappeared after {maintenance_word} restart";\n',
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_dotnet_durability_allowances_do_not_allow_free_form_terms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_word = "stra" + "tegy"
            sensitive_word = "sec" + "ret"
            maintenance_word = "clean" + "up"
            visibility_word = "pri" + "vate"
            archive_word = "back" + "up"
            (root / "notes.txt").write_text(
                f"business {workflow_word}\n"
                "cust" + f"omer {sensitive_word}\n"
                f"{maintenance_word} {visibility_word} {archive_word}\n",
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 3)

    def test_dotnet_durability_owned_paths_reject_near_misses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            source_dir = root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew"
            test_dir = root / "dotnet" / "logbrew-dotnet" / "tests" / "LogBrew.Tests"
            workflow_dir.mkdir(parents=True)
            source_dir.mkdir(parents=True)
            test_dir.mkdir(parents=True)
            workflow_word = "stra" + "tegy"
            sensitive_word = "sec" + "ret"
            maintenance_word = "clean" + "up"
            archive_word = "back" + "up"
            remote_word = "s" + "sh"
            windows_share_read = "WindowsS" + "hareRead"
            (workflow_dir / "ci.yml").write_text(
                f"    custom-{workflow_word}:\n",
                encoding="utf-8",
            )
            (root / "dotnet" / "logbrew-dotnet" / "README.md").write_text(
                f"The value is {sensitive_word}.\n",
                encoding="utf-8",
            )
            (source_dir / "DurableEventStore.cs").write_text(
                f"var pending{maintenance_word.title()} = true;\n",
                encoding="utf-8",
            )
            (source_dir / "DurableStoreFileSystem.cs").write_text(
                f"private const uint Windows{archive_word.title()}Policy = 1;\n"
                f"private const uint {windows_share_read} = 1; // {remote_word} {archive_word}\n",
                encoding="utf-8",
            )
            (test_dir / "DurableDeliveryContractTests.cs").write_text(
                f'"unexpected {maintenance_word} behavior";\n',
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 6)

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

    def test_allows_maven_central_preflight_secret_names_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            workflow_dir.mkdir(parents=True)
            scripts_dir = root / "scripts"
            scripts_dir.mkdir()
            tests_dir = root / "tests"
            tests_dir.mkdir()
            (workflow_dir / "publish-packages.yml").write_text(
                "CENTRAL_PORTAL_USERNAME: ${{ secrets.CENTRAL_PORTAL_USERNAME }}\n"
                "CENTRAL_PORTAL_PASSWORD: ${{ secrets.CENTRAL_PORTAL_PASSWORD }}\n",
                encoding="utf-8",
            )
            (scripts_dir / "check_maven_central_auth_preflight.sh").write_text(
                '${CENTRAL_PORTAL_PASSWORD:-}\n'
                "os.environ['CENTRAL_PORTAL_USERNAME']\n"
                "os.environ['CENTRAL_PORTAL_PASSWORD']\n"
                "generated Central Portal publishing values\n",
                encoding="utf-8",
            )
            (tests_dir / "test_maven_central_auth_preflight.py").write_text(
                '"CENTRAL_PORTAL_PASSWORD": password\n'
                '"fixture-user-token"\n'
                '"fixture-secret-token"\n',
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
