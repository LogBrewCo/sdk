from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_generated_artifacts.py"
SPEC = importlib.util.spec_from_file_location("check_generated_artifacts", MODULE_PATH)
assert SPEC is not None
check_generated_artifacts = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_generated_artifacts)


class GeneratedArtifactTests(unittest.TestCase):
    def test_clean_tree_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(check_generated_artifacts.validate(Path(tmp)), [])

    def test_reports_exact_generated_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "php" / "logbrew-php" / "vendor").mkdir(parents=True)
            (root / "js" / "logbrew-js" / "examples" / "node_modules").mkdir(parents=True)
            (root / "js" / "logbrew-js" / "examples" / "pnpm-lock.yaml").write_text(
                "",
                encoding="utf-8",
            )
            (root / "Cargo.lock").write_text("", encoding="utf-8")

            failures = check_generated_artifacts.validate(root)

        self.assertIn("generated artifact remains: Cargo.lock", failures)
        self.assertIn("generated artifact remains: js/logbrew-js/examples/node_modules", failures)
        self.assertIn("generated artifact remains: js/logbrew-js/examples/pnpm-lock.yaml", failures)
        self.assertIn("generated artifact remains: php/logbrew-php/vendor", failures)

    def test_reports_globbed_generated_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "python" / "logbrew_py" / "tests" / "__pycache__").mkdir(parents=True)
            dotnet_bin = root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew" / "bin"
            dotnet_bin.mkdir(parents=True)

            failures = check_generated_artifacts.validate(root)

        self.assertIn("generated artifact remains: python/logbrew_py/tests/__pycache__", failures)
        self.assertIn("generated artifact remains: dotnet/logbrew-dotnet/src/LogBrew/bin", failures)


if __name__ == "__main__":
    unittest.main()
