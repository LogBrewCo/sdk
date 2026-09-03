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
    def scan_fixture(self, files: dict[str, str], *, git_repository: bool = False) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            if git_repository:
                subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.DEVNULL, timeout=5)
            for relative, content in files.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            return check_confidentiality_scan.validate(root)

    def assert_fixture_policy(
        self,
        allowed: dict[str, str],
        rejected: dict[str, str] | None = None,
    ) -> list[str]:
        self.assertEqual(self.scan_fixture(allowed), [])
        return self.scan_fixture(allowed | rejected) if rejected is not None else []

    def test_queue_control_word_allowlist_is_path_scoped(self) -> None:
        put_back_term = "rest" + "ore"
        teardown_term = "clean" + "up"
        cases = {
            **{
                f"python/logbrew_py/src/logbrew_sdk/_{name}_client.py": f"_{put_back_term}(worker, method, previous)"
                for name in ("arq", "queue", "rq")
            },
            **{
                f"python/logbrew_py/tests/test_{name}_client.py": f"self.add{teardown_term.title()}(connection.flushdb)"
                for name in ("arq", "rq")
            },
            "docs/github-actions.md": f"group during {teardown_term}, including children left behind after command exit.",
            "tests/test_check_public_sdks.py": f"self.add{teardown_term.title()}(temporary.{teardown_term})",
            "tools/toolchain-probe/main.go": f'return "{teardown_term} failed"',
        }
        for path, line in cases.items():
            with self.subTest(path=path):
                self.assertTrue(check_confidentiality_scan.is_allowed_match(Path(path), line))
                self.assertFalse(
                    check_confidentiality_scan.is_allowed_match(
                        Path("python/logbrew_py/src/logbrew_sdk/unrelated.py"),
                        line,
                    )
                )
                self.assertFalse(
                    check_confidentiality_scan.is_allowed_match(
                        Path(path),
                        line + " arbitrary sec" + "ret text",
                    )
                )

    def test_rust_telemetry_context_allowlist_is_path_and_symbol_scoped(self) -> None:
        context_path = "rust/logbrew/src/telemetry_context.rs"
        sensitive_name = "to" + "ken"
        self.assertTrue(
            check_confidentiality_scan.is_rust_telemetry_context_reference(
                context_path,
                f"    {sensitive_name}: u64,",
                {sensitive_name},
            )
        )
        self.assertFalse(
            check_confidentiality_scan.is_rust_telemetry_context_reference(
                context_path,
                f'let auth_{sensitive_name} = "unsafe";',
                {sensitive_name},
            )
        )
        self.assertFalse(
            check_confidentiality_scan.is_rust_telemetry_context_reference(
                "rust/logbrew/src/unrelated.rs",
                f"    {sensitive_name}: u64,",
                {sensitive_name},
            )
        )

    def test_python_method_restoration_allowlist_is_exact(self) -> None:
        for path, selector in (
            ("python/logbrew_py/src/logbrew_sdk/_http_instrumentation.py", "rest" + "ore"),
            ("python/logbrew_py/src/logbrew_sdk/_instrumentation.py", "rest" + "ore"),
            ("python/logbrew_py/README.md", "For Requests, HTTPX, and aiohttp,"),
        ):
            lines = [line for line in (ROOT / path).read_text().splitlines() if selector.lower() in line.lower()]
            self.assertTrue(lines)
            for line in lines:
                with self.subTest(path=path, line=line):
                    self.assertTrue(check_confidentiality_scan.is_allowed_match(Path(path), line))
                    for candidate_path, candidate in (
                        ("python/logbrew_py/src/logbrew_sdk/unrelated.py", line),
                        (path, line + " Extra text."),
                        (path, line + " sec" + "ret text"),
                    ):
                        self.assertFalse(check_confidentiality_scan.is_allowed_match(Path(candidate_path), candidate))

    def test_allows_only_exact_rails_key_base_fixture(self) -> None:
        script = "scripts/real_user_ruby_rails_smoke.sh"
        sensitive_name = "sec" + "ret"
        allowed = f'      config.{sensitive_name}_key_base = "installed-rails-smoke-{sensitive_name}-key-base"\n'
        failures = self.assert_fixture_policy(
            {script: allowed},
            {script: allowed + f"# arbitrary {sensitive_name} text remains forbidden\n"},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("arbitrary", failures[0])

    def test_allows_only_exact_native_archive_exclusion_symbols(self) -> None:
        archive_term = "back" + "up"
        fixtures = (
            (
                "js/logbrew-react-native/android/src/main/java/co/logbrew/reactnative/FatalStoreModuleImpl.java",
                f"File root = context.getNo{archive_term.title()}FilesDir();\n",
                True,
            ),
            (
                "js/logbrew-react-native/ios/LBRNFatalStoreModule.mm",
                f"[url setResourceValue:@YES forKey:NSURLIsExcludedFrom{archive_term.title()}Key error:nil];\n",
                False,
            ),
            (
                "swift/logbrew-swift/Sources/LogBrewCrash/CrashStorageDirectory.swift",
                f"values.isExcludedFrom{archive_term.title()} = true\n",
                True,
            ),
            (
                "swift/logbrew-swift/Tests/LogBrewCrashTests/NativeHangIncidentStoreTests.swift",
                f"#expect(values.isExcludedFrom{archive_term.title()} == true)\n",
                True,
            ),
            (
                "js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrewCrash/CrashStorageDirectory.swift",
                f"values.isExcludedFrom{archive_term.title()} = true\n",
                False,
            ),
        )
        rejected = {
            relative: content + f"// arbitrary {archive_term} language remains forbidden\n"
            for relative, content, reject_suffix in fixtures
            if reject_suffix
        }
        rejected["Other.java"] = f"context.getNo{archive_term.title()}FilesDir();\n"
        failures = self.assert_fixture_policy(
            {relative: content for relative, content, _ in fixtures},
            rejected,
        )
        self.assertEqual(len(failures), 4)
        self.assertTrue(any("arbitrary" in failure for failure in failures))
        expected_paths = {f"./{path}" for path, _, reject_suffix in fixtures if reject_suffix}
        self.assertEqual(
            {failure.split(":", 1)[0] for failure in failures},
            expected_paths | {"./Other.java"},
        )

    def test_repo_confidentiality_scan_passes(self) -> None:
        self.assertEqual(check_confidentiality_scan.validate(ROOT), [])

    def test_allows_intentional_sdk_fixture_terms(self) -> None:
        angular_keyword = "Injection" + "To" + "ken"
        fake_query = "?to" + "ken=sec" + "ret"
        cleaner_name = "clean" + "up"
        cancellation_source = "Cancellation" + "To" + "kenSource"
        cancellation_member = ".To" + "ken"
        self.assert_fixture_policy(
            {
                "js/logbrew-angular/index.js": f'export const LOG_BREW_ANGULAR_CONTEXT = new {angular_keyword}("LogBrew Angular context");\n',
                "scripts/real_user_node_smoke.sh": f"fetch(`http://127.0.0.1:3000/fail{fake_query}`)\n"
                f"{cleaner_name}() {{\n"
                "}\n",
                "scripts/real_user_dotnet_smoke.sh": f"private readonly Cancellation{cancellation_member}Source cancellation = new {cancellation_source}();\n",
                "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.cs": "#pragma warning " + "rest" + "ore CA1031\n"
                "return SendAsync(request, cancellation" + "To" + "ken);\n",
                "unity/logbrew-unity/Runtime/PublicTypes.cs": f"using var cancellation = new {cancellation_source}();\n"
                f"await client.SendAsync(request, cancellation{cancellation_member}).ConfigureAwait(false);\n",
                "python/logbrew_py/src/logbrew_sdk/_db_client.py": "_DB_SPAN_EVENT_METADATA_DENYLIST = (\n"
                f'    "sec{"ret"}",\n'
                f'    "to{"ken"}",\n'
                ")\n",
            }
        )

    def test_pino_privacy_allowlist_is_exact(self) -> None:
        sensitive_name = "to" + "ken"
        allowed_line = f'requestUrl: "/checkout/42?{sensitive_name}=hidden",'
        fastify_readme = ROOT / "js" / "logbrew-fastify" / "README.md"
        fastify_line = next(
            line
            for line in fastify_readme.read_text(encoding="utf-8").splitlines()
            if line.startswith("Primitive structured fields become bounded LogBrew metadata.")
        )
        cases = (
            ("js/logbrew-js/test/sdk.test.js", allowed_line, True),
            (
                "js/logbrew-js/test/sdk.test.js",
                f'console.log("arbitrary {sensitive_name}")',
                False,
            ),
            ("js/logbrew-fastify/README.md", fastify_line, True),
            ("js/logbrew-fastify/README.md", fastify_line + " Extra text.", False),
        )
        for path, line, expected in cases:
            with self.subTest(path=path, line=line):
                self.assertEqual(
                    check_confidentiality_scan.is_js_pino_privacy_reference(path, line),
                    expected,
                )

    def test_go_gin_privacy_allowlist_is_path_and_line_scoped(self) -> None:
        sensitive_name = "to" + "ken"
        allowed_line = (
            f'request := httptest.NewRequest(http.MethodGet, "/profiles/private-user?{sensitive_name}=private", nil)'
        )
        path = "go/logbrew/gin/middleware_test.go"

        self.assertTrue(check_confidentiality_scan.is_go_gin_privacy_reference(path, allowed_line))
        self.assertFalse(
            check_confidentiality_scan.is_go_gin_privacy_reference("go/logbrew/gin/unrelated.go", allowed_line)
        )
        self.assertFalse(check_confidentiality_scan.is_go_gin_privacy_reference(path, allowed_line + " // extra"))

    def test_allows_only_exact_dotnet_release_compatibility_terms(self) -> None:
        dependency_action = "rest" + "ore"
        identity_member = "PublicKey" + "To" + "ken"
        identity_value = "to" + "ken"
        failures = self.assert_fixture_policy(
            {
                ".github/workflows/publish-nuget.yml": f"dotnet {dependency_action} dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj\n"
                f"dotnet pack dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj --no-{dependency_action}\n",
                "scripts/real_user_dotnet_httpclient_package_compatibility_smoke.sh": f"Get{identity_member}()\n"
                f'return {identity_value} == null || {identity_value}.Length == 0 ? "unsigned" '
                f": Convert.ToHexString({identity_value}).ToLowerInvariant();\n",
                "tests/test_dotnet_httpclient_package_compatibility_smoke.py": f'"Get{identity_member}"\n',
            },
            {"dotnet/Other.cs": f"Get{identity_member}()\n"},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("Other.cs", failures[0])

    def test_allows_only_exact_reusable_workflow_inheritance(self) -> None:
        inheritance_key = "se" + "crets"
        failures = self.assert_fixture_policy(
            {".github/workflows/publish-packages.yml": f"{inheritance_key}: inherit\n"},
            {".github/workflows/other.yml": f"{inheritance_key}: inherit\n"},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("other.yml", failures[0])

    def test_allows_only_standard_github_workflow_authorization_placeholders(
        self,
    ) -> None:
        sensitive_name = "to" + "ken"
        workflow = ".github/workflows/reconcile.yml"
        failures = self.assert_fixture_policy(
            {
                workflow: f"GITHUB_AUTHORIZATION: ${{{{ github.{sensitive_name} }}}}\n"
                f"github-{sensitive_name}: ${{{{ github.{sensitive_name} }}}}\n"
            },
            {workflow: f"github-{sensitive_name}: untrusted-value\n"},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("reconcile.yml", failures[0])

    def test_allows_only_exact_python_registry_host_property_checks(self) -> None:
        host_member = "host" + "name"
        failures = self.assert_fixture_policy(
            {
                "scripts/real_user_python_public_pypi_smoke.sh": f'if parsed.scheme != "https" or parsed.{host_member} != "files.pythonhosted.org":\n'
                f'if final_url.scheme != "https" or final_url.{host_member} != "files.pythonhosted.org":\n'
            },
            {"scripts/other.py": f"print(request.{host_member})\n"},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("other.py", failures[0])

    def test_allows_generated_brand_svg_image_carriers(self) -> None:
        sensitive_line = "embedded generated image carrier to" + "ken-shaped base64 text\n"
        self.assert_fixture_policy({"assets/brand/logbrew-logo-espresso-bg-512.svg": sensitive_line})

    def test_allows_only_exact_java_aes_key_spec_references(self) -> None:
        crypto = "java/logbrew-java/src/main/java/co/logbrew/sdk/PersistenceCrypto.java"
        key_spec = "Sec" + "retKeySpec"
        unsafe_name = "raw" + "Sec" + "ret"
        failures = self.assert_fixture_policy(
            {crypto: f'import javax.crypto.spec.{key_spec};\nnew {key_spec}(key, "AES"),\n'},
            {crypto: f'import javax.crypto.spec.{key_spec};\nnew {key_spec}({unsafe_name}, "AES"),\n'},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn(unsafe_name, failures[0])

    def test_allows_sdk_instrumentation_uninstall_terms(self) -> None:
        undo_member = "rest" + "ores"
        undo_label = "rest" + "ores"
        self.assert_fixture_policy(
            {
                "js/logbrew-kafkajs/index.js": f'state.{undo_member}.push(installMethod(producer, "send", () => {{}}));\n'
                f"state.{undo_member}.pop()();\n",
                "scripts/real_user_kafkajs_smoke.sh": f'assertEqual(client.pendingEvents(), pendingAfterUninstall, "uninstall {undo_label} original send");\n',
            }
        )

    def test_allows_only_the_kscrash_report_deletion_policy_symbol(self) -> None:
        source_dir = "swift/logbrew-swift/Sources/LogBrewCrash"
        generated_dir = "js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrewCrash"
        policy = "reportClean" + "upPolicy"
        failures = self.assert_fixture_policy(
            {
                f"{directory}/CrashEngine.swift": f"configuration.{policy} = .never\n"
                for directory in (source_dir, generated_dir)
            },
            {f"{source_dir}/Other.swift": f"unexpected {policy}\n"},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("Other.swift", failures[0])

    def test_allows_apple_durable_storage_terms_only_in_owned_files(self) -> None:
        durable_dir = "swift/logbrew-swift/Sources/LogBrew"
        generated_dir = "js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrew"
        archive_label = "back" + "up"
        cleaner_name = "clean" + "up"
        failures = self.assert_fixture_policy(
            {
                f"{directory}/DurableDeliveryStoreRecovery.swift": f"exclude durable files from {archive_label} and {cleaner_name} invalid records\n"
                for directory in (durable_dir, generated_dir)
            },
            {f"{durable_dir}/DeliveryEngine.swift": f"unexpected {archive_label} {cleaner_name} guidance\n"},
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("DeliveryEngine.swift", failures[0])

    def test_allows_maven_central_preflight_secret_names_only(self) -> None:
        self.assert_fixture_policy(
            {
                ".github/workflows/publish-packages.yml": "CENTRAL_PORTAL_USERNAME: ${{ secrets.CENTRAL_PORTAL_USERNAME }}\n"
                "CENTRAL_PORTAL_PASSWORD: ${{ secrets.CENTRAL_PORTAL_PASSWORD }}\n",
                "scripts/check_maven_central_auth_preflight.sh": "${CENTRAL_PORTAL_PASSWORD:-}\n"
                "os.environ['CENTRAL_PORTAL_USERNAME']\n"
                "os.environ['CENTRAL_PORTAL_PASSWORD']\n"
                "generated Central Portal publishing values\n",
                "tests/test_maven_central_auth_preflight.py": '"CENTRAL_PORTAL_PASSWORD": password\n"fixture-user-token"\n"fixture-secret-token"\n',
            }
        )

    def test_allows_release_artifact_build_auth_boundaries(self) -> None:
        auth_option = "to" + "kenEnv"
        self.assert_fixture_policy(
            {
                "js/logbrew-js/release-artifacts-build.cjs": f"const {auth_option} = upload.{auth_option};\n",
                "js/logbrew-next/release-artifacts.d.ts": f"{auth_option}?: string;\n",
            }
        )

    def test_allows_exact_react_native_diagnostics_endpoint_guards(self) -> None:
        field = "pass" + "word"
        self.assert_fixture_policy(
            {
                "js/logbrew-react-native/apple-native-diagnostics.js": f"if (parsed.{field}) reject();\n",
                "js/logbrew-react-native/ios/AppleDiagnostics/LBRNAppleNativeDiagnostics.swift": f"components.{field} == nil,\n",
            }
        )

    def test_reports_unexpected_sensitive_terms(self) -> None:
        sensitive_line = "production " + "pass" + "word: hunter2\n"
        failures = self.scan_fixture({"README.md": sensitive_line})
        self.assertEqual(len(failures), 1)
        self.assertIn("production " + "pass" + "word", failures[0])

    def test_sensitive_match_does_not_cross_identifier_boundaries(self) -> None:
        remote_term = "s" + "sh_private_key"
        failures = self.scan_fixture(
            {
                "java/logbrew-java/src/main/java/AutomaticDeliveryController.java": "ProcessHandle owner = ProcessHandle.current();\nreturn ProcessHandle.current().equals(owner);\n",
                "unsafe.txt": f"{remote_term}=fixture\n",
            }
        )
        self.assertEqual(len(failures), 1)
        self.assertIn(remote_term, failures[0])

    def test_reports_forbidden_public_planning_files(self) -> None:
        failures = self.scan_fixture({"skills-lock.json": '{"version": 1}\n'})
        self.assertEqual(len(failures), 1)
        self.assertIn("skills-lock.json", failures[0])
        self.assertIn("forbidden public planning file", failures[0])

    def test_allows_public_safe_root_agent_guide(self) -> None:
        failures = self.scan_fixture(
            {
                "AGENTS.md": "# SDK contributor guidance\n\nRun the focused package checks before repository-wide checks.\n",
            },
            git_repository=True,
        )
        self.assertEqual(failures, [])

    def test_allows_public_safe_nested_agent_guides(self) -> None:
        failures = self.scan_fixture(
            {f"js/{filename}": "# Package contributor guidance\n" for filename in ("AGENTS.md", "AGENTS.override.md")},
            git_repository=True,
        )
        self.assertEqual(failures, [])

    def test_scans_nested_agent_guides_normally(self) -> None:
        sensitive_term = "pass" + "word"
        failures = self.scan_fixture(
            {
                f"js/{filename}": f"Use the production {sensitive_term} from a local file.\n"
                for filename in ("AGENTS.md", "AGENTS.override.md")
            },
            git_repository=True,
        )
        self.assertEqual(len(failures), 2)
        self.assertTrue(all(sensitive_term in failure for failure in failures))

    def test_scans_root_agent_guide_content_normally(self) -> None:
        sensitive_term = "pass" + "word"
        failures = self.scan_fixture(
            {
                "AGENTS.md": f"Use the production {sensitive_term} from a local file.\n",
            },
            git_repository=True,
        )
        self.assertEqual(len(failures), 1)
        self.assertIn(sensitive_term, failures[0])

    def test_reports_user_home_paths_only_in_canonical_agent_guides(self) -> None:
        cases = (
            ("AGENTS.md", "/Users/example/work/sdk", True),
            ("js/AGENTS.md", "/home/example/work/sdk", True),
            ("js/AGENTS.override.md", r"C:\Users\example\work\sdk", True),
            ("js/CONTRIBUTING.md", "/Users/example/work/sdk", False),
        )
        for relative_path, home_path, should_report in cases:
            with self.subTest(relative_path=relative_path):
                failures = self.scan_fixture(
                    {
                        relative_path: f"Read additional guidance from {home_path}.\n",
                    },
                    git_repository=True,
                )
                if should_report:
                    self.assertEqual(len(failures), 1)
                    self.assertIn(home_path, failures[0])
                else:
                    self.assertEqual(failures, [])

    def test_reports_public_research_memory_and_private_plan_paths(self) -> None:
        failures = self.scan_fixture(
            {
                "docs/competitor-research/transport.md": "Public source notes\n",
                "docs/private-plans/task.md": "Local task notes\n",
                "memory.md": "SDK lane memory\n",
            }
        )
        self.assertEqual(len(failures), 3)
        self.assertTrue(any("docs/competitor-research" in failure for failure in failures))
        self.assertTrue(any("docs/private-plans" in failure for failure in failures))
        self.assertTrue(any("memory.md" in failure for failure in failures))

    def test_allows_local_ignored_agent_redirect_and_plans(self) -> None:
        sensitive_term = "cre" + "dential"
        planning_term = "stra" + "tegy"
        failures = self.scan_fixture(
            {
                ".gitignore": "AGENTS.md\nplans/\n",
                "AGENTS.md": f"Read private guidance. Do not copy {sensitive_term} or backend/storage details.\n",
                "plans/private-plan.md": f"Local private plan with {planning_term} notes.\n",
            },
            git_repository=True,
        )
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
