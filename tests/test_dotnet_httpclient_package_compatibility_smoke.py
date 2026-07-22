from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_dotnet_httpclient_package_compatibility_smoke.sh"


class DotnetHttpClientPackageCompatibilitySmokeTests(unittest.TestCase):
    def test_script_proves_packed_jit_aot_source_digest_and_identity(self) -> None:
        self.assertTrue(SCRIPT.is_file())
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LogBrew.HttpClient",
            "LOGBREW_NUGET_SOURCE",
            "package_content_sha256",
            "source_commit",
            "GetPublicKeyToken",
            "<PublishAot>true</PublishAot>",
            "brew --prefix openssl@3",
            "brew --prefix brotli",
            "NativeAOT verifier dependencies unavailable",
            "dotnet run",
            "PublishAot=true",
            "--self-contained",
            "file -b",
            "NativeAOT publish did not produce a native executable",
            "selected-client receipt",
            "assembly identity unsigned",
        ):
            self.assertIn(expected, body)


if __name__ == "__main__":
    unittest.main()
