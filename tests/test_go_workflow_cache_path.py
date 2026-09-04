from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GO_MODULE_PATH = "go/logbrew/go.mod"
GO_ASYNQ_MODULE_PATH = "go/logbrew/asynq/go.mod"
GO_ASYNQ_SUM_PATH = "go/logbrew/asynq/go.sum"
GO_GIN_MODULE_PATH = "go/logbrew/gin/go.mod"
GO_GIN_SUM_PATH = "go/logbrew/gin/go.sum"
GO_OTEL_MODULE_PATH = "go/logbrew/otel/go.mod"
GO_OTEL_SUM_PATH = "go/logbrew/otel/go.sum"


class GoWorkflowCachePathTests(unittest.TestCase):
    def test_ci_setup_go_uses_nested_module_cache_path(self) -> None:
        workflow = ROOT / ".github" / "workflows" / "ci.yml"
        text = workflow.read_text(encoding="utf-8")

        self.assertIn("cache-dependency-path:", text)
        self.assertIn(GO_MODULE_PATH, text)
        self.assertIn(GO_ASYNQ_MODULE_PATH, text)
        self.assertIn(GO_ASYNQ_SUM_PATH, text)
        self.assertIn(GO_GIN_MODULE_PATH, text)
        self.assertIn(GO_GIN_SUM_PATH, text)
        self.assertIn(GO_OTEL_MODULE_PATH, text)
        self.assertIn(GO_OTEL_SUM_PATH, text)

    def test_local_proxy_builders_exclude_every_nested_module(self) -> None:
        for script in (ROOT / "scripts").glob("real_user_go*_smoke.sh"):
            text = script.read_text(encoding="utf-8")
            if "relative.parts[0]" in text:
                self.assertIn('"asynq"', text, script.name)
                self.assertIn('"gin"', text, script.name)
                self.assertIn('"otel"', text, script.name)

    def test_dependency_heavy_smokes_reuse_the_shared_download_proxy(self) -> None:
        for name in ("real_user_go_gin_smoke.sh", "real_user_go_opentelemetry_smoke.sh"):
            text = (ROOT / "scripts" / name).read_text(encoding="utf-8")
            self.assertIn('shared_go_build_cache="$(go env GOCACHE)"', text, name)
            self.assertIn('export GOCACHE="$shared_go_build_cache"', text, name)
            self.assertIn('file://$shared_go_proxy', text, name)


if __name__ == "__main__":
    unittest.main()
