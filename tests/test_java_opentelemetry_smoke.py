from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_java_opentelemetry_smoke.sh"
RELEASE_READINESS = REPO_ROOT / ".github" / "workflows" / "release-readiness.yml"


class JavaOpenTelemetrySmokeTests(unittest.TestCase):
    def test_java_opentelemetry_smoke_exercises_installed_artifact_flow(self) -> None:
        script = SMOKE.read_text()

        self.assertIn("logbrew-sdk-0.1.0.jar", script)
        self.assertIn("javac -Xlint:all -Werror", script)
        self.assertIn("SdkTracerProvider.builder()", script)
        self.assertIn("LogBrewOpenTelemetrySdk.spanProcessor(client)", script)
        self.assertIn("LogBrewOpenTelemetrySdk.spanExporter(client)", script)
        self.assertIn("java_opentelemetry_api_classpath", script)
        self.assertIn("OpenTelemetry API-only context copy failed", script)
        self.assertIn("exception.message", script)
        self.assertIn("exception.stacktrace", script)
        self.assertIn("db.statement", script)
        self.assertIn("traceparent", script)
        self.assertIn("payload omitted", script)

    def test_release_readiness_runs_java_opentelemetry_installed_artifact_smoke(self) -> None:
        workflow = RELEASE_READINESS.read_text()
        expected_order = (
            "Run Java real-user smoke test",
            "bash scripts/real_user_java_smoke.sh",
            "Run Java OpenTelemetry installed-artifact smoke test",
            "bash scripts/real_user_java_opentelemetry_smoke.sh",
            "Run Java Spring Kafka installed-artifact smoke test",
        )
        positions = {step: workflow.find(step) for step in expected_order}

        self.assertEqual(
            {step: position for step, position in positions.items() if position == -1},
            {},
            "release-readiness Java OTel smoke step is missing",
        )
        self.assertEqual(
            [positions[step] for step in expected_order],
            sorted(positions.values()),
            "Java OTel smoke should run after core Java smoke and before Java framework smokes",
        )


if __name__ == "__main__":
    unittest.main()
