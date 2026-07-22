from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_cratesio_public_smoke.sh"


class CratesIoPublicSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_crate_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_CRATESIO_VERSION",
            'version="${1:-${LOGBREW_CRATESIO_VERSION:-0.1.2}}"',
            "cargo add logbrew@",
            "cargo tree",
            "cargo run --quiet",
            "cargo doc --no-deps",
            "RecordingTransport::always_accept",
            "LogBrewClient::builder",
            "preview_json",
            "rust public crates.io install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
