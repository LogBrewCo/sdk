from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_maven_central_bundle.sh"


class MavenCentralBundleTests(unittest.TestCase):
    def test_builder_uses_an_exact_validated_selection_and_writes_a_manifest(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "--artifact",
            "--plan",
            "--manifest",
            "maven_release_plan.py create",
            "maven_release_plan.py validate",
            "maven_release_plan.py manifest",
            'if artifact_selected "$java_artifact"',
            'if artifact_selected "$kotlin_artifact"',
            'if artifact_selected "$okhttp_artifact"',
        ):
            self.assertIn(expected, body)

        self.assertNotIn(
            'if ! [[ "$java_version" == "$kotlin_version" && "$java_version" == "$okhttp_version" ]]',
            body,
        )

    def test_builder_requires_only_the_selected_artifact_toolchain(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        self.assertIn(
            'if artifact_selected "$java_artifact"; then\n  require_tool javac\n  require_tool javadoc',
            body,
        )
        self.assertIn(
            'if artifact_selected "$kotlin_artifact" || artifact_selected "$okhttp_artifact"; then\n'
            "  require_tool kotlinc",
            body,
        )

    def test_java_bundle_uses_the_full_optional_spring_compile_classpath(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("fetch_java_spring_web_deps", body)
        self.assertIn("$spring_web_classpath", body)

    def test_builder_versions_come_only_from_the_validated_selected_plan(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("plan_version()", body)
        self.assertNotIn("pom_value()", body)


if __name__ == "__main__":
    unittest.main()
