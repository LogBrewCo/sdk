from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GO_MODULE_PATH = "go/logbrew/go.mod"


class GoWorkflowCachePathTests(unittest.TestCase):
    def test_ci_setup_go_uses_nested_module_cache_path(self) -> None:
        workflow = ROOT / ".github" / "workflows" / "ci.yml"
        text = workflow.read_text(encoding="utf-8")

        self.assertIn(f"cache-dependency-path: {GO_MODULE_PATH}", text)


if __name__ == "__main__":
    unittest.main()
