from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_ENDPOINT = "https://api.logbrew.co/v1/events"
STALE_ENDPOINT = "https://api.logbrew." + "com/v1/events"
DEFAULT_SOURCE_FILES = (
    "c/logbrew-c/include/logbrew.h",
    "cpp/logbrew-cpp/include/logbrew.hpp",
    "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.cs",
    "go/logbrew/logbrew.go",
    "java/logbrew-java/src/main/java/co/logbrew/sdk/HttpTransport.java",
    "js/logbrew-browser/index.cjs",
    "js/logbrew-browser/index.js",
    "js/logbrew-node/index.cjs",
    "js/logbrew-node/index.js",
    "kotlin/logbrew-kotlin/src/main/kotlin/co/logbrew/sdk/PublicTypes.kt",
    "objc/logbrew-objc/src/LBWHTTPTransport.m",
    "php/logbrew-php/src/HttpTransport.php",
    "python/logbrew_py/src/logbrew_sdk/__init__.py",
    "ruby/logbrew-ruby/lib/logbrew.rb",
    "rust/logbrew/src/lib.rs",
    "swift/logbrew-swift/Sources/LogBrew/Transport.swift",
    "unity/logbrew-unity/Runtime/PublicTypes.cs",
)


class DefaultIngestEndpointTests(unittest.TestCase):
    def test_every_transport_source_uses_the_deployed_compatibility_endpoint(self) -> None:
        for relative_path in DEFAULT_SOURCE_FILES:
            with self.subTest(path=relative_path):
                content = (ROOT / relative_path).read_text(encoding="utf-8")
                self.assertIn(EXPECTED_ENDPOINT, content)
                self.assertNotIn(STALE_ENDPOINT, content)

    def test_tracked_public_files_do_not_reference_the_stale_endpoint(self) -> None:
        result = subprocess.run(
            ["git", "grep", "--fixed-strings", "--line-number", STALE_ENDPOINT, "--"],
            cwd=ROOT,
            capture_output=True,
            check=False,
            text=True,
        )

        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
