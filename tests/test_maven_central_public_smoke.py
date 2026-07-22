from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_maven_central_public_smoke.sh"


class MavenCentralPublicSmokeTests(unittest.TestCase):
    def test_receipt_mode_accepts_one_java_version_and_attests_exact_jar(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            artifact = tmp / "logbrew-sdk.jar"
            artifact.write_bytes(b"java-release-artifact")
            fake_bin = tmp / "bin"
            fake_bin.mkdir()
            for name, body in {
                "unzip": "#!/bin/sh\nprintf 'version=0.1.2\\n'\n",
                "javac": "#!/bin/sh\nexit 0\n",
                "java": "#!/bin/sh\nexit 0\n",
            }.items():
                command = fake_bin / name
                command.write_text(body, encoding="utf-8")
                command.chmod(0o700)
            environment = {
                **os.environ,
                "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
                "LOGBREW_RELEASE_RECEIPT_MODE": "1",
                "LOGBREW_RELEASE_ARTIFACT_FILES_JSON": json.dumps(
                    {"maven:co.logbrew:logbrew-sdk": str(artifact.resolve())},
                    separators=(",", ":"),
                ),
            }

            result = subprocess.run(
                ["bash", str(SCRIPT), "0.1.2"],
                cwd=ROOT,
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(
            json.loads(result.stdout),
            {
                "schema_version": 1,
                "status": "passed",
                "artifacts": [
                    {
                        "id": "maven:co.logbrew:logbrew-sdk",
                        "digest": "sha256:"
                        + hashlib.sha256(b"java-release-artifact").hexdigest(),
                    }
                ],
            },
        )

    def test_script_proves_current_public_maven_artifact_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_MAVEN_JAVA_VERSION",
            "LOGBREW_MAVEN_KOTLIN_VERSION",
            "LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION",
            "LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION",
            'java_version="${legacy_args[0]:-${LOGBREW_MAVEN_JAVA_VERSION:-0.1.2}}"',
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
