from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_swiftpm_public_smoke.sh"
SWIFT_README = ROOT / "swift" / "logbrew-swift" / "README.md"


class SwiftPmPublicSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_swiftpm_tag_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_SWIFTPM_VERSION",
            'package_version="${1:-${LOGBREW_SWIFTPM_VERSION:-0.1.1}}"',
            'package_url="${LOGBREW_SWIFTPM_URL:-https://github.com/LogBrewCo/sdk.git}"',
            'package_identity="${LOGBREW_SWIFTPM_PACKAGE_IDENTITY:-sdk}"',
            "LOGBREW_SWIFTPM_EXPECTED_REVISION",
            "LOGBREW_SWIFTPM_EXPECTED_SOURCE_SHA256",
            ".package(url: packageURL, exact: packageVersion)",
            '.product(name: "LogBrew", package: packageIdentity)',
            '.product(name: "LogBrewCrash", package: packageIdentity)',
            "import LogBrewCrash",
            "NativeCrashConfiguration",
            "NativeCrashCapture",
            'git -C "$package_checkout" archive',
            '"sourceArchiveSha256"',
            'swift package --scratch-path "$tmp_dir/resolve" resolve',
            'swift package --scratch-path "$tmp_dir/describe" describe --type json',
            'swift package --scratch-path "$tmp_dir/dependencies" show-dependencies --format json',
            "swift run",
            "swift build",
            "swift test",
            "LogBrewClient.create",
            "RecordingTransport.alwaysAccept",
            "HTTPTransport",
            "LogBrewLogger",
            "swiftpm public install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)

    def test_swift_readme_uses_the_current_public_swiftpm_tag(self) -> None:
        readme = SWIFT_README.read_text(encoding="utf-8")

        self.assertIn('.package(url: "https://github.com/LogBrewCo/sdk.git", from: "0.1.2")', readme)
        self.assertNotIn('.package(url: "https://github.com/LogBrewCo/sdk.git", from: "0.1.1")', readme)


if __name__ == "__main__":
    unittest.main()
