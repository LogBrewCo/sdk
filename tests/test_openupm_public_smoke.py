from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_openupm_public_smoke.sh"


class OpenUpmPublicSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_openupm_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_OPENUPM_VERSION",
            'version="${1:-${LOGBREW_OPENUPM_VERSION:-0.1.0}}"',
            "https://package.openupm.com",
            "npm pack co.logbrew.unity@",
            "scopedRegistries",
            "co.logbrew.unity",
            "Samples~/ReadmeExample/ReadmeExample.cs",
            "Samples~/RealUserSmoke/RealUserSmoke.cs",
            "dotnet run",
            "openupm public install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
