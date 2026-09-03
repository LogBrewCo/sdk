from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check_public_sdks.sh"
EXPECTED_TOOLCHAIN_KEYS = {
    "bun",
    "node",
    "npm",
    "pnpm",
    "cc",
    "clang",
    "objc",
    "c++",
    "clang++",
    "make",
    "python3",
    "pip",
    "go",
    "java",
    "javac",
    "jar",
    "jdeps",
    "dotnet",
    "kotlinc",
    "gradle",
    "swift",
    "swiftformat",
    "swiftlint",
    "cargo",
    "rustc",
    "php",
    "composer",
    "ruby",
    "gem",
    "bundler",
}


class CheckPublicSdksJsonContractTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.temp_dir = Path(temporary.name)
        self.lock_dir = self.temp_dir / "logbrewco-sdk-public-checks.lock"
        self.lock_pid_file = self.lock_dir / "pid"
        self.script = SCRIPT

    def assert_step_sequence(self, *steps: tuple[str, str | None]) -> None:
        blocks = []
        for label, command in steps:
            block = f'begin_next_step "{label}"'
            if command is not None:
                block += f'\nrun_shell_step "{command}"\nmark_step_complete'
            blocks.append(block)
        self.assertIn("\n\n".join(blocks), SCRIPT.read_text())

    def run_script(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(self.script), *args],
            check=False,
            capture_output=True,
            text=True,
            cwd=ROOT,
            env={**os.environ, "TMPDIR": str(self.temp_dir), **(env or {})},
            timeout=20,
        )

    def assert_toolchain_versions_shape(self, payload: dict[str, object]) -> None:
        self.assertIn("toolchain_versions", payload)
        toolchain_versions = payload["toolchain_versions"]
        self.assertIsInstance(toolchain_versions, dict)
        self.assertEqual(set(toolchain_versions), EXPECTED_TOOLCHAIN_KEYS)
        for key in EXPECTED_TOOLCHAIN_KEYS:
            self.assertIsInstance(toolchain_versions[key], str)
            self.assertTrue(toolchain_versions[key], f"expected non-empty toolchain version for {key}")
        for key in ("node", "npm", "pnpm"):
            self.assertEqual(toolchain_versions[key], "unsupported: use bun")

    def assert_failure_summary(self, result: subprocess.CompletedProcess[str], reason: str, message: str) -> None:
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "1")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["steps_completed"], 0)
        self.assertEqual(payload["steps_total"], len(payload["step_labels"]))
        self.assertEqual(payload["completed_step_labels"], [])
        self.assertEqual(payload["failure_reason"], reason)
        self.assertEqual(payload["exit_code"], 1)
        self.assertEqual(payload["message"], message)
        self.assert_toolchain_versions_shape(payload)
        self.assertIn("started_at", payload)
        self.assertIn("finished_at", payload)
        self.assertGreaterEqual(payload["duration_ms"], 0)

    def test_json_invalid_argument_is_structured(self) -> None:
        self.assert_failure_summary(
            self.run_script("--json", "--bad-arg"),
            "invalid_argument",
            "unknown argument: --bad-arg",
        )

    def test_native_probe_failure_stops_without_recursive_reporting(self) -> None:
        fake_go = self.temp_dir / "go"
        fake_go.write_text(
            "#!/bin/sh\n"
            'if [ "$1" = version ]; then printf "go version go1.27.1 fixture\\n"; exit 0; fi\n'
            '[ "$GOTOOLCHAIN:$GOPROXY:$GOSUMDB" = "local:off:off" ] || printf "unexpected build policy\\n" >&2\n'
            "exit 7\n"
        )
        fake_go.chmod(0o700)
        result = self.run_script(
            "--json", "--bad-arg", env={
                "LOGBREW_TOOLCHAIN_PROBE_BIN": "",
                "PATH": f"{self.temp_dir}{os.pathsep}{os.environ['PATH']}",
            },
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "native toolchain clock unavailable\n")

    def test_missing_probe_inputs_do_not_invoke_go(self) -> None:
        fake_go = self.temp_dir / "go"
        fake_go.write_text('#!/bin/sh\nprintf "unexpected compiler invocation\\n" >&2\nexit 7\n')
        fake_go.chmod(0o700)
        for state in ("missing-directory", "missing-pin", "empty-pin"):
            with self.subTest(state=state):
                project = self.temp_dir / state
                self.script = project / "scripts" / SCRIPT.name
                self.script.parent.mkdir(parents=True)
                self.script.write_text(SCRIPT.read_text())
                probe = project / "tools" / "toolchain-probe"
                if state != "missing-directory":
                    probe.mkdir(parents=True)
                if state == "empty-pin":
                    (probe / ".go-version").touch()
                result = self.run_script(
                    "--json", "--bad-arg", env={
                        "LOGBREW_TOOLCHAIN_PROBE_BIN": "",
                        "PATH": f"{self.temp_dir}{os.pathsep}{os.environ['PATH']}",
                    },
                )
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("unexpected compiler invocation", result.stderr)
                self.assertEqual(result.stderr.count("native toolchain clock unavailable"), 1)

    def test_json_reports_concurrent_run_cleanly(self) -> None:
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        self.lock_pid_file.write_text(str(os.getpid()))

        self.assert_failure_summary(
            self.run_script("--json"),
            "concurrent_run",
            "another public SDK verifier run is already in progress",
        )

    def test_recovers_from_stale_lock(self) -> None:
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        self.lock_pid_file.write_text("999999")

        prefix = SCRIPT.read_text().split("if ! acquire_lock; then", 1)[0]
        prefix = prefix.replace('cd "$repo_root"', f'repo_root={shlex.quote(str(ROOT))}\ncd "$repo_root"', 1)
        script = self.temp_dir / "acquire-lock.sh"
        script.write_text(prefix + '\nacquire_lock\nprintf "%s\\n" "$(< "$lock_pid_file")"\n')
        result = subprocess.run(
            ["bash", str(script)],
            capture_output=True,
            text=True,
            check=False,
            env={**os.environ, "TMPDIR": str(self.temp_dir)},
            timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip().isdecimal())
        self.assertNotEqual(result.stdout.strip(), "999999")
        self.assertEqual(result.stdout.strip(), self.lock_pid_file.read_text().strip())

    def test_public_verifier_runs_single_command_contract_gates(self) -> None:
        self.assert_step_sequence(
            ("Backend contract report checks", "python3 scripts/check_backend_contract_reports.py"),
        )
        self.assert_step_sequence(
            ("GitHub release safety checks", "python3 scripts/check_github_release_safety.py"),
        )

    def test_public_verifier_runs_release_artifact_smokes_before_hygiene(self) -> None:
        self.assert_step_sequence(
            ("JavaScript release artifact smoke", "bash scripts/real_user_js_release_artifact_smoke.sh"),
            (
                "JavaScript release artifact installed CLI smoke",
                "bash scripts/real_user_js_release_artifact_cli_smoke.sh",
            ),
            ("Vite release artifact smoke", "bash scripts/real_user_vite_release_artifact_smoke.sh"),
            ("Next.js release artifact smoke", "bash scripts/real_user_next_release_artifact_smoke.sh"),
            ("React Native release artifact smoke", "bash scripts/real_user_react_native_release_artifact_smoke.sh"),
            ("JavaScript release artifact upload smoke", "bash scripts/real_user_js_release_artifact_upload_smoke.sh"),
            ("Native release artifact smoke", "bash scripts/real_user_native_release_artifact_smoke.sh"),
            ("Native release artifact upload smoke", "bash scripts/real_user_native_release_artifact_upload_smoke.sh"),
            ("Generated artifact hygiene", None),
        )

    def test_public_verifier_runs_browser_fake_intake_smoke(self) -> None:
        self.assert_step_sequence(
            ("Browser real-user smoke", "bash scripts/real_user_browser_smoke.sh"),
            ("Browser installed-artifact fake-intake smoke", "bash scripts/real_user_browser_fake_intake_smoke.sh"),
        )

    def test_public_verifier_runs_node_queue_high_load_smoke(self) -> None:
        self.assert_step_sequence(
            ("Node.js real-user smoke", "bash scripts/real_user_node_smoke.sh"),
            ("Node Redis real-package smoke", "bash scripts/real_user_node_redis_packages_smoke.sh"),
            ("Node Mongoose real-package smoke", "bash scripts/real_user_node_mongoose_smoke.sh"),
            ("Node Axios real-package smoke", "bash scripts/real_user_node_axios_smoke.sh"),
            ("Node HTTP client real-package smoke", "bash scripts/real_user_node_http_client_smoke.sh"),
            ("Node queue high-load fake-intake smoke", "bash scripts/real_user_node_queue_high_load_smoke.sh"),
            ("Node persistent delivery restart smoke", "bash scripts/real_user_node_persistent_delivery_smoke.sh"),
            (
                "Node encrypted persistent delivery smoke",
                "bash scripts/real_user_node_encrypted_persistent_delivery_smoke.sh",
            ),
            ("Prisma real-user smoke", "bash scripts/real_user_prisma_smoke.sh"),
            ("BullMQ real-user smoke", "bash scripts/real_user_bullmq_smoke.sh"),
            ("KafkaJS real-user smoke", "bash scripts/real_user_kafkajs_smoke.sh"),
            ("AMQP/RabbitMQ real-user smoke", "bash scripts/real_user_amqplib_smoke.sh"),
            ("AWS SQS real-user smoke", "bash scripts/real_user_aws_sqs_smoke.sh"),
            ("npm public registry install smoke", "bash scripts/real_user_npm_public_registry_smoke.sh"),
            ("Express real-user smoke", None),
        )

    def test_public_verifier_runs_java_messaging_smokes(self) -> None:
        self.assert_step_sequence(
            ("Java real-user smoke", "bash scripts/real_user_java_smoke.sh"),
            ("Java OpenTelemetry installed-artifact smoke", "bash scripts/real_user_java_opentelemetry_smoke.sh"),
            ("Java Spring Kafka installed-artifact smoke", "bash scripts/real_user_java_spring_kafka_smoke.sh"),
            ("Java Spring HTTP installed-artifact smoke", "bash scripts/real_user_java_spring_http_smoke.sh"),
            ("Java queue trace installed-artifact smoke", "bash scripts/real_user_java_queue_trace_smoke.sh"),
            ("Java JMS installed-artifact smoke", "bash scripts/real_user_java_jms_smoke.sh"),
            ("Java high-load installed-artifact smoke", "bash scripts/real_user_java_high_load_smoke.sh"),
            ("Maven Central public install smoke", "bash scripts/real_user_maven_central_public_smoke.sh"),
            ("Spring Boot real-user smoke", None),
        )

    def test_public_verifier_runs_cratesio_public_install_smoke(self) -> None:
        self.assert_step_sequence(
            ("Rust Actix real-user smoke", "bash scripts/real_user_rust_actix_smoke.sh"),
            ("Rust Rocket real-user smoke", "bash scripts/real_user_rust_rocket_smoke.sh"),
            ("Rust tracing real-user smoke", "bash scripts/real_user_rust_tracing_smoke.sh"),
            ("crates.io public install smoke", "bash scripts/real_user_cratesio_public_smoke.sh"),
            ("JavaScript real-user smoke", None),
        )

    def test_public_verifier_runs_dotnet_high_load_and_public_nuget_smokes(self) -> None:
        self.assert_step_sequence(
            (".NET real-user smoke", "bash scripts/real_user_dotnet_smoke.sh"),
            (".NET high-load installed-artifact smoke", "bash scripts/real_user_dotnet_high_load_smoke.sh"),
            (".NET public NuGet install smoke", "bash scripts/real_user_dotnet_public_nuget_smoke.sh"),
            ("Unity real-user smoke", None),
        )

    def test_public_verifier_runs_openupm_public_install_smoke(self) -> None:
        self.assert_step_sequence(
            ("Unity real-user smoke", "bash scripts/real_user_unity_smoke.sh"),
            ("OpenUPM public install smoke", "bash scripts/real_user_openupm_public_smoke.sh"),
            ("Kotlin real-user smoke", None),
        )

    def test_public_verifier_runs_rubygems_public_install_smoke(self) -> None:
        self.assert_step_sequence(
            ("Ruby real-user smoke", "bash scripts/real_user_ruby_smoke.sh"),
            ("RubyGems public install smoke", "bash scripts/real_user_rubygems_public_smoke.sh"),
            ("Swift real-user smoke", None),
        )

    def test_public_verifier_runs_symfony_before_packagist_public_install_smoke(self) -> None:
        self.assert_step_sequence(
            ("PHP real-user smoke", "bash scripts/real_user_php_smoke.sh"),
            ("PHP Symfony installed-app smoke", "bash scripts/real_user_php_symfony_smoke.sh"),
            ("Packagist public install smoke", "bash scripts/real_user_packagist_public_smoke.sh"),
            ("Python package build checks", None),
        )

    def test_public_verifier_runs_python_celery_smoke(self) -> None:
        self.assert_step_sequence(
            ("Python real-user smoke", "bash scripts/real_user_python_smoke.sh"),
            ("Python high-load installed-artifact smoke", "bash scripts/real_user_python_high_load_smoke.sh"),
            ("Python OpenTelemetry installed-artifact smoke", "bash scripts/real_user_python_opentelemetry_smoke.sh"),
            ("Python Celery real-user smoke", "bash scripts/real_user_python_celery_smoke.sh"),
            ("FastAPI real-user smoke", None),
        )

    def test_public_verifier_runs_python_public_pypi_smoke(self) -> None:
        self.assert_step_sequence(
            ("Python Celery real-user smoke", "bash scripts/real_user_python_celery_smoke.sh"),
            ("FastAPI real-user smoke", "bash scripts/real_user_fastapi_smoke.sh"),
            ("Django real-user smoke", "bash scripts/real_user_django_smoke.sh"),
            ("Python public PyPI install smoke", "bash scripts/real_user_python_public_pypi_smoke.sh"),
            ("Go real-user smoke", None),
        )

    def test_public_verifier_runs_javascript_opentelemetry_smoke(self) -> None:
        self.assert_step_sequence(
            ("JavaScript real-user smoke", "bash scripts/real_user_js_smoke.sh"),
            ("JavaScript high-load installed-artifact smoke", "bash scripts/real_user_js_high_load_smoke.sh"),
            ("JavaScript OpenTelemetry installed-artifact smoke", "bash scripts/real_user_js_opentelemetry_smoke.sh"),
            ("Browser real-user smoke", None),
        )

    def test_public_verifier_runs_go_public_module_smoke(self) -> None:
        self.assert_step_sequence(
            ("Go real-user smoke", "bash scripts/real_user_go_smoke.sh"),
            ("Go OpenTelemetry installed-artifact smoke", "bash scripts/real_user_go_opentelemetry_smoke.sh"),
            ("Go Gin installed-artifact smoke", "bash scripts/real_user_go_gin_smoke.sh"),
            ("Go high-load installed-artifact smoke", "bash scripts/real_user_go_high_load_smoke.sh"),
            ("Go delivery lifecycle installed-artifact smoke", "bash scripts/real_user_go_delivery_lifecycle_smoke.sh"),
            ("Go support-ticket real-user smoke", "bash scripts/real_user_go_support_ticket_smoke.sh"),
            ("Go public module install smoke", "bash scripts/real_user_go_public_module_smoke.sh"),
            ("C real-user smoke", None),
        )

    def test_public_verifier_runs_swiftpm_public_install_smoke(self) -> None:
        self.assert_step_sequence(
            ("RubyGems public install smoke", "bash scripts/real_user_rubygems_public_smoke.sh"),
            ("Swift real-user smoke", "bash scripts/real_user_swift_smoke.sh"),
            ("SwiftPM public install smoke", "bash scripts/real_user_swiftpm_public_smoke.sh"),
            ("PHP package metadata", None),
        )

    def test_public_verifier_removes_disposable_package_outputs(self) -> None:
        script = SCRIPT.read_text()
        function_name = "clean" + "up_build_artifacts"

        self.assertRegex(
            script,
            rf"{function_name}\(\) \{{\n"
            r"(?:.*\n)*?"
            r"\s+Cargo\.lock \\\n"
            r"\s+target(?: \\\n|\n)",
        )
        self.assertIn("find js -maxdepth 2 -type f -path 'js/logbrew-*/*.tgz' -delete", script)

    def test_public_verifier_validates_step_label_order_at_runtime(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('expected_label="${STEP_LABELS[$((current_step_number - 1))]:-}"', script)
        self.assertIn('if [[ "$expected_label" != "$current_step_label" ]]; then', script)
        self.assertIn("step label mismatch for step $current_step_number", script)

    def test_declared_step_labels_match_executable_steps(self) -> None:
        script = SCRIPT.read_text()
        labels_block = re.search(r"STEP_LABELS=\(\n(?P<labels>.*?)\n\)", script, re.DOTALL)
        self.assertIsNotNone(labels_block)
        assert labels_block is not None

        declared_labels = re.findall(r'^\s+"([^"]+)"$', labels_block.group("labels"), re.MULTILINE)
        executable_labels = re.findall(r'^begin_next_step "([^"]+)"$', script, re.MULTILINE)

        self.assertEqual(declared_labels, executable_labels)


if __name__ == "__main__":
    unittest.main()
