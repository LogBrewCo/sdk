from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check_public_sdks.sh"
LOCK_DIR = Path(os.environ.get("TMPDIR", "/tmp")) / "logbrewco-sdk-public-checks.lock"
LOCK_PID_FILE = LOCK_DIR / "pid"
EXPECTED_TOOLCHAIN_KEYS = {
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
    def tearDown(self) -> None:
        shutil.rmtree(LOCK_DIR, ignore_errors=True)

    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            check=False,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )

    def assert_toolchain_versions_shape(self, payload: dict[str, object]) -> None:
        self.assertIn("toolchain_versions", payload)
        toolchain_versions = payload["toolchain_versions"]
        self.assertIsInstance(toolchain_versions, dict)
        self.assertEqual(set(toolchain_versions), EXPECTED_TOOLCHAIN_KEYS)
        for key in EXPECTED_TOOLCHAIN_KEYS:
            self.assertIsInstance(toolchain_versions[key], str)
            self.assertTrue(toolchain_versions[key], f"expected non-empty toolchain version for {key}")

    def test_json_invalid_argument_is_structured(self) -> None:
        result = self.run_script("--json", "--bad-arg")

        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "1")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["steps_completed"], 0)
        self.assertEqual(payload["steps_total"], len(payload["step_labels"]))
        self.assertEqual(payload["completed_step_labels"], [])
        self.assertEqual(payload["failure_reason"], "invalid_argument")
        self.assertEqual(payload["exit_code"], 1)
        self.assertEqual(payload["message"], "unknown argument: --bad-arg")
        self.assert_toolchain_versions_shape(payload)
        self.assertIn("started_at", payload)
        self.assertIn("finished_at", payload)
        self.assertIn("duration_ms", payload)

    def test_json_reports_concurrent_run_cleanly(self) -> None:
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        LOCK_PID_FILE.write_text(str(os.getpid()))

        result = self.run_script("--json")

        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "1")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["steps_completed"], 0)
        self.assertEqual(payload["steps_total"], len(payload["step_labels"]))
        self.assertEqual(payload["completed_step_labels"], [])
        self.assertEqual(payload["failure_reason"], "concurrent_run")
        self.assertEqual(payload["exit_code"], 1)
        self.assertEqual(
            payload["message"],
            "another public SDK verifier run is already in progress",
        )
        self.assert_toolchain_versions_shape(payload)
        self.assertIn("started_at", payload)
        self.assertIn("finished_at", payload)
        self.assertIn("duration_ms", payload)

    def test_json_recovers_from_stale_lock(self) -> None:
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        LOCK_PID_FILE.write_text("999999")

        result = self.run_script("--json", "--bad-arg")

        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "1")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["failure_reason"], "invalid_argument")
        self.assertEqual(payload["exit_code"], 1)
        self.assertEqual(payload["message"], "unknown argument: --bad-arg")
        self.assert_toolchain_versions_shape(payload)

    def test_public_verifier_runs_backend_contract_gate(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Backend contract report checks"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Backend contract report checks"\n'
            r'run_shell_step "python3 scripts/check_backend_contract_reports\.py"\n'
            r"mark_step_complete",
        )

    def test_public_verifier_runs_release_artifact_smokes_before_hygiene(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"JavaScript release artifact smoke"', script)
        self.assertIn('"JavaScript release artifact installed CLI smoke"', script)
        self.assertIn('"Vite release artifact smoke"', script)
        self.assertIn('"Next.js release artifact smoke"', script)
        self.assertIn('"React Native release artifact smoke"', script)
        self.assertIn('"JavaScript release artifact upload smoke"', script)
        self.assertIn('"Native release artifact smoke"', script)
        self.assertIn('"Native release artifact upload smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "JavaScript release artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_release_artifact_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "JavaScript release artifact installed CLI smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_release_artifact_cli_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Vite release artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_vite_release_artifact_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Next\.js release artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_next_release_artifact_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "React Native release artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_react_native_release_artifact_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "JavaScript release artifact upload smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_release_artifact_upload_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Native release artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_native_release_artifact_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Native release artifact upload smoke"\n'
            r'run_shell_step "bash scripts/real_user_native_release_artifact_upload_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Generated artifact hygiene"',
        )

    def test_public_verifier_runs_browser_fake_intake_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Browser installed-artifact fake-intake smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Browser real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_browser_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Browser installed-artifact fake-intake smoke"\n'
            r'run_shell_step "bash scripts/real_user_browser_fake_intake_smoke\.sh"\n'
            r"mark_step_complete",
        )

    def test_public_verifier_runs_js_high_load_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"JavaScript high-load installed-artifact smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "JavaScript real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "JavaScript high-load installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "JavaScript OpenTelemetry installed-artifact smoke"',
        )

    def test_public_verifier_runs_node_queue_high_load_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Node queue high-load fake-intake smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Node\.js real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_node_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Node queue high-load fake-intake smoke"\n'
            r'run_shell_step "bash scripts/real_user_node_queue_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "BullMQ real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_bullmq_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "KafkaJS real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_kafkajs_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "AMQP/RabbitMQ real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_amqplib_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "AWS SQS real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_aws_sqs_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "npm public registry install smoke"\n'
            r'run_shell_step "bash scripts/real_user_npm_public_registry_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Express real-user smoke"',
        )

    def test_public_verifier_runs_npm_public_registry_install_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"npm public registry install smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "AWS SQS real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_aws_sqs_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "npm public registry install smoke"\n'
            r'run_shell_step "bash scripts/real_user_npm_public_registry_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Express real-user smoke"',
        )

    def test_public_verifier_runs_java_messaging_smokes(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Java JMS installed-artifact smoke"', script)
        self.assertIn('"Java high-load installed-artifact smoke"', script)
        self.assertIn('"Maven Central public install smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Java real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_java_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Java Spring Kafka installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_java_spring_kafka_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Java queue trace installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_java_queue_trace_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Java JMS installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_java_jms_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Java high-load installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_java_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Maven Central public install smoke"\n'
            r'run_shell_step "bash scripts/real_user_maven_central_public_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Spring Boot real-user smoke"',
        )

    def test_public_verifier_runs_dotnet_high_load_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('".NET high-load installed-artifact smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "\.NET real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_dotnet_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "\.NET high-load installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_dotnet_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "\.NET public NuGet install smoke"\n'
            r'run_shell_step "bash scripts/real_user_dotnet_public_nuget_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Unity real-user smoke"',
        )

    def test_public_verifier_runs_dotnet_public_nuget_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('".NET public NuGet install smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "\.NET real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_dotnet_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "\.NET high-load installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_dotnet_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "\.NET public NuGet install smoke"\n'
            r'run_shell_step "bash scripts/real_user_dotnet_public_nuget_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Unity real-user smoke"',
        )

    def test_public_verifier_runs_rubygems_public_install_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"RubyGems public install smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Ruby real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_ruby_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "RubyGems public install smoke"\n'
            r'run_shell_step "bash scripts/real_user_rubygems_public_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Swift real-user smoke"',
        )

    def test_public_verifier_runs_packagist_public_install_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Packagist public install smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "PHP real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_php_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Packagist public install smoke"\n'
            r'run_shell_step "bash scripts/real_user_packagist_public_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Python package build checks"',
        )

    def test_public_verifier_runs_python_celery_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Python Celery real-user smoke"', script)
        self.assertIn('"Python OpenTelemetry installed-artifact smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Python real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_python_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Python high-load installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_python_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Python OpenTelemetry installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_python_opentelemetry_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Python Celery real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_python_celery_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "FastAPI real-user smoke"',
        )

    def test_public_verifier_runs_python_public_pypi_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Python public PyPI install smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Python Celery real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_python_celery_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "FastAPI real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_fastapi_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Django real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_django_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Python public PyPI install smoke"\n'
            r'run_shell_step "bash scripts/real_user_python_public_pypi_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Go real-user smoke"',
        )

    def test_public_verifier_runs_javascript_opentelemetry_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"JavaScript OpenTelemetry installed-artifact smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "JavaScript real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "JavaScript high-load installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "JavaScript OpenTelemetry installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_js_opentelemetry_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Browser real-user smoke"',
        )

    def test_public_verifier_runs_go_high_load_smoke(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"Go high-load installed-artifact smoke"', script)
        self.assertRegex(
            script,
            r'begin_next_step "Go real-user smoke"\n'
            r'run_shell_step "bash scripts/real_user_go_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Go high-load installed-artifact smoke"\n'
            r'run_shell_step "bash scripts/real_user_go_high_load_smoke\.sh"\n'
            r"mark_step_complete\n\n"
            r'begin_next_step "Go support-ticket real-user smoke"',
        )

    def test_public_verifier_runs_github_release_safety_gate(self) -> None:
        script = SCRIPT.read_text()

        self.assertIn('"GitHub release safety checks"', script)
        self.assertRegex(
            script,
            r'begin_next_step "GitHub release safety checks"\n'
            r'run_shell_step "python3 scripts/check_github_release_safety\.py"\n'
            r"mark_step_complete",
        )

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
