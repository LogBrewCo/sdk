from __future__ import annotations

import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_python_release_artifacts.py"
PACKAGES = (
    ("logbrew-sdk", "logbrew_py", "logbrew_sdk", "0.1.4"),
    ("logbrew-fastapi", "logbrew_fastapi", "logbrew_fastapi", "0.1.3"),
    ("logbrew-flask", "logbrew_flask", "logbrew_flask", "0.1.1"),
    ("logbrew-django", "logbrew_django", "logbrew_django", "0.1.3"),
)


class PythonReleaseArtifactTests(unittest.TestCase):
    def test_checker_binds_every_python_artifact_to_source_and_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_artifacts(directory)
            manifest = directory / "release-artifacts.json"

            result = self.run_create(directory, manifest)

            self.assertEqual(result.returncode, 0, result.stdout)
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(payload["sourceCommit"], "a" * 40)
            self.assertEqual(
                [package["id"] for package in payload["packages"]],
                [package[0] for package in PACKAGES],
            )
            flask = next(
                package for package in payload["packages"] if package["id"] == "logbrew-flask"
            )
            self.assertEqual(flask["version"], "0.1.1")
            self.assertRegex(flask["wheel"]["sha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(flask["sdist"]["sha256"], r"^[0-9a-f]{64}$")

    def test_checker_rejects_missing_or_unexpected_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_artifacts(directory)
            flask_wheel = directory / "logbrew_flask/logbrew_flask-0.1.1-py3-none-any.whl"
            flask_wheel.unlink()
            (directory / "logbrew_flask/unexpected.whl").write_bytes(b"unexpected")

            result = self.run_create(directory, directory / "manifest.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing", result.stdout)
            self.assertIn("unexpected", result.stdout)

    def test_checker_rejects_archive_metadata_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_artifacts(directory)
            self.write_wheel(
                directory / "logbrew_flask/logbrew_flask-0.1.1-py3-none-any.whl",
                "logbrew-flask",
                "9.9.9",
            )

            result = self.run_create(directory, directory / "manifest.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("metadata", result.stdout)

    def test_verify_rejects_artifact_bytes_changed_after_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.write_artifacts(directory)
            manifest = directory / "release-artifacts.json"
            created = self.run_create(directory, manifest)
            self.assertEqual(created.returncode, 0, created.stdout)
            flask_wheel = directory / "logbrew_flask/logbrew_flask-0.1.1-py3-none-any.whl"
            with flask_wheel.open("ab") as output:
                output.write(b"changed")

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "verify",
                    "--directory",
                    str(directory),
                    "--manifest",
                    str(manifest),
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("digest", result.stdout)

    def write_artifacts(self, directory: Path) -> None:
        for package_id, package_dir, normalized_name, version in PACKAGES:
            package_root = directory / package_dir
            package_root.mkdir(parents=True)
            self.write_wheel(
                package_root / f"{normalized_name}-{version}-py3-none-any.whl",
                package_id,
                version,
            )
            self.write_sdist(
                package_root / f"{normalized_name}-{version}.tar.gz",
                normalized_name,
                package_id,
                version,
            )

    @staticmethod
    def write_wheel(path: Path, package_id: str, version: str) -> None:
        dist_info = f"{package_id.replace('-', '_')}-{version}.dist-info"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                f"{dist_info}/METADATA",
                f"Metadata-Version: 2.4\nName: {package_id}\nVersion: {version}\n",
            )
            archive.writestr(f"{dist_info}/RECORD", "")

    @staticmethod
    def write_sdist(
        path: Path,
        normalized_name: str,
        package_id: str,
        version: str,
    ) -> None:
        payload = f"Metadata-Version: 2.4\nName: {package_id}\nVersion: {version}\n".encode()
        member = tarfile.TarInfo(f"{normalized_name}-{version}/PKG-INFO")
        member.size = len(payload)
        with tarfile.open(path, "w:gz") as archive:
            archive.addfile(member, io.BytesIO(payload))
            nested = tarfile.TarInfo(
                f"{normalized_name}-{version}/src/{normalized_name}.egg-info/PKG-INFO"
            )
            nested.size = len(payload)
            archive.addfile(nested, io.BytesIO(payload))

    @staticmethod
    def run_create(directory: Path, manifest: Path) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(SCRIPT),
            "create",
            "--directory",
            str(directory),
            "--source-commit",
            "a" * 40,
            "--manifest",
            str(manifest),
        ]
        for package_id, _, _, version in PACKAGES:
            command.extend(("--python-version", f"{package_id}={version}"))
        return subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )


if __name__ == "__main__":
    unittest.main()
