from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_packagist_public_smoke.sh"


class PackagistPublicSmokeTests(unittest.TestCase):
    def test_receipt_installs_the_validated_repository_root_archive(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            'release_artifact_receipt.py" extract',
            'payload.get("name") != "logbrew/sdk"',
            '"LogBrew\\\\": "php/logbrew-php/src/"',
            '"type": "path"',
            '"symlink": False',
            '"versions": {"logbrew/sdk": version}',
            'cmp "$package_root/composer.json" "vendor/logbrew/sdk/composer.json"',
            'cmp "$package_root/php/logbrew-php/src/LogBrewClient.php"',
        ):
            self.assertIn(expected, body)

    def test_script_proves_current_public_packagist_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_PACKAGIST_VERSION",
            'version="${1:-${LOGBREW_PACKAGIST_VERSION:-0.1.1}}"',
            "https://repo.packagist.org",
            "composer config license proprietary",
            "composer require",
            "composer show logbrew/sdk",
            "Composer\\InstalledVersions",
            "vendor/autoload.php",
            "LogBrew\\LogBrewOperationTracing",
            "LogBrew\\LogBrewTrace",
            "LogBrew\\LogBrewTraceContext",
            "LogBrew\\LogBrewClient",
            "LogBrew\\RecordingTransport",
            "LogBrew\\HttpTransport",
            "LogBrew\\LogBrewPsrLogger",
            "LogBrew\\LogBrewMonologHandler",
            "LogBrew\\ProductTimeline",
            "LogBrew\\SupportTicketDraft",
            "LogBrew\\Traceparent",
            "LogBrew\\TraceparentSpanInput",
            "monolog/monolog",
            "metric(",
            "Traceparent::parse",
            "ProductTimeline::networkMilestone",
            "LogBrewOperationTracing::databaseOperation",
            "SupportTicketDraft::create",
            "[redacted-url]\\/v1\\/events",
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
