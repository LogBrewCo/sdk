import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RealUserSmokeDiagnosticsTests(unittest.TestCase):
    def test_kotlin_smoke_dumps_bounded_diagnostics_on_failure(self):
        script = (ROOT / "scripts" / "real_user_kotlin_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("on_error()", script)
        self.assertIn("trap on_error ERR", script)
        self.assertIn("real_user_kotlin_smoke failed at line", script)
        self.assertIn("${BASH_COMMAND}", script)
        self.assertIn("sed -n '1,120p'", script)
        self.assertIn('"$tmp_dir/gradle-deps.txt"', script)
        self.assertIn('"$tmp_dir/okhttp-app.out"', script)
        self.assertIn('"$tmp_dir/intake.jsonl"', script)

    def test_kotlin_smoke_waits_for_fake_intake_readiness_without_masking_exit(self):
        script = (ROOT / "scripts" / "real_user_kotlin_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("wait_for_intake_ready()", script)
        self.assertIn("local attempts=300", script)
        self.assertIn('kill -0 "$intake_pid"', script)
        self.assertIn("Kotlin fake intake exited before readiness", script)
        self.assertIn("Kotlin fake intake did not become ready", script)
        self.assertNotIn("for _attempt in {1..50}", script)


if __name__ == "__main__":
    unittest.main()
