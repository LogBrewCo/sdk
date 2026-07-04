import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_python_high_load_smoke.sh"
OTEL_SMOKE = REPO_ROOT / "scripts" / "real_user_python_opentelemetry_high_load_smoke.sh"


class PythonHighLoadSmokeTests(unittest.TestCase):
    def test_high_load_smoke_owns_python_build_tooling(self) -> None:
        script = SMOKE.read_text(encoding="utf-8")

        self.assertIn('python3 -m venv "$tmp_dir/build-venv"', script)
        self.assertIn('"$tmp_dir/build-venv/bin/python" -m pip install', script)
        self.assertIn('"$tmp_dir/build-venv/bin/python" -m build', script)
        self.assertIn('"$repo_root/python/logbrew_py/build"', script)
        self.assertIn('"$repo_root/python/logbrew_py/src/logbrew_sdk.egg-info"', script)
        self.assertNotIn("python3 -m build", script)

    def test_opentelemetry_high_load_smoke_exercises_installed_artifact_flow(self) -> None:
        script = OTEL_SMOKE.read_text(encoding="utf-8")

        self.assertIn('python3 -m venv "$tmp_dir/build-venv"', script)
        self.assertIn('"$tmp_dir/build-venv/bin/python" -m build', script)
        self.assertIn('python -m pip install "opentelemetry-sdk>=1,<2"', script)
        self.assertIn("BatchSpanProcessor", script)
        self.assertIn("create_logbrew_open_telemetry_span_exporter", script)
        self.assertIn("HIGH_VOLUME_OTEL_SPANS = 1500", script)
        self.assertIn("MAX_QUEUE_SIZE = 1000", script)
        self.assertIn("dropped_events()", script)
        self.assertIn("127.0.0.1", script)
        self.assertIn("retryAttempts", script)
        self.assertIn("shutdown", script)


if __name__ == "__main__":
    unittest.main()
