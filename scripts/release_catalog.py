"""Public package versions and identities from the release catalog."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parents[1] / "tools" / "toolchain-probe" / "release-catalog.toml"
CATALOG = tomllib.loads(CATALOG_PATH.read_text(encoding="utf-8"))

PUBLIC_VERSION: str = CATALOG["public_version"]
RUST_VERSION: str = CATALOG["rust"]
RUBYGEMS_VERSION: str = CATALOG["rubygems"]
PACKAGIST_VERSION: str = CATALOG["packagist"]
MAVEN_VERSION: str = CATALOG["maven"]
JS_PACKAGES: dict[str, str] = dict(CATALOG["npm"])


@dataclass(frozen=True)
class DotnetReleasePackage:
    package_id: str
    project_path: str
    version_output: str
    version: str


DOTNET_RELEASE_PACKAGES = tuple(
    DotnetReleasePackage(
        package["id"],
        f"dotnet/logbrew-dotnet/src/{package['id']}/{package['id']}.csproj",
        package["version_output"],
        package["version"],
    )
    for package in CATALOG["nuget"]
)


def compatible_dependency_range(version: str) -> str:
    major_text, minor_text, _patch = version.split(".", 2)
    major = int(major_text)
    minor = int(minor_text)
    if major == 0:
        upper = f"0.{minor + 1}.0"
    else:
        upper = f"{major + 1}.0.0"
    return f"[{version}, {upper})"
