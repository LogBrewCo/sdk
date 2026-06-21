from __future__ import annotations

import importlib.util
import tempfile
import unittest
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


class ReleaseMetadataTests(unittest.TestCase):
    def test_repo_release_metadata_passes(self) -> None:
        self.assertEqual(check_release_metadata.validate(ROOT), [])

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

        self.assertTrue(any("NuGet exact public version verification" in failure for failure in failures))

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

        self.assertTrue(any("NuGet exact metadata version validation" in failure for failure in failures))

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
            examples_dir = package_dir / "examples"
            assets_dir = root / "assets" / "brand"
            project_dir.mkdir(parents=True)
            examples_dir.mkdir(parents=True)
            assets_dir.mkdir(parents=True)
            (package_dir / "README.md").write_text("# LogBrew .NET\n", encoding="utf-8")
            for example in (
                "FirstUsefulTelemetry.cs",
                "ActivityTraceCorrelation.cs",
                "HttpClientOutboundTelemetry.cs",
                "AspNetCoreRequestTelemetry.cs",
            ):
                (examples_dir / example).write_text("// example\n", encoding="utf-8")
            (assets_dir / "logbrew-logo-transparent-128.png").write_bytes(b"png")
            (project_dir / "LogBrew.csproj").write_text(
                """
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <PackageId>LogBrew</PackageId>
    <Version>0.1.2</Version>
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
    <None Include="../../examples/HttpClientOutboundTelemetry.cs" Pack="true" PackagePath="examples/" />
    <None Include="../../examples/AspNetCoreRequestTelemetry.cs" Pack="true" PackagePath="examples/" />
  </ItemGroup>
</Project>
""".strip()
                + "\n",
                encoding="utf-8",
            )

            default_failures: list[str] = []
            check_release_metadata.validate_dotnet(root, default_failures)
            override_failures: list[str] = []
            check_release_metadata.validate_dotnet(root, override_failures, expected_version="0.1.2")

        self.assertTrue(any("Version" in failure for failure in default_failures))
        self.assertEqual(override_failures, [])

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
