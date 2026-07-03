from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_java_opentelemetry_smoke.sh"


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


if __name__ == "__main__":
    unittest.main()
