from __future__ import annotations

import base64
import gzip
import hashlib
import importlib.util
import json
import stat
import sys
import tempfile
import unittest
import zipfile
from email.message import Message
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_nuget_public_artifacts.py"
MODULE_SPEC = importlib.util.spec_from_file_location(
    "check_nuget_public_artifacts",
    SCRIPT,
)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
check_nuget_public_artifacts = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = check_nuget_public_artifacts
MODULE_SPEC.loader.exec_module(check_nuget_public_artifacts)

SOURCE_SHA = "a" * 40
VERSIONS = {
    "LogBrew": "0.1.5",
    "LogBrew.HttpClient": "0.1.0",
}
DEPENDENCY_RANGE = "[0.1.5, 0.2.0)"


class FakeResponse:
    def __init__(
        self,
        body: bytes,
        url: str,
        *,
        final_url: str | None = None,
        headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self.body = body
        self.url = url
        self.final_url = final_url or url
        self.headers = Message()
        for name, value in headers:
            self.headers.add_header(name, value)
        self.offset = 0

    def __enter__(self) -> FakeResponse:
        self.offset = 0
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, amount: int) -> bytes:
        chunk = self.body[self.offset : self.offset + amount]
        self.offset += len(chunk)
        return chunk

    def getcode(self) -> int:
        return 200

    def geturl(self) -> str:
        return self.final_url


class FakeRegistry:
    def __init__(self) -> None:
        self.responses: dict[str, FakeResponse] = {}

    def add(
        self,
        url: str,
        body: bytes,
        *,
        final_url: str | None = None,
        headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self.responses[url] = FakeResponse(
            body,
            url,
            final_url=final_url,
            headers=headers,
        )

    def open(self, request: Any, *, timeout: int) -> FakeResponse:
        del timeout
        return self.responses[request.full_url]


class NuGetPublicArtifactTests(unittest.TestCase):
    def test_accepts_single_gzip_registration_and_catalog_documents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = self.registry()
            for package_id, version in VERSIONS.items():
                metadata_url, _ = self.urls(package_id, version)
                self.gzip_response(registry, metadata_url)
                self.gzip_response(registry, self.catalog_url(package_id))

            check_nuget_public_artifacts.resolve_public_artifacts(
                VERSIONS,
                SOURCE_SHA,
                DEPENDENCY_RANGE,
                ROOT,
                root / "packages",
                root / "reconciliation.json",
                opener=registry.open,
            )

            self.assertTrue((root / "reconciliation.json").is_file())

    def test_rejects_unsafe_content_encoding_without_outputs(self) -> None:
        cases = (
            "unknown",
            "multiple",
            "combined",
            "trailing",
            "concatenated",
            "truncated",
            "crc",
            "decompressed-limit",
            "compressed-limit",
            "encoded-package",
        )
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                registry = self.registry()
                metadata_url, package_url = self.urls("LogBrew", VERSIONS["LogBrew"])
                response = registry.responses[metadata_url]
                document = response.body
                encoded = gzip.compress(document, mtime=0)
                headers = (("Content-Encoding", "gzip"),)
                if case == "unknown":
                    headers = (("Content-Encoding", "br"),)
                    encoded = document
                elif case == "multiple":
                    headers = (
                        ("Content-Encoding", "gzip"),
                        ("Content-Encoding", "identity"),
                    )
                elif case == "combined":
                    headers = (("Content-Encoding", "gzip, identity"),)
                elif case == "trailing":
                    encoded += b"trailing"
                elif case == "concatenated":
                    encoded += gzip.compress(document, mtime=0)
                elif case == "truncated":
                    encoded = encoded[:-8]
                elif case == "crc":
                    encoded = encoded[:-8] + bytes([encoded[-8] ^ 1]) + encoded[-7:]
                elif case == "decompressed-limit":
                    encoded = gzip.compress(
                        b"x" * (check_nuget_public_artifacts.MAX_METADATA_BYTES + 1),
                        mtime=0,
                    )
                elif case == "compressed-limit":
                    encoded = b"x" * (
                        check_nuget_public_artifacts.MAX_METADATA_COMPRESSED_BYTES + 1
                    )
                elif case == "encoded-package":
                    package = registry.responses[package_url]
                    registry.add(
                        package_url,
                        package.body,
                        headers=(("Content-Encoding", "gzip"),),
                    )
                    encoded = document
                    headers = ()
                registry.add(metadata_url, encoded, headers=headers)
                output = root / "packages"
                manifest = root / "reconciliation.json"

                with self.assertRaisesRegex(
                    ValueError,
                    "NuGet public artifact verification failed",
                ):
                    check_nuget_public_artifacts.resolve_public_artifacts(
                        VERSIONS,
                        SOURCE_SHA,
                        DEPENDENCY_RANGE,
                        ROOT,
                        output,
                        manifest,
                        opener=registry.open,
                    )

                self.assertFalse(output.exists())
                self.assertFalse(manifest.exists())

    def test_resolves_exact_registry_bytes_source_and_dependency_range(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = self.registry()
            output = root / "packages"
            manifest = root / "reconciliation.json"

            check_nuget_public_artifacts.resolve_public_artifacts(
                VERSIONS,
                SOURCE_SHA,
                DEPENDENCY_RANGE,
                ROOT,
                output,
                manifest,
                opener=registry.open,
            )

            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(payload["sourceCommit"], SOURCE_SHA)
            self.assertEqual(
                [entry["id"] for entry in payload["packages"]],
                ["LogBrew", "LogBrew.HttpClient"],
            )
            for package_id, version in VERSIONS.items():
                path = output / f"{package_id}.{version}.nupkg"
                record = next(
                    entry for entry in payload["packages"] if entry["id"] == package_id
                )
                self.assertEqual(
                    record["sha256"],
                    hashlib.sha256(path.read_bytes()).hexdigest(),
                )
                self.assertEqual(
                    record["registrySha512"],
                    base64.b64encode(
                        hashlib.sha512(path.read_bytes()).digest()
                    ).decode(),
                )

    def test_rejects_hash_redirect_source_dependency_and_malformed_metadata(
        self,
    ) -> None:
        for case in (
            "hash",
            "redirect",
            "source",
            "dependency",
            "metadata",
            "catalog-host",
            "catalog-path",
            "catalog-redirect",
            "catalog-malformed",
            "catalog-extra-dependency",
            "catalog-framework",
            "nuspec-extra-dependency",
            "nuspec-framework",
        ):
            with self.subTest(case=case):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    registry = self.registry(
                        source_commit=("b" * 40 if case == "source" else SOURCE_SHA),
                        dependency_range=(
                            "[0.1.4, 0.2.0)"
                            if case == "dependency"
                            else DEPENDENCY_RANGE
                        ),
                    )
                    package_id = "LogBrew.HttpClient"
                    version = VERSIONS[package_id]
                    metadata_url, package_url = self.urls(package_id, version)
                    catalog_url = self.catalog_url(package_id)
                    if case == "hash":
                        catalog = json.loads(registry.responses[catalog_url].body)
                        catalog["packageHash"] = base64.b64encode(b"x" * 64).decode()
                        registry.add(catalog_url, json.dumps(catalog).encode())
                    elif case == "redirect":
                        response = registry.responses[package_url]
                        registry.add(
                            package_url,
                            response.body,
                            final_url=package_url + "?redirected=true",
                        )
                    elif case == "metadata":
                        registry.add(metadata_url, b"{")
                    elif case in {"catalog-host", "catalog-path"}:
                        metadata = json.loads(registry.responses[metadata_url].body)
                        metadata["catalogEntry"] = (
                            "https://example.invalid/v3/catalog0/data/2026.07.24/"
                            "11111111-1111-1111-1111-111111111111.json"
                            if case == "catalog-host"
                            else "https://api.nuget.org/v3/catalog0/data/../entry.json"
                        )
                        registry.add(metadata_url, json.dumps(metadata).encode())
                    elif case == "catalog-redirect":
                        response = registry.responses[catalog_url]
                        registry.add(
                            catalog_url,
                            response.body,
                            final_url=catalog_url + "?redirected=true",
                        )
                    elif case == "catalog-malformed":
                        registry.add(catalog_url, b"{")
                    elif case == "catalog-extra-dependency":
                        catalog = json.loads(registry.responses[catalog_url].body)
                        catalog["dependencyGroups"][0]["dependencies"].append(
                            {"id": "Unexpected.Package", "range": "1.0.0"}
                        )
                        registry.add(catalog_url, json.dumps(catalog).encode())
                    elif case == "catalog-framework":
                        catalog = json.loads(registry.responses[catalog_url].body)
                        catalog["dependencyGroups"][0]["targetFramework"] = "net9.0"
                        registry.add(catalog_url, json.dumps(catalog).encode())
                    elif case in {"nuspec-extra-dependency", "nuspec-framework"}:
                        body = self.package(
                            package_id,
                            version,
                            SOURCE_SHA,
                            DEPENDENCY_RANGE,
                            extra_dependency=case == "nuspec-extra-dependency",
                            wrong_framework=case == "nuspec-framework",
                        )
                        registry.add(package_url, body)
                        catalog = json.loads(registry.responses[catalog_url].body)
                        catalog["packageHash"] = base64.b64encode(
                            hashlib.sha512(body).digest()
                        ).decode()
                        registry.add(catalog_url, json.dumps(catalog).encode())

                    with self.assertRaisesRegex(
                        ValueError,
                        "NuGet public artifact verification failed",
                    ):
                        check_nuget_public_artifacts.resolve_public_artifacts(
                            VERSIONS,
                            SOURCE_SHA,
                            DEPENDENCY_RANGE,
                            ROOT,
                            root / "packages",
                            root / "reconciliation.json",
                            opener=registry.open,
                        )

    def test_rejects_missing_extra_duplicate_and_unsafe_version_inputs(self) -> None:
        invalid = (
            ["LogBrew=0.1.5"],
            [
                "LogBrew=0.1.5",
                "LogBrew.HttpClient=0.1.0",
                "LogBrew.AspNetCore=0.1.4",
            ],
            [
                "LogBrew=0.1.5",
                "LogBrew=0.1.5",
                "LogBrew.HttpClient=0.1.0",
            ],
            ["LogBrew=../0.1.5", "LogBrew.HttpClient=0.1.0"],
        )
        for selection in invalid:
            with self.subTest(selection=selection):
                with self.assertRaisesRegex(
                    ValueError,
                    "invalid NuGet public package selection",
                ):
                    check_nuget_public_artifacts.parse_versions(selection)

    def test_rejects_compressed_archive_resource_exhaustion_without_outputs(
        self,
    ) -> None:
        for case in ("oversized", "too-many", "aggregate", "symlink"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                registry = self.registry()
                package_id = "LogBrew"
                version = VERSIONS[package_id]
                metadata_url, package_url = self.urls(package_id, version)
                del metadata_url
                catalog_url = self.catalog_url(package_id)
                body = self.hostile_package(case)
                registry.add(package_url, body)
                catalog = json.loads(registry.responses[catalog_url].body)
                catalog["packageHash"] = base64.b64encode(
                    hashlib.sha512(body).digest()
                ).decode()
                registry.add(catalog_url, json.dumps(catalog).encode())
                output = root / "packages"
                manifest = root / "manifest.json"

                with self.assertRaisesRegex(
                    ValueError,
                    "NuGet public artifact verification failed",
                ):
                    check_nuget_public_artifacts.resolve_public_artifacts(
                        VERSIONS,
                        SOURCE_SHA,
                        DEPENDENCY_RANGE,
                        ROOT,
                        output,
                        manifest,
                        opener=registry.open,
                    )

                self.assertFalse(output.exists())
                self.assertFalse(manifest.exists())

    def registry(
        self,
        *,
        source_commit: str = SOURCE_SHA,
        dependency_range: str = DEPENDENCY_RANGE,
    ) -> FakeRegistry:
        registry = FakeRegistry()
        for package_id, version in VERSIONS.items():
            dependencies = (
                [
                    {"id": "LogBrew", "range": dependency_range},
                    {
                        "id": "Microsoft.Extensions.Http",
                        "range": "[10.0.9, )",
                    },
                ]
                if package_id == "LogBrew.HttpClient"
                else [
                    {
                        "id": "Microsoft.Extensions.Logging",
                        "range": "[10.0.9, )",
                    }
                ]
            )
            body = self.package(
                package_id,
                version,
                source_commit,
                dependency_range,
            )
            metadata_url, package_url = self.urls(package_id, version)
            catalog_url = self.catalog_url(package_id)
            registry.add(package_url, body)
            registry.add(
                catalog_url,
                json.dumps(
                    {
                        "id": package_id,
                        "version": version,
                        "packageHashAlgorithm": "SHA512",
                        "packageHash": base64.b64encode(
                            hashlib.sha512(body).digest()
                        ).decode(),
                        "dependencyGroups": [
                            {
                                "targetFramework": framework,
                                "dependencies": dependencies,
                            }
                            for framework in ("netstandard2.0", "net8.0")
                        ],
                    }
                ).encode(),
            )
            registry.add(
                metadata_url,
                json.dumps(
                    {
                        "catalogEntry": catalog_url,
                        "packageContent": package_url,
                    }
                ).encode(),
            )
        return registry

    @staticmethod
    def gzip_response(registry: FakeRegistry, url: str) -> None:
        response = registry.responses[url]
        registry.add(
            url,
            gzip.compress(response.body, mtime=0),
            headers=(("Content-Encoding", "gzip"),),
        )

    @staticmethod
    def urls(package_id: str, version: str) -> tuple[str, str]:
        normalized = package_id.lower()
        package_root = f"https://api.nuget.org/v3-flatcontainer/{normalized}/{version}"
        metadata = (
            "https://api.nuget.org/v3/registration5-gz-semver2/"
            f"{normalized}/{version}.json"
        )
        return metadata, f"{package_root}/{normalized}.{version}.nupkg"

    @staticmethod
    def catalog_url(package_id: str) -> str:
        suffix = (
            "11111111-1111-1111-1111-111111111111"
            if package_id == "LogBrew"
            else "22222222-2222-2222-2222-222222222222"
        )
        return f"https://api.nuget.org/v3/catalog0/data/2026.07.24/{suffix}.json"

    @staticmethod
    def package(
        package_id: str,
        version: str,
        source_commit: str,
        dependency_range: str,
        *,
        extra_dependency: bool = False,
        wrong_framework: bool = False,
    ) -> bytes:
        dependencies = (
            [
                ("LogBrew", dependency_range),
                ("Microsoft.Extensions.Http", "10.0.9"),
            ]
            if package_id == "LogBrew.HttpClient"
            else [("Microsoft.Extensions.Logging", "10.0.9")]
        )
        if extra_dependency:
            dependencies.append(("Unexpected.Package", "1.0.0"))
        dependency_xml = "".join(
            f'<dependency id="{dependency_id}" version="{version}" />'
            for dependency_id, version in dependencies
        )
        groups = "".join(
            f'<group targetFramework="{framework}">{dependency_xml}</group>'
            for framework in (
                ("net9.0", "net8.0")
                if wrong_framework
                else ("netstandard2.0", "net8.0")
            )
        )
        dependency = f"<dependencies>{groups}</dependencies>"
        nuspec = f"""<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>{package_id}</id>
    <version>{version}</version>
    <repository type="git" url="https://github.com/LogBrewCo/sdk" commit="{source_commit}" />
    {dependency}
  </metadata>
</package>
"""
        output = __import__("io").BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr(f"{package_id}.nuspec", nuspec)
            archive.writestr(f"lib/net8.0/{package_id}.dll", b"dll")
            archive.writestr(f"lib/net8.0/{package_id}.xml", b"<doc />")
        return output.getvalue()

    @staticmethod
    def hostile_package(case: str) -> bytes:
        nuspec = f"""<?xml version="1.0"?>
<package>
  <metadata>
    <id>LogBrew</id>
    <version>0.1.5</version>
    <repository type="git" url="https://github.com/LogBrewCo/sdk" commit="{SOURCE_SHA}" />
  </metadata>
</package>
"""
        block = b"x" * (8 * 1024 * 1024)
        output = __import__("io").BytesIO()
        with zipfile.ZipFile(
            output,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as archive:
            archive.writestr("LogBrew.nuspec", nuspec)
            if case == "oversized":
                archive.writestr("lib/net8.0/large", block + b"x")
            elif case == "too-many":
                for index in range(1025):
                    archive.writestr(f"lib/net8.0/{index}", b"")
            elif case == "aggregate":
                for index in range(5):
                    archive.writestr(f"lib/net8.0/{index}", block)
            else:
                entry = zipfile.ZipInfo("lib/net8.0/link")
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, b"target")
        return output.getvalue()


if __name__ == "__main__":
    unittest.main()
