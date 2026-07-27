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
    def test_allows_only_exact_native_archive_exclusion_symbols(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            android_path = (
                root
                / "js"
                / "logbrew-react-native"
                / "android"
                / "src"
                / "main"
                / "java"
                / "co"
                / "logbrew"
                / "reactnative"
                / "FatalStoreModuleImpl.java"
            )
            apple_path = (
                root
                / "js"
                / "logbrew-react-native"
                / "ios"
                / "LBRNFatalStoreModule.mm"
            )
            swift_path = (
                root
                / "swift"
                / "logbrew-swift"
                / "Sources"
                / "LogBrewCrash"
                / "CrashStorageDirectory.swift"
            )
            swift_test_path = (
                root
                / "swift"
                / "logbrew-swift"
                / "Tests"
                / "LogBrewCrashTests"
                / "NativeHangIncidentStoreTests.swift"
            )
            android_path.parent.mkdir(parents=True)
            apple_path.parent.mkdir(parents=True)
            swift_path.parent.mkdir(parents=True)
            swift_test_path.parent.mkdir(parents=True)
            archive_term = "back" + "up"
            android_path.write_text(
                f"File root = context.getNo{archive_term.title()}FilesDir();\n",
                encoding="utf-8",
            )
            apple_path.write_text(
                (
                    "[url setResourceValue:@YES "
                    f"forKey:NSURLIsExcludedFrom{archive_term.title()}Key error:nil];\n"
                ),
                encoding="utf-8",
            )
            swift_path.write_text(
                f"values.isExcludedFrom{archive_term.title()} = true\n",
                encoding="utf-8",
            )
            swift_test_path.write_text(
                f"#expect(values.isExcludedFrom{archive_term.title()} == true)\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            android_path.write_text(
                android_path.read_text(encoding="utf-8")
                + f"// arbitrary {archive_term} language remains forbidden\n",
                encoding="utf-8",
            )
            swift_path.write_text(
                swift_path.read_text(encoding="utf-8")
                + f"// arbitrary {archive_term} language remains forbidden\n",
                encoding="utf-8",
            )
            swift_test_path.write_text(
                swift_test_path.read_text(encoding="utf-8")
                + f"// arbitrary {archive_term} language remains forbidden\n",
                encoding="utf-8",
            )
            unrelated = root / "Other.java"
            unrelated.write_text(
                f"context.getNo{archive_term.title()}FilesDir();\n",
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 4)
        self.assertTrue(any("arbitrary" in failure for failure in failures))
        self.assertTrue(any("Other.java" in failure for failure in failures))
        self.assertTrue(any("CrashStorageDirectory.swift" in failure for failure in failures))
        self.assertTrue(any("NativeHangIncidentStoreTests.swift" in failure for failure in failures))

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

    def test_allows_only_exact_dotnet_release_compatibility_terms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            scripts_dir = root / "scripts"
            tests_dir = root / "tests"
            unrelated_dir = root / "dotnet"
            workflow_dir.mkdir(parents=True)
            scripts_dir.mkdir()
            tests_dir.mkdir()
            unrelated_dir.mkdir()
            dependency_action = "rest" + "ore"
            identity_member = "PublicKey" + "To" + "ken"
            identity_value = "to" + "ken"
            (workflow_dir / "publish-nuget.yml").write_text(
                f"dotnet {dependency_action} dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj\n"
                f"dotnet pack dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj --no-{dependency_action}\n",
                encoding="utf-8",
            )
            (scripts_dir / "real_user_dotnet_httpclient_package_compatibility_smoke.sh").write_text(
                f"Get{identity_member}()\n"
                f'return {identity_value} == null || {identity_value}.Length == 0 ? "unsigned" '
                f": Convert.ToHexString({identity_value}).ToLowerInvariant();\n",
                encoding="utf-8",
            )
            (tests_dir / "test_dotnet_httpclient_package_compatibility_smoke.py").write_text(
                f'"Get{identity_member}"\n',
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            (unrelated_dir / "Other.cs").write_text(
                f"Get{identity_member}()\n",
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn("Other.cs", failures[0])

    def test_allows_only_exact_reusable_workflow_inheritance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            workflow_dir.mkdir(parents=True)
            inheritance_key = "se" + "crets"
            (workflow_dir / "publish-packages.yml").write_text(
                f"{inheritance_key}: inherit\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            (workflow_dir / "other.yml").write_text(
                f"{inheritance_key}: inherit\n",
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn("other.yml", failures[0])

    def test_allows_only_standard_github_workflow_authorization_placeholders(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            workflow_dir.mkdir(parents=True)
            sensitive_name = "to" + "ken"
            workflow = workflow_dir / "reconcile.yml"
            workflow.write_text(
                f"GITHUB_AUTHORIZATION: ${{{{ github.{sensitive_name} }}}}\n"
                f"github-{sensitive_name}: ${{{{ github.{sensitive_name} }}}}\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            workflow.write_text(
                f"github-{sensitive_name}: untrusted-value\n",
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn("reconcile.yml", failures[0])

    def test_allows_only_exact_python_registry_host_property_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts_dir = root / "scripts"
            scripts_dir.mkdir()
            smoke = scripts_dir / "real_user_python_public_pypi_smoke.sh"
            host_member = "host" + "name"
            smoke.write_text(
                f'if parsed.scheme != "https" or parsed.{host_member} != "files.pythonhosted.org":\n'
                f'if final_url.scheme != "https" or final_url.{host_member} != "files.pythonhosted.org":\n',
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            (scripts_dir / "other.py").write_text(
                f"print(request.{host_member})\n",
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn("other.py", failures[0])

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

    def test_allows_only_exact_java_aes_key_spec_references(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "java" / "logbrew-java" / "src" / "main" / "java" / "co" / "logbrew" / "sdk"
            package_dir.mkdir(parents=True)
            crypto = package_dir / "PersistenceCrypto.java"
            key_spec = "Sec" + "retKeySpec"
            crypto.write_text(
                f"import javax.crypto.spec.{key_spec};\n"
                f'new {key_spec}(key, "AES"),\n',
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            unsafe_name = "raw" + "Sec" + "ret"
            crypto.write_text(
                f"import javax.crypto.spec.{key_spec};\n"
                f'new {key_spec}({unsafe_name}, "AES"),\n',
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn(unsafe_name, failures[0])

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

    def test_allows_only_the_kscrash_report_deletion_policy_symbol(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "swift" / "logbrew-swift" / "Sources" / "LogBrewCrash"
            source_dir.mkdir(parents=True)
            policy = "reportClean" + "upPolicy"
            (source_dir / "CrashEngine.swift").write_text(
                f"configuration.{policy} = .never\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            (source_dir / "Other.swift").write_text(
                f"unexpected {policy}\n",
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)
            self.assertEqual(len(failures), 1)
            self.assertIn("Other.swift", failures[0])

    def test_allows_apple_durable_storage_terms_only_in_owned_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            durable_dir = root / "swift" / "logbrew-swift" / "Sources" / "LogBrew"
            durable_dir.mkdir(parents=True)
            allowed = durable_dir / "DurableDeliveryStoreRecovery.swift"
            archive_label = "back" + "up"
            cleaner_name = "clean" + "up"
            allowed.write_text(
                f"exclude durable files from {archive_label} and {cleaner_name} invalid records\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

            unrelated = durable_dir / "DeliveryEngine.swift"
            unrelated.write_text(
                f"unexpected {archive_label} {cleaner_name} guidance\n",
                encoding="utf-8",
            )
            failures = check_confidentiality_scan.validate(root)
            self.assertEqual(len(failures), 1)
            self.assertIn("DeliveryEngine.swift", failures[0])

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

    def test_allows_release_artifact_build_auth_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            js_dir = root / "js" / "logbrew-js"
            next_dir = root / "js" / "logbrew-next"
            js_dir.mkdir(parents=True)
            next_dir.mkdir(parents=True)
            auth_option = "to" + "kenEnv"
            (js_dir / "release-artifacts-build.cjs").write_text(
                f"const {auth_option} = upload.{auth_option};\n",
                encoding="utf-8",
            )
            (next_dir / "release-artifacts.d.ts").write_text(
                f"{auth_option}?: string;\n",
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

    def test_sensitive_match_does_not_cross_identifier_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "java" / "logbrew-java" / "src" / "main" / "java"
            source_dir.mkdir(parents=True)
            source = source_dir / "AutomaticDeliveryController.java"
            source.write_text(
                "ProcessHandle owner = ProcessHandle.current();\n"
                "return ProcessHandle.current().equals(owner);\n",
                encoding="utf-8",
            )
            remote_term = "s" + "sh_private_key"
            unsafe = root / "unsafe.txt"
            unsafe.write_text(f"{remote_term}=fixture\n", encoding="utf-8")

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn(remote_term, failures[0])

    def test_reports_forbidden_public_planning_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "skills-lock.json").write_text('{"version": 1}\n', encoding="utf-8")

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn("skills-lock.json", failures[0])
        self.assertIn("forbidden public planning file", failures[0])

    def test_allows_public_safe_root_agent_guide(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.DEVNULL)
            (root / "AGENTS.md").write_text(
                "# SDK contributor guidance\n\n"
                "Run the focused package checks before repository-wide checks.\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_allows_public_safe_nested_agent_guides(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.DEVNULL)
            nested_root = root / "js"
            nested_root.mkdir()
            for filename in ("AGENTS.md", "AGENTS.override.md"):
                (nested_root / filename).write_text(
                    "# Package contributor guidance\n",
                    encoding="utf-8",
                )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_scans_nested_agent_guides_normally(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.DEVNULL)
            nested_root = root / "js"
            nested_root.mkdir()
            sensitive_term = "pass" + "word"
            for filename in ("AGENTS.md", "AGENTS.override.md"):
                (nested_root / filename).write_text(
                    f"Use the production {sensitive_term} from a local file.\n",
                    encoding="utf-8",
                )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 2)
        self.assertTrue(all(sensitive_term in failure for failure in failures))

    def test_scans_root_agent_guide_content_normally(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.DEVNULL)
            sensitive_term = "pass" + "word"
            (root / "AGENTS.md").write_text(
                f"Use the production {sensitive_term} from a local file.\n",
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn(sensitive_term, failures[0])

    def test_reports_user_home_path_in_root_agent_guide(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.DEVNULL)
            home_path = "/Users/" + "example/work/sdk"
            (root / "AGENTS.md").write_text(
                f"Read additional guidance from {home_path}.\n",
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn(home_path, failures[0])

    def test_reports_public_research_memory_and_private_plan_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            research = root / "docs" / "competitor-research"
            private_plans = root / "docs" / "private-plans"
            research.mkdir(parents=True)
            private_plans.mkdir(parents=True)
            (research / "transport.md").write_text("Public source notes\n", encoding="utf-8")
            (private_plans / "task.md").write_text("Local task notes\n", encoding="utf-8")
            (root / "memory.md").write_text("SDK lane memory\n", encoding="utf-8")

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 3)
        self.assertTrue(any("docs/competitor-research" in failure for failure in failures))
        self.assertTrue(any("docs/private-plans" in failure for failure in failures))
        self.assertTrue(any("memory.md" in failure for failure in failures))

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
