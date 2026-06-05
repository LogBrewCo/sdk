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


class ReleaseMetadataTests(unittest.TestCase):
    def test_repo_release_metadata_passes(self) -> None:
        self.assertEqual(check_release_metadata.validate(ROOT), [])

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
    "url": "git+https://github.com/LogBrewCo/LogBrewCo-sdk.git"
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
  <url>https://github.com/LogBrewCo/LogBrewCo-sdk</url>
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
Repository = "https://github.com/LogBrewCo/LogBrewCo-sdk"
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
Repository = "https://github.com/LogBrewCo/LogBrewCo-sdk"
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
