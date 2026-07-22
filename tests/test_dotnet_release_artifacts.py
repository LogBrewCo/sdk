from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_dotnet_release_artifacts.py"


class DotnetReleaseArtifactTests(unittest.TestCase):
    def test_release_artifact_checker_is_public_and_fail_closed(self) -> None:
        self.assertTrue(SCRIPT.is_file())
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "DOTNET_RELEASE_PACKAGES",
            "source_commit",
            "sha256",
            "nupkg",
            "snupkg",
            "unexpected",
            "missing",
        ):
            self.assertIn(expected, body)

    def test_checker_binds_httpclient_package_symbols_source_and_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(directory)
            manifest = directory / "manifest.json"

            result = self.run_checker(directory, manifest)

            self.assertEqual(result.returncode, 0, result.stdout)
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(payload["sourceCommit"], "a" * 40)
            self.assertEqual(payload["packages"][0]["id"], "LogBrew.HttpClient")
            self.assertEqual(payload["packages"][0]["version"], "0.1.0")
            self.assertRegex(payload["packages"][0]["nupkgSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(payload["packages"][0]["nupkgContentSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(payload["packages"][0]["snupkgSha256"], r"^[0-9a-f]{64}$")

    def test_checker_content_digest_ignores_only_repository_signature(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(directory)
            unsigned_manifest = directory / "unsigned.json"
            unsigned_result = self.run_checker(directory, unsigned_manifest)
            self.assertEqual(unsigned_result.returncode, 0, unsigned_result.stdout)
            unsigned = json.loads(unsigned_manifest.read_text(encoding="utf-8"))["packages"][0]

            package = directory / "LogBrew.HttpClient.0.1.0.nupkg"
            with zipfile.ZipFile(package, "a") as archive:
                archive.writestr(".signature.p7s", b"repository-signature")
            signed_manifest = directory / "signed.json"
            signed_result = self.run_checker(directory, signed_manifest)
            self.assertEqual(signed_result.returncode, 0, signed_result.stdout)
            signed = json.loads(signed_manifest.read_text(encoding="utf-8"))["packages"][0]

            self.assertNotEqual(unsigned["nupkgSha256"], signed["nupkgSha256"])
            self.assertEqual(unsigned["nupkgContentSha256"], signed["nupkgContentSha256"])

            with zipfile.ZipFile(package, "a") as archive:
                archive.writestr("content-change.txt", b"changed")
            changed_manifest = directory / "changed.json"
            changed_result = self.run_checker(directory, changed_manifest)
            self.assertEqual(changed_result.returncode, 0, changed_result.stdout)
            changed = json.loads(changed_manifest.read_text(encoding="utf-8"))["packages"][0]

            self.assertNotEqual(signed["nupkgContentSha256"], changed["nupkgContentSha256"])

    def test_checker_rejects_missing_symbol_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(directory)
            (directory / "LogBrew.HttpClient.0.1.0.snupkg").unlink()

            result = self.run_checker(directory, directory / "manifest.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing", result.stdout)

    def test_checker_rejects_symbols_without_source_link(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(directory, include_source_link=False)

            result = self.run_checker(directory, directory / "manifest.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Source Link", result.stdout)

    def test_checker_rejects_wrong_source_commit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(directory, source_commit="b" * 40)

            result = self.run_checker(directory, directory / "manifest.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("source commit", result.stdout)

    def test_checker_rejects_wrong_core_dependency_range(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(
                directory,
                core_dependency_range="[0.1.3, 0.2.0)",
            )

            result = self.run_checker(directory, directory / "manifest.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("dependency range", result.stdout)

    def test_checker_rejects_missing_core_dependency_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(directory)

            result = self.run_checker(
                directory,
                directory / "manifest.json",
                include_dependency_range=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing HttpClient core dependency range", result.stdout)

    def test_checker_rejects_non_git_repository_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_httpclient_artifacts(directory, repository_type="source")

            result = self.run_checker(directory, directory / "manifest.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("repository source", result.stdout)

    def test_checker_rejects_unsafe_version_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)

            result = self.run_checker(
                directory,
                directory / "manifest.json",
                package_version="../0.1.0",
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid NuGet package version", result.stdout)

    @staticmethod
    def write_httpclient_artifacts(
        directory: Path,
        source_commit: str = "a" * 40,
        include_source_link: bool = True,
        repository_type: str = "git",
        core_dependency_range: str = "[0.1.4, 0.2.0)",
    ) -> None:
        package = directory / "LogBrew.HttpClient.0.1.0.nupkg"
        symbols = directory / "LogBrew.HttpClient.0.1.0.snupkg"
        nuspec = f"""<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>LogBrew.HttpClient</id>
    <version>0.1.0</version>
    <repository type="{repository_type}" url="https://github.com/LogBrewCo/sdk" commit="{source_commit}" />
    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="LogBrew" version="{core_dependency_range}" />
      </group>
    </dependencies>
  </metadata>
</package>
"""
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("LogBrew.HttpClient.nuspec", nuspec)
            for framework in ("netstandard2.0", "net8.0"):
                archive.writestr(f"lib/{framework}/LogBrew.HttpClient.dll", b"dll")
                archive.writestr(f"lib/{framework}/LogBrew.HttpClient.xml", b"<doc />")
        with zipfile.ZipFile(symbols, "w") as archive:
            archive.writestr("LogBrew.HttpClient.nuspec", nuspec)
            for framework in ("netstandard2.0", "net8.0"):
                source_link = (
                    f"https://raw.githubusercontent.com/LogBrewCo/sdk/{source_commit}/*".encode()
                    if include_source_link
                    else b"pdb"
                )
                archive.writestr(f"lib/{framework}/LogBrew.HttpClient.pdb", source_link)

    @staticmethod
    def run_checker(
        directory: Path,
        manifest: Path,
        package_version: str = "0.1.0",
        include_dependency_range: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(SCRIPT),
            "--directory",
            str(directory),
            "--source-commit",
            "a" * 40,
            "--nuget-version",
            f"LogBrew.HttpClient={package_version}",
        ]
        if include_dependency_range:
            command.extend(
                (
                    "--dependency-range",
                    "LogBrew.HttpClient:LogBrew=[0.1.4, 0.2.0)",
                )
            )
        command.extend(("--manifest", str(manifest)))
        return subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )


if __name__ == "__main__":
    unittest.main()
