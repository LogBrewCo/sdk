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


if __name__ == "__main__":
    unittest.main()
