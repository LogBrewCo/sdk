from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_release_metadata.py"
SPEC = importlib.util.spec_from_file_location("check_release_metadata", MODULE_PATH)
assert SPEC is not None
check_release_metadata = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_release_metadata)

MINIMAL_PUBLISH_RELEASE_WORKFLOW = """
name: Publish Release
jobs:
  dispatch-publish:
    steps:
      - name: Check out release ref
        run: true
      - name: Resolve release publish inputs
        run: |
          if [[ "$RELEASE_TAG" == */* ]]; then
            publish_packages="false"
          elif [[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$ ]]; then
            release_kind="repo-wide"
          fi
      - name: Guard repo-wide release package versions
        run: python3 scripts/check_repo_wide_release_versions.py "$REF"
      - name: Dispatch publish-packages.yml
        if: ${{ steps.release.outputs.publish_packages == 'true' }}
        run: gh workflow run publish-packages.yml
      - name: Summarize release publish decision
        run: echo "Skipped package publishing for scoped GitHub Release"
""".strip()


def write_release_workflow_fixture(root: Path) -> Path:
    workflow_dir = root / ".github" / "workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "publish-release.yml").write_text(
        MINIMAL_PUBLISH_RELEASE_WORKFLOW + "\n",
        encoding="utf-8",
    )
    for relative in check_release_metadata.RELEASE_SAFETY_DOCS:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "release tag's commit historical tags check_repo_wide_release_versions.py\n",
            encoding="utf-8",
        )
    return workflow_dir


def minimal_publish_packages_workflow(package_dirs: list[str]) -> str:
    package_dir_lines = "\n".join(f"            {package_dir}" for package_dir in package_dirs)
    return (
        """
name: Publish Packages
on:
  workflow_dispatch:
    inputs:
      allow_initial_npm_publish:
        description: "Allow authenticated first publish for new npm package pages"
        required: true
        type: boolean
        default: false
jobs:
  npm:
    env:
      ALLOW_INITIAL_NPM_PUBLISH: ${{ inputs.allow_initial_npm_publish }}
    steps:
      - name: Publish npm packages
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          npm --version
          missing_npm_packages=()
          echo "npm trusted publishing requires existing package pages"
          echo "Use allow_initial_npm_publish only for one-time authenticated package creation"
          echo "allow_initial_npm_publish=true requires the release environment npm publish value"
          package_dirs=(
"""
        + package_dir_lines
        + """
          )
  nuget:
    steps:
      - name: Read NuGet package version
        id: nuget-version
        run: |
          echo "core_version=0.1.2" >> "$GITHUB_OUTPUT"
          echo "core_dependency_range=[0.1.2, 0.2.0)" >> "$GITHUB_OUTPUT"
          echo "core_dependency_range_msbuild=[0.1.2%2C0.2.0)" >> "$GITHUB_OUTPUT"
          echo "aspnetcore_version=0.1.0" >> "$GITHUB_OUTPUT"
          echo "efcore_version=0.1.0" >> "$GITHUB_OUTPUT"
          echo "httpclient_version=0.1.0" >> "$GITHUB_OUTPUT"
          echo "redis_version=0.1.0" >> "$GITHUB_OUTPUT"
          echo "otel_version=0.1.0" >> "$GITHUB_OUTPUT"
      - name: Validate NuGet metadata
        run: |
          python3 scripts/check_release_metadata.py \\
            --nuget-version "LogBrew=${{ steps.nuget-version.outputs.core_version }}" \\
            --nuget-version "LogBrew.AspNetCore=${{ steps.nuget-version.outputs.aspnetcore_version }}" \\
            --nuget-version "LogBrew.EntityFrameworkCore=${{ steps.nuget-version.outputs.efcore_version }}" \\
            --nuget-version "LogBrew.HttpClient=${{ steps.nuget-version.outputs.httpclient_version }}" \\
            --nuget-version "LogBrew.StackExchangeRedis=${{ steps.nuget-version.outputs.redis_version }}" \\
            --nuget-version "LogBrew.OpenTelemetry=${{ steps.nuget-version.outputs.otel_version }}"
      - name: Check NuGet version collision
        run: python3 scripts/check_registry_publication.py --target nuget --expect-absent
      - name: Pack NuGet package
        id: nuget-artifacts
        run: |
          source_commit="$(git rev-parse HEAD)"
          httpclient_pack_args=(--include-symbols -p:GenerateDocumentationFile=true -p:SymbolPackageFormat=snupkg -p:EnableSourceLink=true "-p:RepositoryCommit=$source_commit" "-p:LogBrewProjectReferenceVersion=${{ steps.nuget-version.outputs.core_dependency_range_msbuild }}")
          dotnet pack dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj --no-restore "${httpclient_pack_args[@]}"
          dotnet pack dotnet/logbrew-dotnet/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj
          dotnet pack dotnet/logbrew-dotnet/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj
          python3 scripts/check_dotnet_release_artifacts.py \\
            --source-commit "$(git rev-parse HEAD)" \\
            --nuget-version "LogBrew.HttpClient=${{ steps.nuget-version.outputs.httpclient_version }}" \\
            --dependency-range "LogBrew.HttpClient:LogBrew=${{ steps.nuget-version.outputs.core_dependency_range }}"
          echo "steps.nuget-artifacts.outputs.httpclient_content_sha256"
      - name: Publish NuGet package
        run: dotnet nuget push --symbol-source https://api.nuget.org/v3/index.json --skip-duplicate
      - name: Verify public NuGet package
        run: |
          python3 scripts/check_registry_publication.py --target nuget \\
            --nuget-version "LogBrew=${{ steps.nuget-version.outputs.core_version }}" \\
            --nuget-version "LogBrew.AspNetCore=${{ steps.nuget-version.outputs.aspnetcore_version }}" \\
            --nuget-version "LogBrew.EntityFrameworkCore=${{ steps.nuget-version.outputs.efcore_version }}" \\
            --nuget-version "LogBrew.HttpClient=${{ steps.nuget-version.outputs.httpclient_version }}" \\
            --nuget-version "LogBrew.StackExchangeRedis=${{ steps.nuget-version.outputs.redis_version }}" \\
            --nuget-version "LogBrew.OpenTelemetry=${{ steps.nuget-version.outputs.otel_version }}"
      - name: Verify public NuGet install
        run: |
          bash scripts/real_user_dotnet_public_nuget_smoke.sh \\
            "${{ steps.nuget-version.outputs.core_version }}" \\
            "${{ steps.nuget-version.outputs.aspnetcore_version }}" \\
            "${{ steps.nuget-version.outputs.efcore_version }}" \\
            "${{ steps.nuget-version.outputs.httpclient_version }}" \\
            "${{ steps.nuget-version.outputs.redis_version }}" \\
            "${{ steps.nuget-version.outputs.otel_version }}" \\
            "$(git rev-parse HEAD)" \\
            "${{ steps.nuget-artifacts.outputs.httpclient_content_sha256 }}"
      - name: Verify public HttpClient package compatibility
        run: bash scripts/real_user_dotnet_httpclient_package_compatibility_smoke.sh
  crates:
    steps:
      - name: Read Rust crate version
        id: crate-version
        run: echo "version=$(python3 scripts/read_rust_crate_version.py rust/logbrew/Cargo.toml)" >> "$GITHUB_OUTPUT"
      - name: Verify public crates.io package
        run: python3 scripts/check_registry_publication.py --target crates --version "${{ steps.crate-version.outputs.version }}"
  maven:
    steps:
      - name: Check Maven Central auth preflight
        if: ${{ ! inputs.dry_run }}
        env:
          CENTRAL_PORTAL_USERNAME: ${{ secrets.CENTRAL_PORTAL_USERNAME }}
          CENTRAL_PORTAL_PASSWORD: ${{ secrets.CENTRAL_PORTAL_PASSWORD }}
        run: bash scripts/check_maven_central_auth_preflight.sh
      - name: Build Maven Central deployment bundle
        run: bash scripts/build_maven_central_bundle.sh
      - name: Upload Maven Central deployment bundle
        run: echo "generated Central Portal publishing values"
      - name: Verify Maven Central publication
        run: python3 scripts/check_registry_publication.py --target maven --retries 20 --retry-delay 30
      - name: Verify public Maven Central install
        run: bash scripts/real_user_maven_central_public_smoke.sh
  verify:
    name: Public registry verification
    if: ${{ inputs.target == 'verify' }}
    steps:
      - name: Verify public registry packages
        run: |
          VERIFY_VERSION=0.1.0
          VERIFY_NPM_VERSIONS=""
          VERIFY_PYPI_VERSIONS=""
          VERIFY_NUGET_VERSIONS=""
          VERIFY_MAVEN_ARTIFACTS=""
          VERIFY_MAVEN_VERSIONS=""
          verify_args=(--target all)
          append_values() { :; }
          verify_args+=(--version "$VERIFY_VERSION")
          append_values --npm-version "$VERIFY_NPM_VERSIONS"
          append_values --pypi-version "$VERIFY_PYPI_VERSIONS"
          append_values --nuget-version "$VERIFY_NUGET_VERSIONS"
          append_values --maven-artifact "$VERIFY_MAVEN_ARTIFACTS"
          append_values --maven-version "$VERIFY_MAVEN_VERSIONS"
          if [[ -n "$VERIFY_MAVEN_ARTIFACTS" || -n "$VERIFY_MAVEN_VERSIONS" ]]; then
            verify_args+=(--include-maven)
          fi
          python3 scripts/check_registry_publication.py "${verify_args[@]}"
""".strip()
        + "\n"
    )


class ReleaseMetadataTests(unittest.TestCase):
    def test_repo_release_metadata_passes(self) -> None:
        self.assertEqual(check_release_metadata.validate(ROOT), [])

    def test_dotnet_release_catalog_covers_every_public_package_project(self) -> None:
        package_ids = {
            ET.parse(project).getroot().findtext("./PropertyGroup/PackageId")
            for project in (ROOT / "dotnet" / "logbrew-dotnet" / "src").glob("*/*.csproj")
        }

        self.assertNotIn(None, package_ids)
        self.assertEqual(package_ids, check_release_metadata.NUGET_PACKAGES)

    def test_publish_packages_workflow_includes_httpclient_release_contract(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "publish-packages.yml").read_text(encoding="utf-8")

        for expected in (
            "httpclient_version=",
            "steps.nuget-version.outputs.httpclient_version",
            "src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
            'LogBrew.HttpClient=${{ steps.nuget-version.outputs.httpclient_version }}',
            "python3 scripts/check_dotnet_release_artifacts.py",
            "-p:EnableSourceLink=true",
            "steps.nuget-artifacts.outputs.httpclient_content_sha256",
            "while IFS= read -r package_path",
            '"${{ steps.nuget-version.outputs.httpclient_version }}"',
            '"$(git rev-parse HEAD)"',
        ):
            self.assertIn(expected, workflow)

        httpclient_args = workflow.split("httpclient_pack_args=(", 1)[1].split(")", 1)[0]
        self.assertNotIn("NoWarn", httpclient_args)
        self.assertIn(
            'dotnet pack dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj --no-restore "${httpclient_pack_args[@]}"',
            workflow,
        )

    def test_publish_packages_rejects_nuget_collisions_before_pack(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "publish-packages.yml").read_text(encoding="utf-8")

        collision_check = workflow.index("Check NuGet version collision")
        pack = workflow.index("Pack NuGet package")

        self.assertLess(collision_check, pack)
        self.assertIn("--expect-absent", workflow[collision_check:pack])
        self.assertIn(
            'LogBrew.HttpClient=${{ steps.nuget-version.outputs.httpclient_version }}',
            workflow[collision_check:pack],
        )

    def test_publish_packages_runs_httpclient_compatibility_receipt(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "publish-packages.yml").read_text(encoding="utf-8")

        self.assertIn(
            "bash scripts/real_user_dotnet_httpclient_package_compatibility_smoke.sh",
            workflow,
        )

    def test_httpclient_dependency_range_uses_the_pack_contract_not_ignored_reference_metadata(self) -> None:
        project = (
            ROOT
            / "dotnet"
            / "logbrew-dotnet"
            / "src"
            / "LogBrew.HttpClient"
            / "LogBrew.HttpClient.csproj"
        ).read_text(encoding="utf-8")

        self.assertIn("<LogBrewCoreDependencyVersion>", project)
        self.assertIn('<ProjectReference Include="../LogBrew/LogBrew.csproj" />', project)
        self.assertNotIn('ProjectReference Include="../LogBrew/LogBrew.csproj" Version=', project)

    def test_rust_metadata_accepts_current_crate_release_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "rust" / "logbrew"
            package_dir.mkdir(parents=True)
            (package_dir / "Cargo.toml").write_text(
                """
[package]
name = "logbrew"
version = "0.1.1"
license = "MIT"
repository = "https://github.com/LogBrewCo/sdk"
readme = "README.md"
description = "Public LogBrew Rust SDK"
keywords = ["logbrew"]
""".strip()
                + "\n",
                encoding="utf-8",
            )
            (package_dir / "README.md").write_text(
                "Metrics MetricEvent client.metric low-cardinality OpenTelemetry Span Exporter opentelemetry-exporter\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_rust(root, failures)

        self.assertEqual(failures, [])

    def test_maven_metadata_requires_current_maven_release_version(self) -> None:
        pom_paths = (
            ROOT / "java" / "logbrew-java" / "pom.xml",
            ROOT / "kotlin" / "logbrew-kotlin" / "pom.xml",
            ROOT / "kotlin" / "logbrew-kotlin-okhttp" / "pom.xml",
        )

        for pom_path in pom_paths:
            self.assertIn(
                "<version>0.1.1</version>",
                pom_path.read_text(encoding="utf-8"),
                f"{pom_path.relative_to(ROOT)} must use the current Maven release version",
            )

    def test_maven_central_public_smoke_covers_kotlin_okhttp_artifact(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_maven_central_public_smoke.sh").read_text(encoding="utf-8")

        self.assertIn("logbrew-kotlin-okhttp", smoke)
        self.assertIn("LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION", smoke)
        self.assertIn("LogBrewOkHttpRouteTemplates", smoke)

    def test_swift_metadata_requires_root_swiftpm_package(self) -> None:
        manifest_path = ROOT / "Package.swift"

        self.assertTrue(manifest_path.exists(), "root Package.swift must support the documented SwiftPM URL install")

        manifest = manifest_path.read_text(encoding="utf-8")
        self.assertIn('name: "logbrew-swift"', manifest)
        self.assertIn('.library(name: "LogBrew", targets: ["LogBrew"])', manifest)
        self.assertIn('path: "swift/logbrew-swift/Sources/LogBrew"', manifest)
        self.assertIn('path: "swift/logbrew-swift/Tests/LogBrewTests"', manifest)

    def test_publish_packages_workflow_requires_exact_nuget_version_verification(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                """
name: Publish Packages
jobs:
  nuget:
    steps:
      - name: Verify public NuGet package
        run: python3 scripts/check_registry_publication.py --target nuget --retries 20 --retry-delay 30
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("NuGet LogBrew public version verification" in failure for failure in failures))

    def test_publish_packages_workflow_requires_exact_crates_version_verification(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                """
name: Publish Packages
on:
  workflow_dispatch:
    inputs:
      allow_initial_npm_publish:
        default: false
jobs:
  crates:
    steps:
      - name: Verify public crates.io package
        run: python3 scripts/check_registry_publication.py --target crates
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("crates.io exact public version verification" in failure for failure in failures))

    def test_publish_packages_workflow_requires_exact_nuget_metadata_version_validation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                """
name: Publish Packages
jobs:
  nuget:
    steps:
      - name: Read NuGet package version
        id: nuget-version
        run: echo "version=0.1.1" >> "$GITHUB_OUTPUT"
      - name: Verify public NuGet package
        run: python3 scripts/check_registry_publication.py --target nuget --nuget-version "LogBrew=${{ steps.nuget-version.outputs.version }}"
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("NuGet LogBrew metadata version validation" in failure for failure in failures))

    def test_publish_packages_workflow_requires_public_nuget_install_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            workflow = minimal_publish_packages_workflow(list(check_release_metadata.JS_PACKAGES))
            workflow = workflow.replace(
                "bash scripts/real_user_dotnet_public_nuget_smoke.sh",
                "bash scripts/removed_dotnet_public_nuget_smoke.sh",
            )
            (workflow_dir / "publish-packages.yml").write_text(
                workflow,
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("NuGet public install smoke" in failure for failure in failures))

    def test_publish_packages_workflow_requires_public_maven_install_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                """
name: Publish Packages
jobs:
  maven:
    steps:
      - name: Build Maven Central deployment bundle
        run: bash scripts/build_maven_central_bundle.sh
      - name: Verify Maven Central publication
        run: python3 scripts/check_registry_publication.py --target maven --retries 20 --retry-delay 30
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("Maven Central public install smoke" in failure for failure in failures))

    def test_publish_packages_workflow_requires_maven_generated_publishing_values_hint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            workflow = (ROOT / ".github" / "workflows" / "publish-packages.yml").read_text(encoding="utf-8")
            workflow = workflow.replace(
                "generated Central Portal publishing values",
                "Central Portal publishing values",
            )
            (workflow_dir / "publish-packages.yml").write_text(workflow, encoding="utf-8")

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("Maven Central generated publishing-values hint" in failure for failure in failures))

    def test_publish_packages_workflow_requires_maven_auth_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            workflow = (ROOT / ".github" / "workflows" / "publish-packages.yml").read_text(encoding="utf-8")
            workflow = workflow.replace(
                """
      - name: Check Maven Central auth preflight
        if: ${{ ! inputs.dry_run }}
        env:
          CENTRAL_PORTAL_USERNAME: ${{ secrets.CENTRAL_PORTAL_USERNAME }}
          CENTRAL_PORTAL_PASSWORD: ${{ secrets.CENTRAL_PORTAL_PASSWORD }}
        run: bash scripts/check_maven_central_auth_preflight.sh
""",
                "",
            )
            (workflow_dir / "publish-packages.yml").write_text(workflow, encoding="utf-8")

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("Maven Central auth preflight" in failure for failure in failures))

    def test_publish_packages_verify_target_requires_exact_version_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                """
name: Publish Packages
jobs:
  nuget:
    steps:
      - name: Read NuGet package version
        id: nuget-version
        run: echo "version=0.1.0" >> "$GITHUB_OUTPUT"
      - name: Verify public NuGet package
        run: python3 scripts/check_registry_publication.py --target nuget --nuget-version "LogBrew=${{ steps.nuget-version.outputs.version }}"
  verify:
    name: Public registry verification
    if: ${{ inputs.target == 'verify' }}
    steps:
      - name: Verify public registry packages
        run: python3 scripts/check_registry_publication.py --target all
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("verify target exact version input" in failure for failure in failures))
        self.assertTrue(any("verify target NuGet version override" in failure for failure in failures))
        self.assertTrue(any("verify target Maven artifact filter input" in failure for failure in failures))
        self.assertTrue(any("verify target Maven version override" in failure for failure in failures))

    def test_publish_packages_workflow_lists_every_js_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                minimal_publish_packages_workflow(["js/logbrew-js"]),
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("npm package dir js/logbrew-bullmq" in failure for failure in failures))

    def test_publish_packages_workflow_lists_every_python_package_for_pypi_extras(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            workflow = minimal_publish_packages_workflow(list(check_release_metadata.JS_PACKAGES))
            workflow += "\npython/logbrew_py python/logbrew_fastapi python/logbrew_django\n"
            (workflow_dir / "publish-packages.yml").write_text(workflow, encoding="utf-8")

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("PyPI package dir python/logbrew_flask" in failure for failure in failures))

    def test_trusted_publisher_docs_list_every_npm_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                minimal_publish_packages_workflow(list(check_release_metadata.JS_PACKAGES)),
                encoding="utf-8",
            )
            (root / ".github" / "publishing" / "trusted-publishers.md").write_text(
                """
# Trusted Publisher Setup

release tag's commit historical tags check_repo_wide_release_versions.py

## npm

- `@logbrew/sdk`
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("trusted publisher npm package @logbrew/bullmq" in failure for failure in failures))

    def test_publish_packages_workflow_requires_npm_first_publish_guard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            (workflow_dir / "publish-packages.yml").write_text(
                """
name: Publish Packages
jobs:
  npm:
    steps:
      - name: Publish npm packages
        run: |
          package_dirs=(
            js/logbrew-js
            js/logbrew-browser
            js/logbrew-node
            js/logbrew-bullmq
            js/logbrew-kafkajs
            js/logbrew-amqplib
            js/logbrew-aws-sqs
            js/logbrew-express
            js/logbrew-fastify
            js/logbrew-nestjs
            js/logbrew-angular
            js/logbrew-vue
            js/logbrew-svelte
            js/logbrew-react
            js/logbrew-react-native
            js/logbrew-next
          )
  nuget:
    steps:
      - name: Read NuGet package version
        id: nuget-version
        run: |
          echo "core_version=0.1.2" >> "$GITHUB_OUTPUT"
          echo "aspnetcore_version=0.1.0" >> "$GITHUB_OUTPUT"
      - name: Validate NuGet metadata
        run: |
          python3 scripts/check_release_metadata.py \\
            --nuget-version "LogBrew=${{ steps.nuget-version.outputs.core_version }}" \\
            --nuget-version "LogBrew.AspNetCore=${{ steps.nuget-version.outputs.aspnetcore_version }}"
      - name: Publish NuGet package
        run: dotnet nuget push --skip-duplicate
      - name: Verify public NuGet package
        run: |
          python3 scripts/check_registry_publication.py --target nuget \\
            --nuget-version "LogBrew=${{ steps.nuget-version.outputs.core_version }}" \\
            --nuget-version "LogBrew.AspNetCore=${{ steps.nuget-version.outputs.aspnetcore_version }}"
  verify:
    name: Public registry verification
    if: ${{ inputs.target == 'verify' }}
    steps:
      - name: Verify public registry packages
        run: |
          VERIFY_VERSION=0.1.0
          VERIFY_NPM_VERSIONS=""
          VERIFY_PYPI_VERSIONS=""
          VERIFY_NUGET_VERSIONS=""
          VERIFY_MAVEN_ARTIFACTS=""
          VERIFY_MAVEN_VERSIONS=""
          verify_args=(--target all)
          append_values() { :; }
          verify_args+=(--version "$VERIFY_VERSION")
          append_values --npm-version "$VERIFY_NPM_VERSIONS"
          append_values --pypi-version "$VERIFY_PYPI_VERSIONS"
          append_values --nuget-version "$VERIFY_NUGET_VERSIONS"
          append_values --maven-artifact "$VERIFY_MAVEN_ARTIFACTS"
          append_values --maven-version "$VERIFY_MAVEN_VERSIONS"
          if [[ -n "$VERIFY_MAVEN_ARTIFACTS" || -n "$VERIFY_MAVEN_VERSIONS" ]]; then
            verify_args+=(--include-maven)
          fi
          python3 scripts/check_registry_publication.py "${verify_args[@]}"
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("npm first-publish guard" in failure for failure in failures))

    def test_publish_packages_workflow_requires_npm_initial_publish_value_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = write_release_workflow_fixture(root)
            workflow = minimal_publish_packages_workflow(list(check_release_metadata.JS_PACKAGES))
            workflow = workflow.replace(
                'echo "allow_initial_npm_publish=true requires the release environment npm publish value"',
                'echo "missing explicit initial publish value failure"',
            )
            (workflow_dir / "publish-packages.yml").write_text(workflow, encoding="utf-8")

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("npm first-publish initial value failure" in failure for failure in failures))

    def test_publish_release_workflow_requires_scoped_release_skip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            workflow_dir.mkdir(parents=True)
            (workflow_dir / "publish-release.yml").write_text(
                """
name: Publish Release
on:
  release:
    types: [published]
jobs:
  dispatch-publish:
    runs-on: ubuntu-latest
    steps:
      - run: gh workflow run publish-packages.yml -f target=all -f dry_run=false
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_release_workflows(root, failures)

        self.assertTrue(any("scoped GitHub Release skip guard" in failure for failure in failures))
        self.assertTrue(any("publish dispatch output guard" in failure for failure in failures))

    def test_parse_npm_package_versions(self) -> None:
        self.assertEqual(
            check_release_metadata.parse_package_versions(["@logbrew/nestjs=0.1.1"]),
            {"@logbrew/nestjs": "0.1.1"},
        )

    def test_js_package_requires_commonjs_declarations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "js" / "logbrew-js"
            package_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew JS\n", encoding="utf-8")
            (package_dir / "package.json").write_text(
                """
{
  "name": "@logbrew/sdk",
  "version": "0.1.0",
  "description": "Public LogBrew JavaScript SDK.",
  "type": "module",
  "main": "./index.cjs",
  "module": "index.js",
  "types": "./index.d.ts",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/LogBrewCo/sdk.git"
  },
  "engines": {
    "node": ">=18"
  },
  "sideEffects": false,
  "files": ["README.md", "examples", "index.js", "index.cjs", "index.d.ts"],
  "exports": {
    ".": {
      "import": {
        "types": "./index.d.ts",
        "default": "./index.js"
      },
      "require": {
        "types": "./index.d.ts",
        "default": "./index.cjs"
      }
    }
  }
}
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_js_package(root, "js/logbrew-js", "@logbrew/sdk", failures)

        self.assertTrue(any("index.d.cts" in failure for failure in failures))
        self.assertTrue(any("exports['.'].require.types" in failure for failure in failures))

    def test_amqplib_package_peer_dependency_supports_common_zero_ten_line(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "js" / "logbrew-amqplib"
            package_dir.mkdir(parents=True)
            manifest = json.loads((ROOT / "js" / "logbrew-amqplib" / "package.json").read_text(encoding="utf-8"))
            manifest["peerDependencies"]["amqplib"] = ">=1"
            (package_dir / "package.json").write_text(json.dumps(manifest), encoding="utf-8")

            failures: list[str] = []
            check_release_metadata.validate_js_package(
                root,
                "js/logbrew-amqplib",
                "@logbrew/amqplib",
                failures,
            )

        self.assertTrue(
            any("peerDependencies.amqplib" in failure and ">=0.10" in failure for failure in failures),
            failures,
        )

    def test_js_package_accepts_expected_version_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "js" / "logbrew-nestjs"
            package_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew NestJS\n", encoding="utf-8")
            (package_dir / "package.json").write_text(
                """
{
  "name": "@logbrew/nestjs",
  "version": "0.1.1",
  "description": "NestJS interceptor helpers for the public LogBrew JavaScript SDK.",
  "type": "module",
  "main": "./index.cjs",
  "types": "./index.d.ts",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/LogBrewCo/sdk.git"
  },
  "engines": {
    "node": ">=18"
  },
  "sideEffects": false,
  "files": ["README.md", "examples", "index.js", "index.cjs", "index.d.ts", "index.d.cts"],
  "exports": {
    ".": {
      "import": {
        "types": "./index.d.ts",
        "default": "./index.js"
      },
      "require": {
        "types": "./index.d.cts",
        "default": "./index.cjs"
      }
    }
  }
}
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_js_package(
                root,
                "js/logbrew-nestjs",
                "@logbrew/nestjs",
                failures,
                expected_version="0.1.1",
            )

        self.assertEqual(failures, [])

    def test_dotnet_package_accepts_expected_version_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "dotnet" / "logbrew-dotnet"
            project_dir = package_dir / "src" / "LogBrew"
            aspnetcore_dir = package_dir / "src" / "LogBrew.AspNetCore"
            efcore_dir = package_dir / "src" / "LogBrew.EntityFrameworkCore"
            httpclient_dir = package_dir / "src" / "LogBrew.HttpClient"
            redis_dir = package_dir / "src" / "LogBrew.StackExchangeRedis"
            otel_dir = package_dir / "src" / "LogBrew.OpenTelemetry"
            examples_dir = package_dir / "examples"
            assets_dir = root / "assets" / "brand"
            project_dir.mkdir(parents=True)
            aspnetcore_dir.mkdir(parents=True)
            efcore_dir.mkdir(parents=True)
            httpclient_dir.mkdir(parents=True)
            redis_dir.mkdir(parents=True)
            otel_dir.mkdir(parents=True)
            examples_dir.mkdir(parents=True)
            assets_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew .NET\n", encoding="utf-8")
            (aspnetcore_dir / "README.md").write_text("# LogBrew ASP.NET Core\n", encoding="utf-8")
            (efcore_dir / "README.md").write_text("# LogBrew Entity Framework Core\n", encoding="utf-8")
            (httpclient_dir / "README.md").write_text("# LogBrew HttpClient\n", encoding="utf-8")
            (httpclient_dir / "examples").mkdir()
            (httpclient_dir / "examples" / "HttpClientFactoryCorrelation.cs").write_text(
                "// example\n",
                encoding="utf-8",
            )
            (redis_dir / "README.md").write_text("# LogBrew StackExchange.Redis\n", encoding="utf-8")
            (otel_dir / "README.md").write_text("# LogBrew OpenTelemetry\n", encoding="utf-8")
            for example in (
                "FirstUsefulTelemetry.cs",
                "ActivityTraceCorrelation.cs",
                "ActivitySourceListenerTelemetry.cs",
                "DependencySpansTelemetry.cs",
                "DbCommandTelemetry.cs",
                "HttpClientOutboundTelemetry.cs",
                "AspNetCoreRequestTelemetry.cs",
                "AspNetCoreMiddlewareTelemetry.cs",
                "EntityFrameworkCoreCommandTelemetry.cs",
                "StackExchangeRedisCommandTelemetry.cs",
                "OpenTelemetrySpanProcessorTelemetry.cs",
            ):
                (examples_dir / example).write_text("// example\n", encoding="utf-8")
            (assets_dir / "logbrew-logo-transparent-128.png").write_bytes(b"png")
            (assets_dir / "logbrew-logo-espresso-bg-128.png").write_bytes(b"png")
            (project_dir / "LogBrew.csproj").write_text(
                """
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks>
    <PackageId>LogBrew</PackageId>
    <Version>0.1.5</Version>
    <PackageVersion Condition="'$(LogBrewProjectReferenceVersion)' != ''">$(LogBrewProjectReferenceVersion)</PackageVersion>
    <Authors>LogBrew</Authors>
    <Company>LogBrew</Company>
    <Description>Public LogBrew .NET SDK.</Description>
    <PackageLicenseExpression>MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://github.com/LogBrewCo/sdk</PackageProjectUrl>
    <RepositoryUrl>https://github.com/LogBrewCo/sdk</RepositoryUrl>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <PackageIcon>logbrew-logo-transparent-128.png</PackageIcon>
  </PropertyGroup>
  <ItemGroup>
    <None Include="../../examples/FirstUsefulTelemetry.cs" Pack="true" PackagePath="examples/" />
    <None Include="../../examples/ActivityTraceCorrelation.cs" Pack="true" PackagePath="examples/" />
    <None Include="../../examples/ActivitySourceListenerTelemetry.cs" Pack="true" PackagePath="examples/" />
    <None Include="../../examples/DependencySpansTelemetry.cs" Pack="true" PackagePath="examples/" />
    <None Include="../../examples/DbCommandTelemetry.cs" Pack="true" PackagePath="examples/" />
    <None Include="../../examples/HttpClientOutboundTelemetry.cs" Pack="true" PackagePath="examples/" />
    <None Include="../../examples/AspNetCoreRequestTelemetry.cs" Pack="true" PackagePath="examples/" />
  </ItemGroup>
</Project>
""".strip()
                + "\n",
                encoding="utf-8",
            )
            (aspnetcore_dir / "LogBrew.AspNetCore.csproj").write_text(
                """
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PackageId>LogBrew.AspNetCore</PackageId>
    <Version>0.1.0</Version>
    <Authors>LogBrew</Authors>
    <Company>LogBrew</Company>
    <Description>Public LogBrew ASP.NET Core integration.</Description>
    <PackageLicenseExpression>MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://github.com/LogBrewCo/sdk</PackageProjectUrl>
    <RepositoryUrl>https://github.com/LogBrewCo/sdk</RepositoryUrl>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <PackageIcon>logbrew-logo-espresso-bg-128.png</PackageIcon>
  </PropertyGroup>
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
    <ProjectReference Include="../LogBrew/LogBrew.csproj" />
    <None Include="../../examples/AspNetCoreMiddlewareTelemetry.cs" Pack="true" PackagePath="examples/" />
  </ItemGroup>
</Project>
""".strip()
                + "\n",
                encoding="utf-8",
            )
            (efcore_dir / "LogBrew.EntityFrameworkCore.csproj").write_text(
                """
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PackageId>LogBrew.EntityFrameworkCore</PackageId>
    <Version>0.1.0</Version>
    <Authors>LogBrew</Authors>
    <Company>LogBrew</Company>
    <Description>Public LogBrew Entity Framework Core integration.</Description>
    <PackageLicenseExpression>MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://github.com/LogBrewCo/sdk</PackageProjectUrl>
    <RepositoryUrl>https://github.com/LogBrewCo/sdk</RepositoryUrl>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <PackageIcon>logbrew-logo-espresso-bg-128.png</PackageIcon>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../LogBrew/LogBrew.csproj" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.9" />
    <None Include="../../examples/EntityFrameworkCoreCommandTelemetry.cs" Pack="true" PackagePath="examples/" />
  </ItemGroup>
</Project>
""".strip()
                + "\n",
                encoding="utf-8",
            )
            (httpclient_dir / "LogBrew.HttpClient.csproj").write_text(
                """
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks>
    <IsAotCompatible>true</IsAotCompatible>
    <SignAssembly>false</SignAssembly>
    <LogBrewCoreDependencyVersion>[0.1.5, 0.2.0)</LogBrewCoreDependencyVersion>
    <PackageId>LogBrew.HttpClient</PackageId>
    <Version>0.1.0</Version>
    <Authors>LogBrew</Authors>
    <Company>LogBrew</Company>
    <Description>Public LogBrew HttpClient integration.</Description>
    <PackageLicenseExpression>MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://github.com/LogBrewCo/sdk</PackageProjectUrl>
    <RepositoryUrl>https://github.com/LogBrewCo/sdk</RepositoryUrl>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <PackageIcon>logbrew-logo-espresso-bg-128.png</PackageIcon>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../LogBrew/LogBrew.csproj" />
    <PackageReference Include="Microsoft.Extensions.Http" Version="10.0.9" />
    <None Include="examples/HttpClientFactoryCorrelation.cs" Pack="true" PackagePath="examples/" />
  </ItemGroup>
</Project>
""".strip()
                + "\n",
                encoding="utf-8",
            )
            (redis_dir / "LogBrew.StackExchangeRedis.csproj").write_text(
                """
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <PackageId>LogBrew.StackExchangeRedis</PackageId>
    <Version>0.1.0</Version>
    <Authors>LogBrew</Authors>
    <Company>LogBrew</Company>
    <Description>Public LogBrew StackExchange.Redis integration.</Description>
    <PackageLicenseExpression>MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://github.com/LogBrewCo/sdk</PackageProjectUrl>
    <RepositoryUrl>https://github.com/LogBrewCo/sdk</RepositoryUrl>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <PackageIcon>logbrew-logo-espresso-bg-128.png</PackageIcon>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../LogBrew/LogBrew.csproj" />
    <PackageReference Include="StackExchange.Redis" Version="3.0.11" />
    <None Include="../../examples/StackExchangeRedisCommandTelemetry.cs" Pack="true" PackagePath="examples/" />
  </ItemGroup>
</Project>
""".strip()
                + "\n",
                encoding="utf-8",
            )
            (otel_dir / "LogBrew.OpenTelemetry.csproj").write_text(
                """
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <PackageId>LogBrew.OpenTelemetry</PackageId>
    <Version>0.1.0</Version>
    <Authors>LogBrew</Authors>
    <Company>LogBrew</Company>
    <Description>Public LogBrew OpenTelemetry integration.</Description>
    <PackageLicenseExpression>MIT</PackageLicenseExpression>
    <PackageProjectUrl>https://github.com/LogBrewCo/sdk</PackageProjectUrl>
    <RepositoryUrl>https://github.com/LogBrewCo/sdk</RepositoryUrl>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <PackageIcon>logbrew-logo-espresso-bg-128.png</PackageIcon>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../LogBrew/LogBrew.csproj" />
    <PackageReference Include="OpenTelemetry" Version="1.16.0" />
    <None Include="../../examples/OpenTelemetrySpanProcessorTelemetry.cs" Pack="true" PackagePath="examples/" />
  </ItemGroup>
</Project>
""".strip()
                + "\n",
                encoding="utf-8",
            )

            default_failures: list[str] = []
            check_release_metadata.validate_dotnet_packages(
                root,
                default_failures,
                check_release_metadata.DOTNET_VERSION,
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_LICENSE,
                check_release_metadata.REPO_URL,
            )
            override_failures: list[str] = []
            check_release_metadata.validate_dotnet_packages(
                root,
                override_failures,
                "0.1.5",
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_VERSION,
                check_release_metadata.PUBLIC_LICENSE,
                check_release_metadata.REPO_URL,
            )

        self.assertTrue(any("Version" in failure for failure in default_failures))
        self.assertEqual(override_failures, [])

    def test_ruby_metadata_uses_rubygems_package_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "ruby" / "logbrew-ruby"
            package_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew Ruby\n", encoding="utf-8")
            (package_dir / "logbrew-sdk.gemspec").write_text(
                """
Gem::Specification.new do |spec|
  spec.name = "logbrew-sdk"
  spec.version = "0.1.1"
  spec.summary = "Public LogBrew Ruby SDK"
  spec.description = "Public LogBrew Ruby SDK for building, validating, and flushing event batches."
  spec.authors = ["LogBrew"]
  spec.license = "MIT"
  spec.required_ruby_version = ">= 2.6"
  spec.homepage = "https://github.com/LogBrewCo/sdk"
  spec.metadata = {
    "source_code_uri" => "https://github.com/LogBrewCo/sdk"
  }
  spec.files = Dir[
    "README.md",
    "lib/**/*.rb",
    "examples/**/*.rb",
    "examples/Makefile"
  ]
  spec.require_paths = ["lib"]
end
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_ruby(root, failures)

        self.assertEqual(failures, [])

    def test_maven_metadata_requires_license_url_developer_and_scm(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "java" / "logbrew-java"
            package_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew Java\n", encoding="utf-8")
            (package_dir / "pom.xml").write_text(
                """
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>co.logbrew</groupId>
  <artifactId>logbrew-sdk</artifactId>
  <version>0.1.0</version>
  <packaging>jar</packaging>
  <name>LogBrew Java SDK</name>
  <description>Public LogBrew Java SDK.</description>
  <url>https://github.com/LogBrewCo/sdk</url>
  <licenses>
    <license>
      <name>MIT</name>
    </license>
  </licenses>
  <properties>
    <maven.compiler.release>11</maven.compiler.release>
  </properties>
</project>
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_maven_pom(
                root,
                "java/logbrew-java/pom.xml",
                "logbrew-sdk",
                "LogBrew Java SDK",
                failures,
            )

        self.assertTrue(any("licenses.license.url" in failure for failure in failures))
        self.assertTrue(any("developers.developer.name" in failure for failure in failures))
        self.assertTrue(any("scm.url" in failure for failure in failures))

    def test_kotlin_maven_metadata_requires_stdlib_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "kotlin" / "logbrew-kotlin"
            package_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew Kotlin\n", encoding="utf-8")
            (package_dir / "pom.xml").write_text(
                """
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>co.logbrew</groupId>
  <artifactId>logbrew-kotlin</artifactId>
  <version>0.1.0</version>
  <packaging>jar</packaging>
  <name>LogBrew Kotlin SDK</name>
  <description>Public LogBrew Kotlin SDK.</description>
  <url>https://github.com/LogBrewCo/sdk</url>
  <licenses>
    <license>
      <name>MIT</name>
      <url>https://opensource.org/license/mit</url>
    </license>
  </licenses>
  <developers>
    <developer>
      <name>LogBrew</name>
    </developer>
  </developers>
  <scm>
    <url>https://github.com/LogBrewCo/sdk</url>
  </scm>
</project>
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_maven_pom(
                root,
                "kotlin/logbrew-kotlin/pom.xml",
                "logbrew-kotlin",
                "LogBrew Kotlin SDK",
                failures,
            )

        self.assertTrue(any("dependencies" in failure and "kotlin-stdlib" in failure for failure in failures))

    def test_python_integration_requires_declared_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "python" / "logbrew_fastapi"
            package_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew FastAPI\n", encoding="utf-8")
            package_src = package_dir / "src" / "logbrew_fastapi"
            examples_src = package_src / "examples"
            examples_src.mkdir(parents=True)
            (package_src / "py.typed").write_text("", encoding="utf-8")
            (examples_src / "__main__.py").write_text("", encoding="utf-8")
            (package_dir / "pyproject.toml").write_text(
                """
[project]
name = "logbrew-fastapi"
version = "0.1.0"
description = "FastAPI integration for LogBrew."
readme = "README.md"
license = "MIT"
requires-python = ">=3.11"
authors = [
  { name = "LogBrew" }
]
keywords = ["logbrew", "fastapi"]
dependencies = [
  "fastapi>=0.115",
  "logbrew-sdk==0.1.0"
]

[project.urls]
Repository = "https://github.com/LogBrewCo/sdk"
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_python_package(
                root,
                "python/logbrew_fastapi",
                check_release_metadata.PYTHON_PACKAGES["python/logbrew_fastapi"],
                failures,
            )

        self.assertTrue(any("project.dependencies" in failure and "httpx2" in failure for failure in failures))

    def test_django_integration_requires_framework_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_dir = root / "python" / "logbrew_django"
            package_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew Django\n", encoding="utf-8")
            package_src = package_dir / "src" / "logbrew_django"
            examples_src = package_src / "examples"
            examples_src.mkdir(parents=True)
            (package_src / "py.typed").write_text("", encoding="utf-8")
            (examples_src / "__main__.py").write_text("", encoding="utf-8")
            (package_dir / "pyproject.toml").write_text(
                """
[project]
name = "logbrew-django"
version = "0.1.0"
description = "Django integration for LogBrew."
readme = "README.md"
license = "MIT"
requires-python = ">=3.11"
authors = [
  { name = "LogBrew" }
]
keywords = ["logbrew", "django"]
dependencies = [
  "logbrew-sdk==0.1.0"
]

[project.urls]
Repository = "https://github.com/LogBrewCo/sdk"
""".strip()
                + "\n",
                encoding="utf-8",
            )

            failures: list[str] = []
            check_release_metadata.validate_python_package(
                root,
                "python/logbrew_django",
                check_release_metadata.PYTHON_PACKAGES["python/logbrew_django"],
                failures,
            )

        self.assertTrue(any("project.dependencies" in failure and "Django" in failure for failure in failures))


if __name__ == "__main__":
    unittest.main()
