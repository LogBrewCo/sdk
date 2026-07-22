from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts import maven_release_plan


def write_pom(
    root: Path,
    relative_dir: str,
    artifact_id: str,
    version: str,
    dependencies: tuple[tuple[str, str], ...] = (),
) -> None:
    dependency_xml = "".join(
        f"""
    <dependency>
      <groupId>co.logbrew</groupId>
      <artifactId>{dependency}</artifactId>
      <version>{dependency_version}</version>
    </dependency>"""
        for dependency, dependency_version in dependencies
    )
    dependencies_xml = f"<dependencies>{dependency_xml}\n  </dependencies>" if dependencies else ""
    package_dir = root / relative_dir
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "pom.xml").write_text(
        f"""<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>co.logbrew</groupId>
  <artifactId>{artifact_id}</artifactId>
  <version>{version}</version>
  {dependencies_xml}
</project>
""",
        encoding="utf-8",
    )


class MavenReleasePlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        write_pom(self.root, "java/logbrew-java", "logbrew-sdk", "0.1.2")
        write_pom(self.root, "kotlin/logbrew-kotlin", "logbrew-kotlin", "0.1.1")
        write_pom(
            self.root,
            "kotlin/logbrew-kotlin-okhttp",
            "logbrew-kotlin-okhttp",
            "0.1.1",
            (("logbrew-kotlin", "0.1.1"),),
        )

    def tearDown(self) -> None:
        self.temporary.__exit__(None, None, None)

    def test_java_only_plan_accepts_an_independent_version(self) -> None:
        plan = maven_release_plan.create_plan(self.root, ["logbrew-sdk"])

        self.assertEqual(
            plan["selected"],
            [
                {
                    "artifactId": "logbrew-sdk",
                    "coordinate": "co.logbrew:logbrew-sdk",
                    "packageDir": "java/logbrew-java",
                    "version": "0.1.2",
                }
            ],
        )
        self.assertEqual(plan["externalDependencies"], [])

    def test_unselected_unrelated_pom_is_not_a_release_input(self) -> None:
        (self.root / "kotlin/logbrew-kotlin-okhttp/pom.xml").unlink()

        plan = maven_release_plan.create_plan(self.root, ["logbrew-sdk"])

        self.assertEqual([entry["artifactId"] for entry in plan["selected"]], ["logbrew-sdk"])

    def test_cli_normalizes_an_explicit_comma_separated_selection(self) -> None:
        plan_path = self.root / "cli-plan.json"

        status = maven_release_plan.main(
            [
                "create",
                "--root",
                str(self.root),
                "--artifacts",
                "logbrew-sdk, logbrew-kotlin",
                "--output",
                str(plan_path),
            ]
        )

        self.assertEqual(status, 0)
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        self.assertEqual(
            [entry["artifactId"] for entry in plan["selected"]],
            ["logbrew-sdk", "logbrew-kotlin"],
        )

    def test_unselected_internal_dependency_is_an_exact_external_requirement(self) -> None:
        plan = maven_release_plan.create_plan(self.root, ["logbrew-kotlin-okhttp"])

        self.assertEqual(
            plan["externalDependencies"],
            [
                {
                    "artifactId": "logbrew-kotlin",
                    "coordinate": "co.logbrew:logbrew-kotlin",
                    "version": "0.1.1",
                }
            ],
        )

    def test_selected_dependency_must_match_the_dependent_pom(self) -> None:
        write_pom(self.root, "kotlin/logbrew-kotlin", "logbrew-kotlin", "0.1.2")

        with self.assertRaisesRegex(ValueError, "dependency version mismatch"):
            maven_release_plan.create_plan(
                self.root,
                ["logbrew-kotlin", "logbrew-kotlin-okhttp"],
            )

    def test_selection_is_nonempty_unique_and_allowlisted(self) -> None:
        for selection, message in (
            ([], "at least one Maven artifact"),
            (["logbrew-sdk", "logbrew-sdk"], "duplicate Maven artifact"),
            (["logbrew-unknown"], "unsupported Maven artifact"),
        ):
            with self.subTest(selection=selection):
                with self.assertRaisesRegex(ValueError, message):
                    maven_release_plan.create_plan(self.root, selection)

    def test_saved_plan_fails_closed_after_pom_version_drift(self) -> None:
        plan_path = self.root / "plan.json"
        maven_release_plan.write_plan(
            maven_release_plan.create_plan(self.root, ["logbrew-sdk"]),
            plan_path,
        )
        write_pom(self.root, "java/logbrew-java", "logbrew-sdk", "0.1.3")

        with self.assertRaisesRegex(ValueError, "does not match current Maven metadata"):
            maven_release_plan.validate_plan(self.root, plan_path)

    def test_manifest_binds_source_bundle_and_every_selected_file(self) -> None:
        plan = maven_release_plan.create_plan(self.root, ["logbrew-sdk"])
        stage = self.root / "stage"
        artifact_dir = stage / "co/logbrew/logbrew-sdk/0.1.2"
        artifact_dir.mkdir(parents=True)
        artifact = artifact_dir / "logbrew-sdk-0.1.2.jar"
        artifact.write_bytes(b"selected artifact bytes")
        bundle = self.root / "bundle.zip"
        bundle.write_bytes(b"bundle bytes")

        manifest = maven_release_plan.create_manifest(
            plan,
            stage,
            bundle,
            "0123456789abcdef0123456789abcdef01234567",
        )

        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["sourceCommit"], "0123456789abcdef0123456789abcdef01234567")
        self.assertEqual(manifest["bundle"]["sha256"], hashlib.sha256(b"bundle bytes").hexdigest())
        self.assertEqual(
            manifest["artifacts"][0]["files"],
            [
                {
                    "path": "co/logbrew/logbrew-sdk/0.1.2/logbrew-sdk-0.1.2.jar",
                    "sha256": hashlib.sha256(b"selected artifact bytes").hexdigest(),
                }
            ],
        )
        self.assertNotIn("endpoint", json.dumps(manifest).lower())


if __name__ == "__main__":
    unittest.main()
