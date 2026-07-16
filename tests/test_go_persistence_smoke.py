import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class GoPersistenceSmokeContractTests(unittest.TestCase):
    def test_installed_smoke_uses_two_processes_and_strict_loopback_intake(self) -> None:
        script = (ROOT / "scripts/real_user_go_persistence_smoke.sh").read_text()

        for required in (
            "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0",
            "NewPersistentAutomaticClient",
            "os.Exit(0)",
            '"/v1/events"',
            "prefixSHA256",
            "orderedUnique=true",
            "authorizationOK",
            "cmd/writer",
            "cmd/reader",
        ):
            self.assertIn(required, script)

        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertIn(
            "bash scripts/real_user_go_persistence_smoke.sh",
            workflow,
        )


if __name__ == "__main__":
    unittest.main()
