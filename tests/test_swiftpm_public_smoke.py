from __future__ import annotations

import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_swiftpm_public_smoke.sh"
SWIFT_README = ROOT / "swift" / "logbrew-swift" / "README.md"


class SwiftPmPublicSmokeTests(unittest.TestCase):
    def run_receipt(
        self, members: dict[str, bytes]
    ) -> tuple[subprocess.CompletedProcess[str], bool]:
        with tempfile.TemporaryDirectory() as raw_tmp:
            root = Path(raw_tmp)
            archive = root / "sdk-0.1.2.tar.gz"
            fake_bin = root / "bin"
            invocation_marker = root / "swift-invoked"
            fake_bin.mkdir()
            with tarfile.open(archive, "w:gz") as bundle:
                for name, contents in members.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(contents)
                    bundle.addfile(member, io.BytesIO(contents))
            swift = fake_bin / "swift"
            swift.write_text(
                """\
#!/usr/bin/env bash
set -euo pipefail
: > "$SWIFT_INVOCATION_MARKER"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--package-path" ]]; then
    app="$2"
    break
  fi
  shift
done
[[ -f "$app/../sdk/Package.swift" ]]
[[ -f "$app/../sdk/swift/logbrew-swift/Package.swift" ]]
""",
                encoding="utf-8",
            )
            swift.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "LOGBREW_RELEASE_ARTIFACT_FILES_JSON": json.dumps(
                        {"swiftpm:LogBrewCo/sdk": str(archive)}
                    ),
                    "LOGBREW_RELEASE_RECEIPT_MODE": "1",
                    "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
                    "SWIFT_INVOCATION_MARKER": str(invocation_marker),
                    "TMPDIR": str(root),
                }
            )
            result = subprocess.run(
                ["bash", str(SCRIPT), "0.1.2"],
                cwd=ROOT,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            return result, invocation_marker.exists()

    def test_receipt_selects_the_root_package_when_the_archive_has_nested_manifests(
        self,
    ) -> None:
        result, swift_invoked = self.run_receipt(
            {
                "sdk-0.1.2/Package.swift": b"// root package\n",
                "sdk-0.1.2/swift/logbrew-swift/Package.swift": b"// nested package\n",
            }
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn('"id":"swiftpm:LogBrewCo/sdk"', result.stdout)
        self.assertTrue(swift_invoked)

    def test_receipt_rejects_ambiguous_or_unsafe_archive_roots(self) -> None:
        cases = (
            {
                "sdk-0.1.2/Package.swift": b"// root package\n",
                "unexpected/readme.txt": b"extra root\n",
            },
            {
                "../Package.swift": b"// traversal\n",
                "sdk-0.1.2/Package.swift": b"// root package\n",
                "sdk-0.1.2/swift/logbrew-swift/Package.swift": b"// nested package\n",
            },
        )
        for members in cases:
            with self.subTest(members=tuple(members)):
                result, swift_invoked = self.run_receipt(members)

                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn(result.stderr, ("", "SwiftPM release receipt failed\n"))
                self.assertFalse(swift_invoked)

    def test_script_proves_current_public_swiftpm_tag_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_SWIFTPM_VERSION",
            'package_version="${1:-${LOGBREW_SWIFTPM_VERSION:-0.1.9}}"',
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
            "--allow-additive-context",
            "LogBrewClient.create",
            "RecordingTransport.alwaysAccept",
            "HTTPTransport",
            "LogBrewLogger",
            "swiftpm public install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)

    def test_script_evaluates_throwing_status_before_precondition(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("let crashStatus = try crashCapture.status()", body)
        self.assertIn("precondition(crashStatus.lifecycle == .idle)", body)
        self.assertNotIn("precondition(try crashCapture.status()", body)

    def test_swift_readme_uses_the_current_public_swiftpm_tag(self) -> None:
        readme = SWIFT_README.read_text(encoding="utf-8")

        self.assertIn('.package(url: "https://github.com/LogBrewCo/sdk.git", from: "0.1.9")', readme)
        self.assertNotIn('.package(url: "https://github.com/LogBrewCo/sdk.git", from: "0.1.8")', readme)


if __name__ == "__main__":
    unittest.main()
