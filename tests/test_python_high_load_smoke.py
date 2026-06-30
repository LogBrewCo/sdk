import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_python_high_load_smoke.sh"


class PythonHighLoadSmokeTests(unittest.TestCase):
    def test_high_load_smoke_owns_python_build_tooling(self) -> None:
        script = SMOKE.read_text(encoding="utf-8")

        self.assertIn('python3 -m venv "$tmp_dir/build-venv"', script)
        self.assertIn('"$tmp_dir/build-venv/bin/python" -m pip install', script)
        self.assertIn('"$tmp_dir/build-venv/bin/python" -m build', script)
        self.assertIn('"$repo_root/python/logbrew_py/build"', script)
        self.assertIn('"$repo_root/python/logbrew_py/src/logbrew_sdk.egg-info"', script)
        self.assertNotIn("python3 -m build", script)


if __name__ == "__main__":
    unittest.main()
