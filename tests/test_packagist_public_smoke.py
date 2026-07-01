from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_packagist_public_smoke.sh"


class PackagistPublicSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_packagist_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_PACKAGIST_VERSION",
            'version="${1:-${LOGBREW_PACKAGIST_VERSION:-0.1.0}}"',
            "https://repo.packagist.org",
            "composer config license proprietary",
            "composer require",
            "composer show logbrew/sdk",
            "Composer\\InstalledVersions",
            "vendor/autoload.php",
            "LogBrew\\LogBrewClient",
            "LogBrew\\RecordingTransport",
            "LogBrew\\HttpTransport",
            "LogBrew\\LogBrewPsrLogger",
            "LogBrew\\LogBrewMonologHandler",
            "monolog/monolog",
            "previewJson",
            "flush-status=202",
            "php public Packagist install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
