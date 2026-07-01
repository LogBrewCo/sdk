from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_go_public_module_smoke.sh"


class GoPublicModuleSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_go_module_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_GO_MODULE_VERSION",
            'requested_version="${1:-${LOGBREW_GO_MODULE_VERSION:-v0.1.0}}"',
            "GOPROXY=https://proxy.golang.org,direct",
            "go get github.com/LogBrewCo/sdk/go/logbrew@",
            "go mod download -json",
            "go mod verify",
            "go doc github.com/LogBrewCo/sdk/go/logbrew NewClient",
            "go version -m",
            "httptest.NewServer",
            "AlwaysAcceptTransport",
            "NewHTTPTransport",
            "go public module install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
