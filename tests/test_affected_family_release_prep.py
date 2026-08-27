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
from check_npm_peer_compatibility import caret_range_allows  # noqa: E402
import check_repo_wide_release_versions  # noqa: E402


def xml_value(path: Path, name: str) -> str | None:
    return ET.parse(path).getroot().findtext(f"./PropertyGroup/{name}")


def maven_version(path: Path) -> str | None:
    return ET.parse(path).getroot().findtext("{*}version")


def source_text(relative_path: str | Path) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def json_object(relative_path: str) -> dict[str, object]:
    return json.loads(source_text(relative_path))


class AffectedFamilyReleasePrepTests(unittest.TestCase):
    def test_exact_affected_package_versions_advance(self) -> None:
        npm_versions = {
            "js/logbrew-js/package.json": ("@logbrew/sdk", "0.1.14"),
            "js/logbrew-browser/package.json": ("@logbrew/browser", "0.1.7"),
            "js/logbrew-express/package.json": ("@logbrew/express", "0.1.4"),
            "js/logbrew-fastify/package.json": ("@logbrew/fastify", "0.1.5"),
            "js/logbrew-node/package.json": ("@logbrew/node", "0.1.8"),
            "js/logbrew-nestjs/package.json": ("@logbrew/nestjs", "0.1.5"),
            "js/logbrew-next/package.json": ("@logbrew/next", "0.1.5"),
            "js/logbrew-react/package.json": ("@logbrew/react", "0.1.1"),
            "js/logbrew-react-native/package.json": ("@logbrew/react-native", "0.1.17"),
            "js/logbrew-svelte/package.json": ("@logbrew/svelte", "0.1.3"),
        }
        for relative_path, expected in npm_versions.items():
            manifest = json_object(relative_path)
            self.assertEqual((manifest["name"], manifest["version"]), expected)

        pypi_versions = {
            "python/logbrew_py/pyproject.toml": ("logbrew-sdk", "0.1.12"),
            "python/logbrew_fastapi/pyproject.toml": ("logbrew-fastapi", "0.1.10"),
            "python/logbrew_flask/pyproject.toml": ("logbrew-flask", "0.1.5"),
            "python/logbrew_django/pyproject.toml": ("logbrew-django", "0.1.6"),
        }
        for relative_path, expected in pypi_versions.items():
            project = tomllib.loads(source_text(relative_path))["project"]
            self.assertEqual((project["name"], project["version"]), expected)

        rust = tomllib.loads(source_text("rust/logbrew/Cargo.toml"))
        self.assertEqual(rust["package"]["version"], "0.1.4")
        ruby_version = source_text("ruby/logbrew-ruby/lib/logbrew/version.rb")
        self.assertIn(f'VERSION = "{check_release_metadata.RUBYGEMS_VERSION}"', ruby_version)
        self.assertEqual(maven_version(ROOT / "java/logbrew-java/pom.xml"), "0.1.6")
        self.assertEqual(
            xml_value(ROOT / "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj", "Version"),
            "0.1.7",
        )
        self.assertEqual(
            xml_value(
                ROOT / "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
                "Version",
            ),
            "0.1.2",
        )

    def test_native_family_versions_advance(self) -> None:
        self.assertIn(
            '#define LOGBREW_C_VERSION "0.2.2"',
            source_text("c/logbrew-c/include/logbrew.h"),
        )
        self.assertIn(
            'inline constexpr const char *version = "0.2.3"',
            source_text("cpp/logbrew-cpp/include/logbrew.hpp"),
        )
        self.assertIn(
            'LogBrewObjectiveCVersion = @"0.2.3"',
            source_text("objc/logbrew-objc/src/LogBrew.m"),
        )
        unity = json_object("unity/logbrew-unity/package.json")
        self.assertEqual((unity["name"], unity["version"]), ("co.logbrew.unity", "0.2.2"))

    def test_react_native_release_requires_fixed_core_range_and_updates_native_identity(self) -> None:
        manifest = json_object("js/logbrew-react-native/package.json")

        self.assertEqual(
            manifest["peerDependencies"]["@logbrew/sdk"],
            "^0.1.12",
        )

        native_source = source_text(
            "js/logbrew-react-native/ios/AppleDiagnostics/LBRNAppleNativeDiagnostics.swift"
        )
        self.assertIn(
            f'private static let sdkVersion = "{manifest["version"]}"',
            native_source,
        )

    def test_javascript_runtime_metadata_matches_package_releases(self) -> None:
        for package in ("logbrew-node", "logbrew-browser"):
            manifest = json_object(f"js/{package}/package.json")
            declaration = f'const DEFAULT_SDK_VERSION = "{manifest["version"]}";'
            for entrypoint in ("index.js", "index.cjs"):
                source = source_text(Path("js") / package / entrypoint)
                with self.subTest(package=package, entrypoint=entrypoint):
                    self.assertIn(declaration, source)

    def test_node_runtime_context_accepts_the_current_core_release(self) -> None:
        core_manifest = json_object("js/logbrew-js/package.json")
        node_manifest = json_object("js/logbrew-node/package.json")

        self.assertTrue(
            caret_range_allows(
                node_manifest["peerDependencies"]["@logbrew/sdk"],
                core_manifest["version"],
            )
        )

    def test_python_core_declares_and_ci_installs_tls_trust_dependencies(self) -> None:
        project = tomllib.loads(source_text("python/logbrew_py/pyproject.toml"))["project"]
        self.assertEqual(
            set(project["dependencies"]),
            {
                "certifi>=2026.7.22",
                "truststore>=0.10.4,<1",
                "typing-extensions>=4.1; python_version < '3.11'",
            },
        )

        workflow = source_text(".github/workflows/ci.yml")
        install = "python3 -m pip install certifi==2026.7.22 truststore==0.10.4"
        source_tests = (
            "PYTHONPATH=python/logbrew_py/src python3 -m unittest discover "
            "-s python/logbrew_py/tests -p 'test_*.py'"
        )
        self.assertIn(install, workflow)
        self.assertIn(source_tests, workflow)
        self.assertLess(workflow.index(install), workflow.index(source_tests))

        readiness = source_text(".github/workflows/release-readiness.yml")
        metadata_install = "python3 -m pip install ./python/logbrew_py"
        self.assertIn(metadata_install, readiness)
        self.assertIn(source_tests, readiness)
        self.assertLess(readiness.index(metadata_install), readiness.index(source_tests))

    def test_python_integrations_require_the_description_core_without_bloating_fastapi(self) -> None:
        project = tomllib.loads(source_text("python/logbrew_fastapi/pyproject.toml"))["project"]

        self.assertEqual(
            project["optional-dependencies"]["celery"],
            ["logbrew-sdk[celery]>=0.1.12,<0.2.0"],
        )
        self.assertNotIn("celery>=5,<6", project["dependencies"])
        self.assertIn("logbrew-sdk>=0.1.12,<0.2.0", project["dependencies"])

        for relative_path in (
            "python/logbrew_flask/pyproject.toml",
            "python/logbrew_django/pyproject.toml",
        ):
            integration = tomllib.loads(source_text(relative_path))["project"]
            with self.subTest(relative_path=relative_path):
                self.assertIn(
                    "logbrew-sdk>=0.1.12,<0.2.0",
                    integration["dependencies"],
                )

    def test_react_native_bundle_smoke_reads_package_versions(self) -> None:
        smoke = source_text("scripts/real_user_react_native_bundle_smoke.sh")
        for expected in (
            "expected_sdk_version=\"$(node -p \"require('${repo_root}/js/logbrew-js/package.json').version\")\"",
            "expected_react_native_package_version=\"$(node -p \"require('${repo_root}/js/logbrew-react-native/package.json').version\")\"",
        ):
            self.assertIn(expected, smoke)

    def test_react_native_minimum_public_peer_is_checked_before_publish(self) -> None:
        smoke_name = "scripts/real_user_react_native_minimum_peer_smoke.sh"
        smoke = source_text(smoke_name)
        workflow = source_text(".github/workflows/publish-packages.yml")
        ci = source_text(".github/workflows/ci.yml")

        self.assertIn('"@logbrew/sdk@$minimum_sdk_version"', smoke)
        self.assertIn('await import("@logbrew/react-native")', smoke)
        self.assertIn('require("@logbrew/react-native")', smoke)
        invocation = f"bash {smoke_name}"
        publish = 'echo "Publishing ${package_name} from ${package_dir}"'
        self.assertIn(invocation, workflow)
        self.assertLess(workflow.index(invocation), workflow.index(publish))
        self.assertIn(invocation, ci)

    def test_npm_release_selector_and_bun_commands(self) -> None:
        workflow = source_text(".github/workflows/publish-packages.yml")
        npm_job = workflow.split("\n  npm:\n", 1)[1].split("\n  pypi:\n", 1)[0]
        package_dirs = workflow.split("package_dirs=(", 1)[1].split("\n          )", 1)[0]
        selector = workflow.split("select_npm_package_dirs() {", 1)[1].split(
            "\n          mapfile -t package_dirs",
            1,
        )[0]

        self.assertRegex(package_dirs, r"(?m)^\s+js/logbrew-react-native$")
        for needle in (
            'package_name="$(package_field "$package_dir" name)"',
            '"$requested_package" != "$package_dir"',
            '"$requested_package" != "$package_name"',
        ):
            self.assertIn(needle, selector)
        for needle in (
            "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
            'bun-version: "1.3.14"',
            "bun pm pack --dry-run --ignore-scripts",
            'NPM_CONFIG_TO' 'KEN="${publish_grants[$package_index]}" bun publish "${publish_args[@]}"',
            "/-/npm/v1/oidc/" "token/exchange/package/",
        ):
            self.assertIn(needle, npm_job)
        for forbidden in ("actions/setup-node", "corepack"):
            self.assertNotIn(forbidden, npm_job)
        self.assertNotRegex(npm_job, r"(?m)^\s*node\s+-")
        self.assertNotRegex(npm_job, r"(?m)^\s*(?:\([^)]*&&\s*)?npm\s+(?:pack|publish)\b")

    def test_maven_and_nuget_package_versions_match_the_release_matrix(self) -> None:
        self.assertEqual(maven_version(ROOT / "kotlin/logbrew-kotlin/pom.xml"), "0.2.2")
        self.assertEqual(maven_version(ROOT / "kotlin/logbrew-kotlin-okhttp/pom.xml"), "0.2.2")

        expected = {
            "LogBrew.AspNetCore": "0.1.2",
            "LogBrew.EntityFrameworkCore": "0.1.0",
            "LogBrew.StackExchangeRedis": "0.1.0",
            "LogBrew.OpenTelemetry": "0.1.1",
        }
        for package_id, version in expected.items():
            project = ROOT / f"dotnet/logbrew-dotnet/src/{package_id}/{package_id}.csproj"
            self.assertEqual(xml_value(project, "Version"), version)

    def test_release_checker_constants_match_the_affected_version_matrix(self) -> None:
        self.assertEqual(check_release_metadata.RUST_VERSION, "0.1.4")
        self.assertEqual(check_release_metadata.RUBYGEMS_VERSION, "0.1.12")
        self.assertEqual(check_release_metadata.PACKAGIST_VERSION, "0.1.10")
        self.assertEqual(check_release_metadata.DOTNET_VERSION, "0.1.7")
        self.assertEqual(check_release_metadata.DOTNET_ASPNETCORE_VERSION, "0.1.2")
        self.assertEqual(check_release_metadata.DOTNET_HTTPCLIENT_VERSION, "0.1.2")
        self.assertEqual(check_release_metadata.JAVA_MAVEN_VERSION, "0.1.6")
        self.assertEqual(check_release_metadata.MAVEN_VERSION, "0.2.2")
        self.assertEqual(
            {
                value["name"]: value["version"]
                for value in check_release_metadata.PYTHON_PACKAGES.values()
            },
            {
                "logbrew-sdk": "0.1.12",
                "logbrew-fastapi": "0.1.10",
                "logbrew-flask": "0.1.5",
                "logbrew-django": "0.1.6",
            },
        )

    def test_tag_distributed_receipts_match_published_release(self) -> None:
        go_smoke = source_text("scripts/real_user_go_public_module_smoke.sh")
        go_gin_smoke = source_text("scripts/real_user_go_gin_smoke.sh")
        swift_smoke = source_text("scripts/real_user_swiftpm_public_smoke.sh")
        swift_readme = source_text("swift/logbrew-swift/README.md")

        self.assertIn('LOGBREW_GO_MODULE_VERSION:-v0.1.7', go_smoke)
        self.assertIn('LOGBREW_GO_GIN_MODULE_VERSION:-v0.1.2', go_smoke)
        self.assertIn('github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.2', go_gin_smoke)
        self.assertIn('LOGBREW_SWIFTPM_VERSION:-0.1.12', swift_smoke)
        self.assertIn('from: "0.1.12"', swift_readme)

    def test_public_receipt_defaults_match_current_registry_baselines(self) -> None:
        receipt_defaults = {
            "scripts/real_user_npm_public_registry_smoke.sh": (
                "LOGBREW_NPM_SDK_VERSION:-0.1.12",
                "LOGBREW_NPM_BROWSER_VERSION:-0.1.3",
                "LOGBREW_NPM_NODE_VERSION:-0.1.8",
                "LOGBREW_NPM_NEXT_VERSION:-0.1.5",
                "LOGBREW_NPM_REACT_VERSION:-0.1.1",
                "LOGBREW_NPM_REACT_NATIVE_VERSION:-0.1.17",
            ),
            "scripts/real_user_cratesio_public_smoke.sh": ("LOGBREW_CRATESIO_VERSION:-0.1.4",),
            "scripts/real_user_rubygems_public_smoke.sh": ("LOGBREW_RUBYGEMS_VERSION:-0.1.12",),
            "scripts/real_user_packagist_public_smoke.sh": ("LOGBREW_PACKAGIST_VERSION:-0.1.10",),
            "scripts/real_user_maven_central_public_smoke.sh": (
                "LOGBREW_MAVEN_JAVA_VERSION:-0.1.6",
                "LOGBREW_MAVEN_KOTLIN_VERSION:-0.2.2",
            ),
            "scripts/real_user_dotnet_public_nuget_smoke.sh": (
                "LOGBREW_DOTNET_CORE_VERSION:-0.1.7",
                "LOGBREW_DOTNET_HTTPCLIENT_VERSION:-0.1.2",
            ),
            "scripts/real_user_python_public_pypi_smoke.sh": (
                "LOGBREW_PYPI_SDK_VERSION:-0.1.12",
                "LOGBREW_PYPI_FASTAPI_VERSION:-0.1.10",
                "LOGBREW_PYPI_FLASK_VERSION:-0.1.5",
                "LOGBREW_PYPI_DJANGO_VERSION:-0.1.6",
            ),
        }
        for relative_path, expected_values in receipt_defaults.items():
            body = source_text(relative_path)
            for expected in expected_values:
                self.assertIn(expected, body, relative_path)

    def test_local_npm_smokes_bind_assertions_to_package_manifests(self) -> None:
        smoke_contracts = (
            ("browser", "browser", "browser_package_version", 2),
            ("react", "browser", "browser_package_version", 1),
            ("react", "react", "react_package_version", 2),
            ("next", "next", "next_package_version", 2),
            ("react_native", "react-native", "react_native_package_version", 2),
        )
        stale_version = re.compile(r"@logbrew/(?:browser|next|react|react-native)@\d")

        for script_slug, package_slug, variable, assertions in smoke_contracts:
            script_path = f"scripts/real_user_{script_slug}_smoke.sh"
            manifest_path = f"js/logbrew-{package_slug}/package.json"
            with self.subTest(script=script_path):
                manifest = json.loads(source_text(manifest_path))
                body = source_text(script_path)

                package_name = manifest["name"]
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

    def test_next_instrumentation_type_smoke_installs_framework_types(self) -> None:
        smoke = source_text("scripts/real_user_next_smoke.sh")

        self.assertIn("@types/react", smoke)
        self.assertIn("@types/react-dom", smoke)
        self.assertIn("cat > instrumentation-consumer.ts", smoke)
        self.assertIn("--lib ESNext,DOM,DOM.Iterable", smoke)
        self.assertIn("--skipLibCheck true", smoke)
        self.assertIn("Instrumentation.onRequestError", smoke)

    def test_repo_wide_guard_includes_newly_publishable_flask_and_httpclient(self) -> None:
        labels = {
            manifest.label
            for manifest in check_repo_wide_release_versions.REPO_WIDE_RELEASE_MANIFESTS
        }
        self.assertIn("logbrew-flask", labels)
        self.assertIn("LogBrew.HttpClient", labels)


if __name__ == "__main__":
    unittest.main()
