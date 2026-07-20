import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_go_http_client_smoke.sh"


class GoHTTPClientSmokeContractTests(unittest.TestCase):
    def test_installed_module_smoke_is_strict_and_loopback_only(self) -> None:
        script = SCRIPT.read_text()

        for expected in (
            'version = "v0.1.0"',
            'GOPROXY="file://$proxy_dir"',
            "go test -race",
            "expectedTargetRequests = 4",
            "expectedSpans",
            "spans=3",
            "caller traceparent changed",
            "installed payload leaked",
            "installed module proof must not use a source replacement",
            "go mod verify",
            "sha256=$module_digest",
        ):
            self.assertIn(expected, script)
        self.assertNotIn("go get github.com/LogBrewCo/sdk/go/logbrew@latest", script)


if __name__ == "__main__":
    unittest.main()
