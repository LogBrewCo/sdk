from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMMAND = "bash scripts/real_user_node_persistent_delivery_smoke.sh"
ENCRYPTED_COMMAND = "bash scripts/real_user_node_encrypted_persistent_delivery_smoke.sh"


class NodePersistentDeliveryWorkflowGateTests(unittest.TestCase):
    def test_targeted_ci_and_public_verifier_run_restart_proof(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        public_verifier = (ROOT / "scripts" / "check_public_sdks.sh").read_text(encoding="utf-8")

        self.assertIn("Run Node persistent delivery restart smoke test", workflow)
        self.assertIn(f"run: {COMMAND}", workflow)
        self.assertIn("Run Node encrypted persistent delivery smoke test", workflow)
        self.assertIn(f"run: {ENCRYPTED_COMMAND}", workflow)
        self.assertIn('"Node persistent delivery restart smoke"', public_verifier)
        self.assertIn(f'run_shell_step "{COMMAND}"', public_verifier)
        self.assertIn('"Node encrypted persistent delivery smoke"', public_verifier)
        self.assertIn(f'run_shell_step "{ENCRYPTED_COMMAND}"', public_verifier)

    def test_restart_proof_binds_packed_types_retry_replay_and_purge(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_node_persistent_delivery_smoke.sh").read_text(
            encoding="utf-8"
        )

        for expected in (
            "npm pack --json",
            "typescript@6.0.3",
            "process.exit(0)",
            "persistent_queue_in_use",
            "requests[0].body, requests[1].body",
            'response.statusCode = requests.length === 1 ? 503 : 202;',
            "restart-first",
            "restart-later",
            "purgeLogBrewNodePersistentQueue",
            "shasum -a 256",
        ):
            self.assertIn(expected, smoke)

    def test_encrypted_restart_proof_remains_separate_and_targeted(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_node_encrypted_persistent_delivery_smoke.sh").read_text(
            encoding="utf-8"
        )

        for expected in (
            "npm pack --json",
            "persistentQueue",
            "encryptionKey",
            "deliveryHealth",
            "failedShutdownRecovered",
        ):
            self.assertIn(expected, smoke)


if __name__ == "__main__":
    unittest.main()
