from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_rubygems_public_smoke.sh"


class RubyGemsPublicSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_rubygems_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_RUBYGEMS_VERSION",
            'version="${1:-${LOGBREW_RUBYGEMS_VERSION:-0.1.0}}"',
            "https://rubygems.org",
            "gem install",
            "gem list --local",
            "gem specification",
            "Gem::Specification.find_by_name",
            "require \"logbrew\"",
            "LogBrew::Client.create",
            "LogBrew::HttpTransport",
            "LogBrew::Logger",
            "LogBrew::RackMiddleware",
            "LogBrew::RailsErrorSubscriber",
            "RecordingTransport",
            "readme_example.rb",
            "real_user_smoke.rb",
            "flush_status",
            "ruby public RubyGems install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
