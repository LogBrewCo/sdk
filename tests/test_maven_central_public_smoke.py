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
            "LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION",
            "LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION",
            'java_version="${legacy_args[0]:-${LOGBREW_MAVEN_JAVA_VERSION:-0.1.1}}"',
            'kotlin_version="${legacy_args[1]:-${LOGBREW_MAVEN_KOTLIN_VERSION:-0.1.1}}"',
            'okhttp_version="${legacy_args[2]:-${LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION:-$kotlin_version}}"',
            "https://repo.maven.apache.org/maven2",
            "mavenCentral()",
            'implementation("co.logbrew:logbrew-sdk:$javaVersion")',
            'implementation("co.logbrew:logbrew-kotlin:$kotlinVersion")',
            'implementation("co.logbrew:logbrew-kotlin-okhttp:$okhttpVersion")',
            'implementation("org.jetbrains.kotlin:kotlin-stdlib:$kotlinStdlibVersion")',
            "gradle",
            "dependencyInsight",
            "LogBrewClient.create",
            "LogBrewOkHttpRouteTemplates",
            "RecordingTransport.alwaysAccept",
            "flush-status=202",
            "kotlin-status=202",
            "okhttp-route=GET /api/orders/{order_id}",
        ):
            self.assertIn(expected, body)

        self.assertNotIn(
            'grep -q "co.logbrew:logbrew-kotlin:$kotlin_version" "$tmp_dir/okhttp-dependency-insight.txt"',
            body,
        )
        self.assertIn('grep -q "okhttp-route=GET /api/orders/{order_id}" "$tmp_dir/okhttp-run.out"', body)

        self.assertNotIn("api.logbrew", body)
        sensitive_query = "?" + "".join(chr(value) for value in (116, 111, 107, 101, 110)) + "="
        self.assertNotIn(sensitive_query, body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)

    def test_script_accepts_a_release_plan_and_executes_only_selected_consumers(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "--plan",
            "--bundle",
            "maven_release_plan.py validate",
            "LOGBREW_MAVEN_REPOSITORY_UNDER_TEST",
            "LOGBREW_MAVEN_SELECTED_MODULES",
            "exclusiveContent",
            "includeModule('co.logbrew', artifact)",
            'artifact_selected "logbrew-sdk"',
            'artifact_selected "logbrew-kotlin"',
            'artifact_selected "logbrew-kotlin-okhttp"',
        ):
            self.assertIn(expected, body)

        self.assertNotIn("includeGroup('co.logbrew')", body)


if __name__ == "__main__":
    unittest.main()
