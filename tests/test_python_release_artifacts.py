from __future__ import annotations

import io
import importlib.util
import hashlib
import json
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_python_release_artifacts.py"
MODULE_SPEC = importlib.util.spec_from_file_location(
    "check_python_release_artifacts",
    SCRIPT,
)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
check_python_release_artifacts = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = check_python_release_artifacts
MODULE_SPEC.loader.exec_module(check_python_release_artifacts)
PACKAGES = (
    ("logbrew-sdk", "logbrew_py", "logbrew_sdk", "0.1.4"),
    ("logbrew-fastapi", "logbrew_fastapi", "logbrew_fastapi", "0.1.3"),
    ("logbrew-flask", "logbrew_flask", "logbrew_flask", "0.1.1"),
    ("logbrew-django", "logbrew_django", "logbrew_django", "0.1.3"),
)


class FakeResponse:
    def __init__(self, body: bytes, url: str, *, final_url: str | None = None) -> None:
        self.body = body
        self.url = url
        self.final_url = final_url or url

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, amount: int) -> bytes:
        return self.body[:amount]

    def getcode(self) -> int:
        return 200

    def geturl(self) -> str:
        return self.final_url


class FakeRegistry:
    def __init__(self) -> None:
        self.responses: dict[str, FakeResponse | Exception] = {}
        self.requests: list[str] = []

    def add(self, url: str, body: bytes, *, final_url: str | None = None) -> None:
        self.responses[url] = FakeResponse(body, url, final_url=final_url)

    def missing(self, url: str) -> None:
        self.responses[url] = urllib.error.HTTPError(url, 404, "missing", {}, None)

    def open(self, request: Any, *, timeout: int) -> FakeResponse:
        del timeout
        url = request.full_url
        self.requests.append(url)
        response = self.responses[url]
        if isinstance(response, Exception):
            raise response
        return response


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

    def test_public_resolution_distinguishes_existing_and_new_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            built = root / "built"
            public_source = root / "public-source"
            built.mkdir()
            public_source.mkdir()
            self.write_artifacts(built)
            self.write_artifacts(public_source)
            self.change_container_bytes(public_source)
            manifest_path = root / "release-artifacts.json"
            build_manifest = self.create_manifest(built, manifest_path)
            registry = FakeRegistry()

            self.add_complete_metadata(
                registry,
                build_manifest,
                {
                    "logbrew-sdk": public_source,
                    "logbrew-fastapi": public_source,
                    "logbrew-flask": built,
                    "logbrew-django": built,
                },
            )

            output = root / "resolved"
            public_manifest_path = root / "public-release-artifacts.json"
            attestation_path = root / "public-reconciliation.json"
            check_python_release_artifacts.resolve_public_artifacts(
                manifest_path,
                built,
                output,
                public_manifest_path,
                attestation_path,
                opener=registry.open,
            )

            public_manifest = json.loads(
                public_manifest_path.read_text(encoding="utf-8")
            )
            attestation = json.loads(attestation_path.read_text(encoding="utf-8"))
            built_by_id = {entry["id"]: entry for entry in build_manifest["packages"]}
            public_by_id = {entry["id"]: entry for entry in public_manifest["packages"]}
            state_by_id = {entry["id"]: entry for entry in attestation["packages"]}
            for package_id in ("logbrew-sdk", "logbrew-fastapi"):
                self.assertNotEqual(
                    public_by_id[package_id]["wheel"]["sha256"],
                    built_by_id[package_id]["wheel"]["sha256"],
                )
                self.assertEqual(
                    state_by_id[package_id]["wheel"]["publicationState"],
                    "existing",
                )
            for package_id in ("logbrew-flask", "logbrew-django"):
                self.assertEqual(public_by_id[package_id], built_by_id[package_id])
                self.assertEqual(
                    state_by_id[package_id]["wheel"]["publicationState"],
                    "source-build",
                )
            check_python_release_artifacts.validate_manifest(output, public_manifest)

    def test_public_resolution_rejects_changed_existing_or_mismatched_new_bytes(
        self,
    ) -> None:
        for changed_package in ("logbrew-sdk", "logbrew-flask"):
            with self.subTest(changed_package=changed_package):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    built = root / "built"
                    existing = root / "existing"
                    changed = root / "changed"
                    for directory, marker in (
                        (built, b"built"),
                        (existing, b"existing"),
                        (changed, b"changed"),
                    ):
                        directory.mkdir()
                        self.write_artifacts(directory, marker=marker)
                    manifest_path = root / "release-artifacts.json"
                    manifest = self.create_manifest(built, manifest_path)
                    registry = FakeRegistry()
                    sources = {
                        "logbrew-sdk": existing,
                        "logbrew-fastapi": built,
                        "logbrew-flask": built,
                        "logbrew-django": built,
                    }
                    sources[changed_package] = changed
                    self.add_complete_metadata(registry, manifest, sources)

                    with self.assertRaisesRegex(
                        ValueError, "public artifact verification failed"
                    ):
                        check_python_release_artifacts.resolve_public_artifacts(
                            manifest_path,
                            built,
                            root / "resolved",
                            root / "public-release-artifacts.json",
                            root / "public-reconciliation.json",
                            opener=registry.open,
                        )

    def test_public_resolution_rejects_unsafe_metadata_and_downloads(self) -> None:
        cases = ("malformed", "extra", "path", "redirect", "bytes")
        for case in cases:
            with self.subTest(case=case):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    built = root / "built"
                    built.mkdir()
                    self.write_artifacts(built)
                    manifest_path = root / "release-artifacts.json"
                    manifest = self.create_manifest(built, manifest_path)
                    registry = FakeRegistry()
                    self.add_complete_metadata(
                        registry,
                        manifest,
                        {package[0]: built for package in PACKAGES},
                    )
                    first = manifest["packages"][0]
                    metadata_url = self.metadata_url(first)
                    metadata = json.loads(registry.responses[metadata_url].body)
                    injected = "do-not-reflect-this-value"
                    if case == "malformed":
                        registry.add(metadata_url, b"{")
                    elif case == "extra":
                        metadata["urls"].append(
                            self.metadata_entry("extra.whl", b"extra")
                        )
                        registry.add(metadata_url, json.dumps(metadata).encode())
                    else:
                        artifact = metadata["urls"][0]
                        original_url = artifact["url"]
                        if case == "path":
                            artifact["url"] = (
                                "https://files.pythonhosted.org/packages/../"
                                + artifact["filename"]
                            )
                            registry.add(metadata_url, json.dumps(metadata).encode())
                        elif case == "redirect":
                            registry.add(
                                original_url,
                                registry.responses[original_url].body,
                                final_url="https://files.pythonhosted.org/other",
                            )
                        else:
                            registry.add(original_url, injected.encode())

                    with self.assertRaises(ValueError) as failure:
                        check_python_release_artifacts.resolve_public_artifacts(
                            manifest_path,
                            built,
                            root / "resolved",
                            root / "public-release-artifacts.json",
                            root / "public-reconciliation.json",
                            opener=registry.open,
                        )
                    self.assertNotIn(injected, str(failure.exception))

    def test_archive_validation_rejects_bombs_and_special_entries(self) -> None:
        cases = (
            "oversized-wheel",
            "too-many-wheel",
            "aggregate-wheel",
            "symlink-wheel",
            "oversized-sdist",
            "aggregate-sdist",
            "pax-sdist",
            "special-sdist",
        )
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                if case.endswith("wheel"):
                    path = root / "logbrew_sdk-0.1.4-py3-none-any.whl"
                    self.write_hostile_wheel(path, case)
                    with self.assertRaises(ValueError):
                        check_python_release_artifacts.validate_wheel(
                            path,
                            "logbrew-sdk",
                            "0.1.4",
                        )
                    with self.assertRaisesRegex(
                        ValueError,
                        "public artifact verification failed",
                    ):
                        check_python_release_artifacts.canonical_archive_digest(
                            path,
                            "wheel",
                        )
                else:
                    path = root / "logbrew_sdk-0.1.4.tar.gz"
                    self.write_hostile_sdist(path, case)
                    with self.assertRaises(ValueError):
                        check_python_release_artifacts.validate_sdist(
                            path,
                            "logbrew-sdk",
                            "0.1.4",
                        )
                    with self.assertRaisesRegex(
                        ValueError,
                        "public artifact verification failed",
                    ):
                        check_python_release_artifacts.canonical_archive_digest(
                            path,
                            "sdist",
                        )

                self.assertEqual(list(root.glob("*.json")), [])

    def test_public_resolution_removes_outputs_for_compressed_bomb(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            built = root / "built"
            built.mkdir()
            self.write_artifacts(built)
            manifest_path = root / "release-artifacts.json"
            manifest = self.create_manifest(built, manifest_path)
            registry = FakeRegistry()
            self.add_complete_metadata(
                registry,
                manifest,
                {package[0]: built for package in PACKAGES},
            )
            first = manifest["packages"][0]
            metadata_url = self.metadata_url(first)
            metadata = json.loads(registry.responses[metadata_url].body)
            wheel = next(
                entry for entry in metadata["urls"] if entry["packagetype"] == "bdist_wheel"
            )
            hostile_path = root / "hostile.whl"
            self.write_hostile_wheel(hostile_path, "oversized-wheel")
            hostile = hostile_path.read_bytes()
            wheel["digests"]["sha256"] = hashlib.sha256(hostile).hexdigest()
            registry.add(wheel["url"], hostile)
            registry.add(metadata_url, json.dumps(metadata).encode())
            output = root / "resolved"
            public_manifest = root / "public-release-artifacts.json"
            reconciliation = root / "public-reconciliation.json"

            with self.assertRaisesRegex(
                ValueError,
                "public artifact verification failed",
            ):
                check_python_release_artifacts.resolve_public_artifacts(
                    manifest_path,
                    built,
                    output,
                    public_manifest,
                    reconciliation,
                    opener=registry.open,
                )

            self.assertFalse(output.exists())
            self.assertFalse(public_manifest.exists())
            self.assertFalse(reconciliation.exists())

    def write_artifacts(self, directory: Path, marker: bytes = b"") -> None:
        for package_id, package_dir, normalized_name, version in PACKAGES:
            package_root = directory / package_dir
            package_root.mkdir(parents=True)
            self.write_wheel(
                package_root / f"{normalized_name}-{version}-py3-none-any.whl",
                package_id,
                version,
                marker,
            )
            self.write_sdist(
                package_root / f"{normalized_name}-{version}.tar.gz",
                normalized_name,
                package_id,
                version,
                marker,
            )

    @staticmethod
    def write_wheel(
        path: Path,
        package_id: str,
        version: str,
        marker: bytes = b"",
    ) -> None:
        dist_info = f"{package_id.replace('-', '_')}-{version}.dist-info"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                f"{dist_info}/METADATA",
                f"Metadata-Version: 2.4\nName: {package_id}\nVersion: {version}\n",
            )
            archive.writestr(f"{dist_info}/RECORD", marker)

    @staticmethod
    def write_sdist(
        path: Path,
        normalized_name: str,
        package_id: str,
        version: str,
        marker: bytes = b"",
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
            if marker:
                extra = tarfile.TarInfo(
                    f"{normalized_name}-{version}/src/{normalized_name}/marker"
                )
                extra.size = len(marker)
                archive.addfile(extra, io.BytesIO(marker))

    @staticmethod
    def write_hostile_wheel(path: Path, case: str) -> None:
        metadata = (
            b"Metadata-Version: 2.4\nName: logbrew-sdk\nVersion: 0.1.4\n"
        )
        block = b"x" * (8 * 1024 * 1024)
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("logbrew_sdk-0.1.4.dist-info/METADATA", metadata)
            if case == "oversized-wheel":
                archive.writestr("logbrew_sdk/large", block + b"x")
            elif case == "too-many-wheel":
                for index in range(1025):
                    archive.writestr(f"logbrew_sdk/{index}", b"")
            elif case == "aggregate-wheel":
                for index in range(5):
                    archive.writestr(f"logbrew_sdk/{index}", block)
            else:
                entry = zipfile.ZipInfo("logbrew_sdk/link")
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, b"target")

    @staticmethod
    def write_hostile_sdist(path: Path, case: str) -> None:
        root = "logbrew_sdk-0.1.4"
        metadata = (
            b"Metadata-Version: 2.4\nName: logbrew-sdk\nVersion: 0.1.4\n"
        )
        pax_headers = (
            {"comment": "x" * (8 * 1024 * 1024 + 1)}
            if case == "pax-sdist"
            else None
        )
        with tarfile.open(
            path,
            "w:gz",
            format=tarfile.PAX_FORMAT,
            pax_headers=pax_headers,
        ) as archive:
            member = tarfile.TarInfo(f"{root}/PKG-INFO")
            member.size = len(metadata)
            archive.addfile(member, io.BytesIO(metadata))
            if case == "oversized-sdist":
                body = b"x" * (8 * 1024 * 1024 + 1)
                extra = tarfile.TarInfo(f"{root}/large")
                extra.size = len(body)
                archive.addfile(extra, io.BytesIO(body))
            elif case == "aggregate-sdist":
                body = b"x" * (8 * 1024 * 1024)
                for index in range(5):
                    extra = tarfile.TarInfo(f"{root}/{index}")
                    extra.size = len(body)
                    archive.addfile(extra, io.BytesIO(body))
            elif case == "special-sdist":
                special = tarfile.TarInfo(f"{root}/pipe")
                special.type = tarfile.FIFOTYPE
                archive.addfile(special)

    def create_manifest(self, directory: Path, path: Path) -> dict[str, Any]:
        result = self.run_create(directory, path)
        self.assertEqual(result.returncode, 0, result.stdout)
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def metadata_url(package: dict[str, Any]) -> str:
        return f"https://pypi.org/pypi/{package['id']}/{package['version']}/json"

    @staticmethod
    def metadata_entry(filename: str, body: bytes) -> dict[str, Any]:
        return {
            "filename": filename,
            "packagetype": "bdist_wheel" if filename.endswith(".whl") else "sdist",
            "digests": {"sha256": hashlib.sha256(body).hexdigest()},
            "url": f"https://files.pythonhosted.org/packages/{filename}",
        }

    def add_snapshot_metadata(
        self,
        registry: FakeRegistry,
        manifest: dict[str, Any],
        artifact_root: Path,
        *,
        existing: set[str],
    ) -> None:
        for package in manifest["packages"]:
            metadata_url = self.metadata_url(package)
            if package["id"] not in existing:
                registry.missing(metadata_url)
                continue
            self.add_package_metadata(registry, package, artifact_root)

    @staticmethod
    def change_container_bytes(directory: Path) -> None:
        for _, package_dir, normalized_name, version in PACKAGES:
            wheel = (
                directory
                / package_dir
                / f"{normalized_name}-{version}-py3-none-any.whl"
            )
            with zipfile.ZipFile(wheel, "a") as archive:
                archive.comment = b"public-container"
            sdist = directory / package_dir / f"{normalized_name}-{version}.tar.gz"
            body = bytearray(sdist.read_bytes())
            body[4:8] = (1).to_bytes(4, "little")
            sdist.write_bytes(body)

    def add_complete_metadata(
        self,
        registry: FakeRegistry,
        manifest: dict[str, Any],
        roots: dict[str, Path],
    ) -> None:
        for package in manifest["packages"]:
            self.add_package_metadata(registry, package, roots[package["id"]])

    def add_package_metadata(
        self,
        registry: FakeRegistry,
        package: dict[str, Any],
        artifact_root: Path,
    ) -> None:
        urls = []
        for kind in ("wheel", "sdist"):
            relative = package[kind]["file"]
            body = (artifact_root / relative).read_bytes()
            entry = self.metadata_entry(Path(relative).name, body)
            urls.append(entry)
            registry.add(entry["url"], body)
        registry.add(
            self.metadata_url(package),
            json.dumps(
                {
                    "info": {
                        "name": package["id"],
                        "version": package["version"],
                    },
                    "urls": urls,
                }
            ).encode(),
        )

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
