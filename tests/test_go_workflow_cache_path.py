from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GO_MODULE_PATH = "go/logbrew/go.mod"
GO_OTEL_MODULE_PATH = "go/logbrew/otel/go.mod"
GO_OTEL_SUM_PATH = "go/logbrew/otel/go.sum"


class GoWorkflowCachePathTests(unittest.TestCase):
    def test_ci_setup_go_uses_nested_module_cache_path(self) -> None:
        workflow = ROOT / ".github" / "workflows" / "ci.yml"
        text = workflow.read_text(encoding="utf-8")

        self.assertIn("cache-dependency-path:", text)
        self.assertIn(GO_MODULE_PATH, text)
        self.assertIn(GO_OTEL_MODULE_PATH, text)
        self.assertIn(GO_OTEL_SUM_PATH, text)


if __name__ == "__main__":
    unittest.main()
