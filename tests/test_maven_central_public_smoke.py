from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_maven_central_public_smoke.sh"
POM_PATH = "META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"


class MavenCentralPublicSmokeTests(unittest.TestCase):
    @staticmethod
    def _pom(
        *,
        group_id: str = "co.logbrew",
        artifact_id: str = "logbrew-sdk",
        version: str = "0.1.2",
        extra_coordinates: str = "",
    ) -> str:
        return f"""\
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>{group_id}</groupId>
  <artifactId>{artifact_id}</artifactId>
  <version>{version}</version>
  {extra_coordinates}
</project>
"""

    @staticmethod
    def _write_jar(path: Path, entries: list[tuple[str, str]]) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(path, "w") as archive:
                for name, body in entries:
                    archive.writestr(name, body)

    def _run_receipt(self, artifact: Path, fake_bin: Path) -> subprocess.CompletedProcess[str]:
        environment = {
            **os.environ,
            "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
            "LOGBREW_RELEASE_RECEIPT_MODE": "1",
            "LOGBREW_RELEASE_ARTIFACT_FILES_JSON": json.dumps(
                {"maven:co.logbrew:logbrew-sdk": str(artifact.resolve())},
                separators=(",", ":"),
            ),
        }
        return subprocess.run(
            ["bash", str(SCRIPT), "0.1.2"],
            cwd=ROOT,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_receipt_mode_accepts_public_pom_only_jar_and_attests_exact_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            artifact = tmp / "logbrew-sdk.jar"
            self._write_jar(artifact, [(POM_PATH, self._pom())])
            artifact_bytes = artifact.read_bytes()
            fake_bin = tmp / "bin"
            fake_bin.mkdir()
            for name in ("javac", "java"):
                command = fake_bin / name
                command.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                command.chmod(0o700)

            result = self._run_receipt(artifact, fake_bin)

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
                        + hashlib.sha256(artifact_bytes).hexdigest(),
                    }
                ],
            },
        )

    def test_receipt_mode_rejects_ambiguous_or_invalid_pom_coordinates(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            fake_bin = tmp / "bin"
            fake_bin.mkdir()
            for name in ("javac", "java"):
                command = fake_bin / name
                command.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                command.chmod(0o700)
            cases = {
                "missing": [],
                "duplicate": [(POM_PATH, self._pom()), (POM_PATH, self._pom())],
                "malformed": [(POM_PATH, "<project>")],
                "missing-coordinate": [
                    (
                        POM_PATH,
                        '<project xmlns="http://maven.apache.org/POM/4.0.0">'
                        "<artifactId>logbrew-sdk</artifactId><version>0.1.2</version>"
                        "</project>",
                    )
                ],
                "group": [(POM_PATH, self._pom(group_id="example.invalid"))],
                "artifact": [(POM_PATH, self._pom(artifact_id="other-sdk"))],
                "version": [(POM_PATH, self._pom(version="9.9.9"))],
                "coordinate": [
                    (POM_PATH, self._pom(extra_coordinates="<version>0.1.2</version>"))
                ],
                "extra-pom": [
                    (POM_PATH, self._pom()),
                    ("META-INF/maven/example/other/pom.xml", self._pom()),
                ],
            }

            for name, entries in cases.items():
                with self.subTest(name=name):
                    artifact = tmp / f"{name}.jar"
                    self._write_jar(artifact, entries)
                    result = self._run_receipt(artifact, fake_bin)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(
                        result.stderr,
                        "Maven JAR metadata validation failed\n",
                    )

    def test_script_proves_current_public_maven_artifact_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_MAVEN_JAVA_VERSION",
            "LOGBREW_MAVEN_KOTLIN_VERSION",
            "LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION",
            "LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION",
            "check_maven_jar_metadata.py",
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
