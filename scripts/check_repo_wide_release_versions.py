#!/usr/bin/env python3
"""Guard repo-wide GitHub Releases from publishing mixed package versions."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


SEMVER_TAG_RE = re.compile(
    r"^(?:refs/tags/)?v(?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$"
)


@dataclass(frozen=True)
class PackageManifest:
    ecosystem: str
    label: str
    path: str
    kind: str


REPO_WIDE_RELEASE_MANIFESTS = (
    PackageManifest("npm", "@logbrew/sdk", "js/logbrew-js/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/browser", "js/logbrew-browser/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/node", "js/logbrew-node/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/express", "js/logbrew-express/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/fastify", "js/logbrew-fastify/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/nestjs", "js/logbrew-nestjs/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/angular", "js/logbrew-angular/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/vue", "js/logbrew-vue/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/svelte", "js/logbrew-svelte/package.json", "json-version"),
    PackageManifest("npm", "@logbrew/react", "js/logbrew-react/package.json", "json-version"),
    PackageManifest(
        "npm",
        "@logbrew/react-native",
        "js/logbrew-react-native/package.json",
        "json-version",
    ),
    PackageManifest("npm", "@logbrew/next", "js/logbrew-next/package.json", "json-version"),
    PackageManifest("pypi", "logbrew-sdk", "python/logbrew_py/pyproject.toml", "pyproject-version"),
    PackageManifest(
        "pypi",
        "logbrew-fastapi",
        "python/logbrew_fastapi/pyproject.toml",
        "pyproject-version",
    ),
    PackageManifest(
        "pypi",
        "logbrew-django",
        "python/logbrew_django/pyproject.toml",
        "pyproject-version",
    ),
    PackageManifest("crates", "logbrew", "rust/logbrew/Cargo.toml", "cargo-version"),
    PackageManifest("rubygems", "logbrew-sdk", "ruby/logbrew-ruby/logbrew-sdk.gemspec", "gemspec-version"),
    PackageManifest(
        "nuget",
        "LogBrew",
        "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
        "xml-version",
    ),
    PackageManifest("maven", "co.logbrew:logbrew-sdk", "java/logbrew-java/pom.xml", "maven-version"),
    PackageManifest("maven", "co.logbrew:logbrew-kotlin", "kotlin/logbrew-kotlin/pom.xml", "maven-version"),
)


@dataclass(frozen=True)
class VersionResult:
    manifest: PackageManifest
    version: str


def release_version(ref: str) -> str:
    match = SEMVER_TAG_RE.match(ref)
    if not match:
        raise ValueError(f"expected repo-wide release tag like v0.1.1, got {ref!r}")
    return match.group("version")


def read_version(root: Path, manifest: PackageManifest) -> str:
    path = root / manifest.path
    if manifest.kind == "json-version":
        value = json.loads(path.read_text(encoding="utf-8")).get("version")
    elif manifest.kind == "pyproject-version":
        value = tomllib.loads(path.read_text(encoding="utf-8")).get("project", {}).get("version")
    elif manifest.kind == "cargo-version":
        value = tomllib.loads(path.read_text(encoding="utf-8")).get("package", {}).get("version")
    elif manifest.kind == "gemspec-version":
        match = re.search(r"^\s*spec\.version\s*=\s*[\"']([^\"']+)[\"']", path.read_text(encoding="utf-8"), re.M)
        value = match.group(1) if match else None
    elif manifest.kind == "xml-version":
        value = ET.parse(path).getroot().findtext("./PropertyGroup/Version")
    elif manifest.kind == "maven-version":
        namespace = {"m": "http://maven.apache.org/POM/4.0.0"}
        value = ET.parse(path).getroot().findtext("m:version", namespaces=namespace)
    else:
        raise ValueError(f"unknown manifest kind: {manifest.kind}")
    if not isinstance(value, str) or not value:
        raise ValueError(f"{manifest.path}: could not read package version")
    return value


def collect_versions(root: Path) -> list[VersionResult]:
    return [
        VersionResult(manifest=manifest, version=read_version(root, manifest))
        for manifest in REPO_WIDE_RELEASE_MANIFESTS
    ]


def mismatches(root: Path, expected_version: str) -> list[VersionResult]:
    return [
        result
        for result in collect_versions(root)
        if result.version != expected_version
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail when a repo-wide release tag does not match all package manifest versions."
    )
    parser.add_argument("tag", help="Repo-wide GitHub Release tag, for example v0.1.1")
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args(argv)

    try:
        expected_version = release_version(args.tag)
        failures = mismatches(args.root, expected_version)
    except Exception as exc:
        print(f"repo-wide release version check failed: {exc}", file=sys.stderr)
        return 1

    if failures:
        print(
            f"repo-wide release tag {args.tag} expects every publishable package to be {expected_version}, "
            "but these manifests differ:",
            file=sys.stderr,
        )
        for result in failures:
            manifest = result.manifest
            print(
                f"- {manifest.ecosystem} {manifest.label}: {result.version} ({manifest.path})",
                file=sys.stderr,
            )
        print(
            "Use scoped/manual changed-package publishing, or bump every listed package before creating "
            f"the repo-wide {args.tag} GitHub Release.",
            file=sys.stderr,
        )
        return 1

    print(f"repo-wide release package versions ok for {args.tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
