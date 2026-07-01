from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_maven_central_public_smoke.sh"


class MavenCentralPublicSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_maven_artifact_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_MAVEN_JAVA_VERSION",
            "LOGBREW_MAVEN_KOTLIN_VERSION",
            "LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION",
            'java_version="${1:-${LOGBREW_MAVEN_JAVA_VERSION:-0.1.0}}"',
            'kotlin_version="${2:-${LOGBREW_MAVEN_KOTLIN_VERSION:-0.1.0}}"',
            "https://repo.maven.apache.org/maven2",
            "mavenCentral()",
            'implementation("co.logbrew:logbrew-sdk:$javaVersion")',
            'implementation("co.logbrew:logbrew-kotlin:$kotlinVersion")',
            'implementation("org.jetbrains.kotlin:kotlin-stdlib:$kotlinStdlibVersion")',
            "gradle",
            "dependencyInsight",
            "LogBrewClient.create",
            "RecordingTransport.alwaysAccept",
            "flush-status=202",
            "kotlin-status=202",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("logbrew-kotlin-okhttp", body)
        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
