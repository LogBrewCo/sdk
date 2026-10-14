from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class GoWorkflowCachePathTests(unittest.TestCase):
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
