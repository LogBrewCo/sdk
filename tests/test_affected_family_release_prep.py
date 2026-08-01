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
            "js/logbrew-js/package.json": ("@logbrew/sdk", "0.1.6"),
            "js/logbrew-browser/package.json": ("@logbrew/browser", "0.1.1"),
            "js/logbrew-express/package.json": ("@logbrew/express", "0.1.2"),
            "js/logbrew-fastify/package.json": ("@logbrew/fastify", "0.1.4"),
            "js/logbrew-node/package.json": ("@logbrew/node", "0.1.3"),
            "js/logbrew-nestjs/package.json": ("@logbrew/nestjs", "0.1.4"),
            "js/logbrew-next/package.json": ("@logbrew/next", "0.1.3"),
            "js/logbrew-react-native/package.json": ("@logbrew/react-native", "0.1.12"),
        }
        for relative_path, expected in npm_versions.items():
            manifest = json.loads((ROOT / relative_path).read_text(encoding="utf-8"))
            self.assertEqual((manifest["name"], manifest["version"]), expected)

        pypi_versions = {
            "python/logbrew_py/pyproject.toml": ("logbrew-sdk", "0.1.7"),
            "python/logbrew_fastapi/pyproject.toml": ("logbrew-fastapi", "0.1.8"),
            "python/logbrew_flask/pyproject.toml": ("logbrew-flask", "0.1.2"),
            "python/logbrew_django/pyproject.toml": ("logbrew-django", "0.1.4"),
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

    def test_react_native_release_requires_the_fixed_mobile_core(self) -> None:
        manifest = json.loads(
            (ROOT / "js/logbrew-react-native/package.json").read_text(
                encoding="utf-8"
            )
        )

        self.assertEqual(
            manifest["peerDependencies"]["@logbrew/sdk"],
            "^0.1.5",
        )

    def test_python_core_declares_and_ci_installs_tls_trust_dependencies(self) -> None:
        project = tomllib.loads(
            (ROOT / "python/logbrew_py/pyproject.toml").read_text(encoding="utf-8")
        )["project"]
        self.assertEqual(
            set(project["dependencies"]),
            {
                "certifi>=2026.7.22",
                "truststore>=0.10.4,<1",
                "typing-extensions>=4.1; python_version < '3.11'",
            },
        )

        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        install = "python3 -m pip install certifi==2026.7.22 truststore==0.10.4"
        source_tests = (
            "PYTHONPATH=python/logbrew_py/src python3 -m unittest discover "
            "-s python/logbrew_py/tests -p 'test_*.py'"
        )
        self.assertIn(install, workflow)
        self.assertIn(source_tests, workflow)
        self.assertLess(workflow.index(install), workflow.index(source_tests))

    def test_fastapi_celery_extra_requires_the_fixed_core_without_bloating_base_install(self) -> None:
        project = tomllib.loads(
            (ROOT / "python/logbrew_fastapi/pyproject.toml").read_text(encoding="utf-8")
        )["project"]

        self.assertEqual(
            project["optional-dependencies"]["celery"],
            ["logbrew-sdk[celery]>=0.1.7,<0.2.0"],
        )
        self.assertNotIn("celery>=5,<6", project["dependencies"])
        self.assertIn("logbrew-sdk>=0.1.7,<0.2.0", project["dependencies"])

    def test_react_native_bundle_smoke_reads_package_versions(self) -> None:
        smoke = (
            ROOT / "scripts/real_user_react_native_bundle_smoke.sh"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "expected_sdk_version=\"$(node -p \"require('${repo_root}/js/logbrew-js/package.json').version\")\"",
            smoke,
        )
        self.assertIn(
            "expected_react_native_package_version=\"$(node -p \"require('${repo_root}/js/logbrew-react-native/package.json').version\")\"",
            smoke,
        )

    def test_react_native_release_selector_accepts_name_and_package_directory(
        self,
    ) -> None:
        workflow = (
            ROOT / ".github/workflows/publish-packages.yml"
        ).read_text(encoding="utf-8")
        package_dirs = workflow.split("package_dirs=(", 1)[1].split("\n          )", 1)[0]
        selector = workflow.split("select_npm_package_dirs() {", 1)[1].split(
            "\n          mapfile -t package_dirs",
            1,
        )[0]

        self.assertRegex(package_dirs, r"(?m)^\s+js/logbrew-react-native$")
        self.assertIn(
            'package_name="$(node -p "require(\'./${package_dir}/package.json\').name")"',
            selector,
        )
        self.assertIn(
            '"$requested_package" != "$package_dir"',
            selector,
        )
        self.assertIn(
            '"$requested_package" != "$package_name"',
            selector,
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
        self.assertEqual(check_release_metadata.PACKAGIST_VERSION, "0.1.6")
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
                "logbrew-sdk": "0.1.7",
                "logbrew-fastapi": "0.1.8",
                "logbrew-flask": "0.1.2",
                "logbrew-django": "0.1.4",
            },
        )

    def test_tag_distributed_receipts_keep_public_baselines_until_release(self) -> None:
        go_smoke = (ROOT / "scripts/real_user_go_public_module_smoke.sh").read_text(encoding="utf-8")
        swift_smoke = (ROOT / "scripts/real_user_swiftpm_public_smoke.sh").read_text(encoding="utf-8")
        swift_readme = (ROOT / "swift/logbrew-swift/README.md").read_text(encoding="utf-8")

        self.assertIn('LOGBREW_GO_MODULE_VERSION:-v0.1.4', go_smoke)
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
            "scripts/real_user_packagist_public_smoke.sh": ("LOGBREW_PACKAGIST_VERSION:-0.1.6",),
            "scripts/real_user_maven_central_public_smoke.sh": (
                "LOGBREW_MAVEN_JAVA_VERSION:-0.1.1",
                "LOGBREW_MAVEN_KOTLIN_VERSION:-0.1.1",
            ),
            "scripts/real_user_dotnet_public_nuget_smoke.sh": (
                "LOGBREW_DOTNET_CORE_VERSION:-0.1.4",
                "LOGBREW_DOTNET_HTTPCLIENT_VERSION:-0.1.0",
            ),
            "scripts/real_user_python_public_pypi_smoke.sh": (
                "LOGBREW_PYPI_SDK_VERSION:-0.1.7",
                "LOGBREW_PYPI_FASTAPI_VERSION:-0.1.8",
                "LOGBREW_PYPI_FLASK_VERSION:-0.1.2",
                "LOGBREW_PYPI_DJANGO_VERSION:-0.1.4",
            ),
        }
        for relative_path, expected_values in receipt_defaults.items():
            body = (ROOT / relative_path).read_text(encoding="utf-8")
            for expected in expected_values:
                self.assertIn(expected, body, relative_path)

    def test_local_npm_smokes_bind_assertions_to_package_manifests(self) -> None:
        smoke_contracts = {
            "scripts/real_user_browser_smoke.sh": (
                "js/logbrew-browser/package.json",
                "@logbrew/browser",
                "browser_package_version",
                2,
            ),
            "scripts/real_user_react_smoke.sh": (
                "js/logbrew-browser/package.json",
                "@logbrew/browser",
                "browser_package_version",
                1,
            ),
            "scripts/real_user_next_smoke.sh": (
                "js/logbrew-next/package.json",
                "@logbrew/next",
                "next_package_version",
                2,
            ),
            "scripts/real_user_react_native_smoke.sh": (
                "js/logbrew-react-native/package.json",
                "@logbrew/react-native",
                "react_native_package_version",
                2,
            ),
        }
        stale_version = re.compile(r"@logbrew/(?:browser|next|react-native)@\d")

        for script_path, (manifest_path, package_name, variable, assertions) in smoke_contracts.items():
            with self.subTest(script=script_path):
                manifest = json.loads((ROOT / manifest_path).read_text(encoding="utf-8"))
                body = (ROOT / script_path).read_text(encoding="utf-8")

                self.assertEqual(manifest["name"], package_name)
                self.assertIsInstance(manifest["version"], str)
                self.assertTrue(manifest["version"])
                self.assertIn(f'{variable}="$(', body)
                self.assertIn(f'"$repo_root/{manifest_path}"', body)
                self.assertIn("const version = require(process.argv[1]).version;", body)
                self.assertIn('typeof version !== "string" || version.length === 0', body)
                self.assertIn("process.stdout.write(version);", body)
                fixed_assertion = f'grep -Fq "{package_name}@${{{variable}}}"'
                self.assertEqual(body.count(fixed_assertion), assertions)
                self.assertIsNone(stale_version.search(body), script_path)

    def test_repo_wide_guard_includes_newly_publishable_flask_and_httpclient(self) -> None:
        labels = {
            manifest.label
            for manifest in check_repo_wide_release_versions.REPO_WIDE_RELEASE_MANIFESTS
        }
        self.assertIn("logbrew-flask", labels)
        self.assertIn("LogBrew.HttpClient", labels)


if __name__ == "__main__":
    unittest.main()
