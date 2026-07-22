from __future__ import annotations

import json
import re
import sys
import tomllib
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_release_metadata  # noqa: E402
import check_repo_wide_release_versions  # noqa: E402


def xml_value(path: Path, name: str) -> str | None:
    return ET.parse(path).getroot().findtext(f"./PropertyGroup/{name}")


def maven_version(path: Path) -> str | None:
    return ET.parse(path).getroot().findtext("{*}version")


class AffectedFamilyReleasePrepTests(unittest.TestCase):
    def test_exact_affected_package_versions_advance(self) -> None:
        npm_versions = {
            "js/logbrew-js/package.json": ("@logbrew/sdk", "0.1.4"),
            "js/logbrew-browser/package.json": ("@logbrew/browser", "0.1.1"),
            "js/logbrew-node/package.json": ("@logbrew/node", "0.1.2"),
            "js/logbrew-next/package.json": ("@logbrew/next", "0.1.1"),
            "js/logbrew-react-native/package.json": ("@logbrew/react-native", "0.1.1"),
        }
        for relative_path, expected in npm_versions.items():
            manifest = json.loads((ROOT / relative_path).read_text(encoding="utf-8"))
            self.assertEqual((manifest["name"], manifest["version"]), expected)

        pypi_versions = {
            "python/logbrew_py/pyproject.toml": ("logbrew-sdk", "0.1.4"),
            "python/logbrew_fastapi/pyproject.toml": ("logbrew-fastapi", "0.1.3"),
            "python/logbrew_flask/pyproject.toml": ("logbrew-flask", "0.1.1"),
            "python/logbrew_django/pyproject.toml": ("logbrew-django", "0.1.3"),
        }
        for relative_path, expected in pypi_versions.items():
            project = tomllib.loads((ROOT / relative_path).read_text(encoding="utf-8"))["project"]
            self.assertEqual((project["name"], project["version"]), expected)

        rust = tomllib.loads((ROOT / "rust/logbrew/Cargo.toml").read_text(encoding="utf-8"))
        self.assertEqual(rust["package"]["version"], "0.1.2")
        ruby = (ROOT / "ruby/logbrew-ruby/logbrew-sdk.gemspec").read_text(encoding="utf-8")
        self.assertIsNotNone(
            re.search(r'^\s*spec\.version\s*=\s*"0\.1\.2"$', ruby, re.MULTILINE),
            ruby,
        )
        self.assertEqual(maven_version(ROOT / "java/logbrew-java/pom.xml"), "0.1.2")
        self.assertEqual(
            xml_value(ROOT / "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj", "Version"),
            "0.1.5",
        )
        self.assertEqual(
            xml_value(
                ROOT / "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
                "Version",
            ),
            "0.1.0",
        )

    def test_unaffected_maven_and_nuget_packages_remain_unchanged(self) -> None:
        self.assertEqual(maven_version(ROOT / "kotlin/logbrew-kotlin/pom.xml"), "0.1.1")
        self.assertEqual(maven_version(ROOT / "kotlin/logbrew-kotlin-okhttp/pom.xml"), "0.1.1")

        expected = {
            "LogBrew.AspNetCore": "0.1.0",
            "LogBrew.EntityFrameworkCore": "0.1.0",
            "LogBrew.StackExchangeRedis": "0.1.0",
            "LogBrew.OpenTelemetry": "0.1.1",
        }
        for package_id, version in expected.items():
            project = ROOT / f"dotnet/logbrew-dotnet/src/{package_id}/{package_id}.csproj"
            self.assertEqual(xml_value(project, "Version"), version)

    def test_release_checker_constants_match_the_affected_version_matrix(self) -> None:
        self.assertEqual(check_release_metadata.RUST_VERSION, "0.1.2")
        self.assertEqual(check_release_metadata.RUBYGEMS_VERSION, "0.1.2")
        self.assertEqual(check_release_metadata.PACKAGIST_VERSION, "0.1.2")
        self.assertEqual(check_release_metadata.DOTNET_VERSION, "0.1.5")
        self.assertEqual(check_release_metadata.DOTNET_HTTPCLIENT_VERSION, "0.1.0")
        self.assertEqual(check_release_metadata.JAVA_MAVEN_VERSION, "0.1.2")
        self.assertEqual(check_release_metadata.MAVEN_VERSION, "0.1.1")
        self.assertEqual(
            {
                value["name"]: value["version"]
                for value in check_release_metadata.PYTHON_PACKAGES.values()
            },
            {
                "logbrew-sdk": "0.1.4",
                "logbrew-fastapi": "0.1.3",
                "logbrew-flask": "0.1.1",
                "logbrew-django": "0.1.3",
            },
        )

    def test_tag_distributed_receipts_keep_public_baselines_until_release(self) -> None:
        go_smoke = (ROOT / "scripts/real_user_go_public_module_smoke.sh").read_text(encoding="utf-8")
        swift_smoke = (ROOT / "scripts/real_user_swiftpm_public_smoke.sh").read_text(encoding="utf-8")
        swift_readme = (ROOT / "swift/logbrew-swift/README.md").read_text(encoding="utf-8")

        self.assertIn('LOGBREW_GO_MODULE_VERSION:-v0.1.3', go_smoke)
        self.assertIn('LOGBREW_SWIFTPM_VERSION:-0.1.1', swift_smoke)
        self.assertIn('from: "0.1.2"', swift_readme)

    def test_public_receipt_defaults_match_current_registry_baselines(self) -> None:
        receipt_defaults = {
            "scripts/real_user_npm_public_registry_smoke.sh": (
                "LOGBREW_NPM_SDK_VERSION:-0.1.3",
                "LOGBREW_NPM_BROWSER_VERSION:-0.1.0",
                "LOGBREW_NPM_NODE_VERSION:-0.1.1",
                "LOGBREW_NPM_NEXT_VERSION:-0.1.0",
                "LOGBREW_NPM_REACT_NATIVE_VERSION:-0.1.0",
            ),
            "scripts/real_user_cratesio_public_smoke.sh": ("LOGBREW_CRATESIO_VERSION:-0.1.0",),
            "scripts/real_user_rubygems_public_smoke.sh": ("LOGBREW_RUBYGEMS_VERSION:-0.1.1",),
            "scripts/real_user_packagist_public_smoke.sh": ("LOGBREW_PACKAGIST_VERSION:-0.1.1",),
            "scripts/real_user_maven_central_public_smoke.sh": (
                "LOGBREW_MAVEN_JAVA_VERSION:-0.1.1",
                "LOGBREW_MAVEN_KOTLIN_VERSION:-0.1.1",
            ),
            "scripts/real_user_dotnet_public_nuget_smoke.sh": (
                "LOGBREW_DOTNET_CORE_VERSION:-0.1.4",
                "LOGBREW_DOTNET_HTTPCLIENT_VERSION:-0.1.0",
            ),
            "scripts/real_user_python_public_pypi_smoke.sh": (
                "LOGBREW_PYPI_SDK_VERSION:-0.1.3",
                "LOGBREW_PYPI_FASTAPI_VERSION:-0.1.2",
                "LOGBREW_PYPI_FLASK_VERSION:-0.1.0",
                "LOGBREW_PYPI_DJANGO_VERSION:-0.1.2",
            ),
        }
        for relative_path, expected_values in receipt_defaults.items():
            body = (ROOT / relative_path).read_text(encoding="utf-8")
            for expected in expected_values:
                self.assertIn(expected, body, relative_path)

    def test_repo_wide_guard_includes_newly_publishable_flask_and_httpclient(self) -> None:
        labels = {
            manifest.label
            for manifest in check_repo_wide_release_versions.REPO_WIDE_RELEASE_MANIFESTS
        }
        self.assertIn("logbrew-flask", labels)
        self.assertIn("LogBrew.HttpClient", labels)


if __name__ == "__main__":
    unittest.main()
