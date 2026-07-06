from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NODE_REDIS_PACKAGE_SMOKE_COMMAND = "bash scripts/real_user_node_redis_packages_smoke.sh"
NODE_AXIOS_SMOKE_COMMAND = "bash scripts/real_user_node_axios_smoke.sh"
NODE_HTTP_CLIENT_SMOKE_COMMAND = "bash scripts/real_user_node_http_client_smoke.sh"
NODE_QUEUE_HIGH_LOAD_SMOKE_COMMAND = "bash scripts/real_user_node_queue_high_load_smoke.sh"
PRISMA_SMOKE_COMMAND = "bash scripts/real_user_prisma_smoke.sh"


class NodeQueueHighLoadWorkflowGateTests(unittest.TestCase):
    def test_workflows_run_node_queue_high_load_smoke_after_node_smoke(self) -> None:
        for workflow in (
            ROOT / ".github" / "workflows" / "ci.yml",
            ROOT / ".github" / "workflows" / "release-readiness.yml",
        ):
            text = workflow.read_text(encoding="utf-8")

            with self.subTest(workflow=workflow.name):
                self.assertIn("Run Node Redis real-package smoke test", text)
                self.assertIn(f"run: {NODE_REDIS_PACKAGE_SMOKE_COMMAND}", text)
                self.assertIn("Run Node Axios real-package smoke test", text)
                self.assertIn(f"run: {NODE_AXIOS_SMOKE_COMMAND}", text)
                self.assertIn("Run Node HTTP client real-package smoke test", text)
                self.assertIn(f"run: {NODE_HTTP_CLIENT_SMOKE_COMMAND}", text)
                self.assertIn("Run Node queue high-load fake-intake smoke test", text)
                self.assertIn(f"run: {NODE_QUEUE_HIGH_LOAD_SMOKE_COMMAND}", text)
                self.assertIn("Run Prisma real-user smoke test", text)
                self.assertIn(f"run: {PRISMA_SMOKE_COMMAND}", text)
                self.assertLess(
                    text.index("Run Node.js real-user smoke test"),
                    text.index("Run Node Redis real-package smoke test"),
                )
                self.assertLess(
                    text.index("Run Node Redis real-package smoke test"),
                    text.index("Run Node Axios real-package smoke test"),
                )
                self.assertLess(
                    text.index("Run Node Axios real-package smoke test"),
                    text.index("Run Node HTTP client real-package smoke test"),
                )
                self.assertLess(
                    text.index("Run Node HTTP client real-package smoke test"),
                    text.index("Run Node queue high-load fake-intake smoke test"),
                )
                self.assertLess(
                    text.index("Run Node queue high-load fake-intake smoke test"),
                    text.index("Run Prisma real-user smoke test"),
                )
                self.assertLess(
                    text.index("Run Prisma real-user smoke test"),
                    text.index("Run BullMQ real-user smoke test"),
                )


if __name__ == "__main__":
    unittest.main()
