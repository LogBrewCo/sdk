#!/usr/bin/env python3
"""Verify that public registries expose the expected LogBrew package versions."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from check_release_metadata import JS_PACKAGES, PUBLIC_VERSION, RUBYGEMS_VERSION


NPM_PACKAGES = tuple(sorted(JS_PACKAGES.values()))
NPM_VERSION_PACKAGES = NPM_PACKAGES + ("co.logbrew.unity",)
PYPI_PACKAGES = ("logbrew-sdk",)
PYPI_EXTRA_PACKAGES = ("logbrew-fastapi", "logbrew-django")
RUBYGEMS_PACKAGES = ("logbrew-sdk",)
DEFAULT_PACKAGE_VERSIONS = {package_name: RUBYGEMS_VERSION for package_name in RUBYGEMS_PACKAGES}
NUGET_PACKAGES = ("LogBrew", "LogBrew.AspNetCore", "LogBrew.EntityFrameworkCore", "LogBrew.StackExchangeRedis")
CRATES = ("logbrew",)
MAVEN_ARTIFACTS = ("logbrew-sdk", "logbrew-kotlin", "logbrew-kotlin-okhttp")
MAVEN_PACKAGE_LABELS = tuple(f"co.logbrew:{artifact_id}" for artifact_id in MAVEN_ARTIFACTS)
OPENUPM_PACKAGES = ("co.logbrew.unity",)

def decode_json(raw: bytes) -> Any:
    return json.loads(raw.decode("utf-8"))


def decode_text(raw: bytes) -> str:
    return raw.decode("utf-8")


@dataclass(frozen=True)
class RegistryCheck:
    label: str
    url: str
    extractor: Callable[[Any], set[str]]
    decoder: Callable[[bytes], Any] = decode_json


def maybe_string(value: Any) -> set[str]:
    return {value} if isinstance(value, str) and value else set()


def dict_value(payload: Any, key: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def npm_versions(payload: Any) -> set[str]:
    if not isinstance(payload, dict):
        return set()
    versions = maybe_string(dict_value(payload, "dist-tags").get("latest"))
    raw_versions = payload.get("versions", {})
    if isinstance(raw_versions, dict):
        versions.update(raw_versions.keys())
    return versions


def pypi_versions(payload: Any) -> set[str]:
    if not isinstance(payload, dict):
        return set()
    versions = maybe_string(dict_value(payload, "info").get("version"))
    raw_releases = payload.get("releases", {})
    if isinstance(raw_releases, dict):
        versions.update(raw_releases.keys())
    return versions


def rubygems_versions(payload: Any) -> set[str]:
    if not isinstance(payload, dict):
        return set()
    return maybe_string(payload.get("version"))


def nuget_versions(payload: Any) -> set[str]:
    if not isinstance(payload, dict):
        return set()
    return {version for version in payload.get("versions", []) if isinstance(version, str)}


def packagist_versions(package_name: str) -> Callable[[Any], set[str]]:
    def extract(payload: Any) -> set[str]:
        if not isinstance(payload, dict):
            return set()
        packages = payload.get("packages", {}).get(package_name, [])
        if not isinstance(packages, list):
            return set()
        return {
            entry.get("version")
            for entry in packages
            if isinstance(entry, dict) and isinstance(entry.get("version"), str)
        }

    return extract


def crates_versions(payload: Any) -> set[str]:
    if isinstance(payload, str):
        versions: set[str] = set()
        for line in payload.splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(entry, dict)
                and isinstance(entry.get("vers"), str)
                and not entry.get("yanked", False)
            ):
                versions.add(entry["vers"])
        return versions
    if not isinstance(payload, dict):
        return set()
    versions = maybe_string(dict_value(payload, "crate").get("newest_version"))
    raw_versions = payload.get("versions", [])
    if isinstance(raw_versions, list):
        versions.update(
            version.get("num")
            for version in raw_versions
            if isinstance(version, dict) and isinstance(version.get("num"), str)
        )
    return versions


def crates_index_path(crate_name: str) -> str:
    if len(crate_name) == 1:
        return f"1/{crate_name}"
    if len(crate_name) == 2:
        return f"2/{crate_name}"
    if len(crate_name) == 3:
        return f"3/{crate_name[0]}/{crate_name}"
    return f"{crate_name[:2]}/{crate_name[2:4]}/{crate_name}"


def maven_versions(payload: Any) -> set[str]:
    if not isinstance(payload, str):
        return set()
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        return set()
    versions = {
        text
        for text in (
            root.findtext("./versioning/latest"),
            root.findtext("./versioning/release"),
        )
        if text
    }
    versions.update(version.text for version in root.findall("./versioning/versions/version") if version.text)
    return versions


def npm_check(package_name: str) -> RegistryCheck:
    encoded = urllib.parse.quote(package_name, safe="")
    return RegistryCheck(package_name, f"https://registry.npmjs.org/{encoded}", npm_versions)


def pypi_check(package_name: str) -> RegistryCheck:
    return RegistryCheck(package_name, f"https://pypi.org/pypi/{package_name}/json", pypi_versions)


def rubygems_check(package_name: str) -> RegistryCheck:
    return RegistryCheck(
        package_name,
        f"https://rubygems.org/api/v1/gems/{package_name}.json",
        rubygems_versions,
    )


def nuget_check(package_name: str) -> RegistryCheck:
    lowered = package_name.lower()
    return RegistryCheck(
        package_name,
        f"https://api.nuget.org/v3-flatcontainer/{lowered}/index.json",
        nuget_versions,
    )


def packagist_check(package_name: str) -> RegistryCheck:
    return RegistryCheck(
        package_name,
        f"https://repo.packagist.org/p2/{package_name}.json",
        packagist_versions(package_name),
    )


def crates_check(crate_name: str) -> RegistryCheck:
    return RegistryCheck(
        crate_name,
        f"https://index.crates.io/{crates_index_path(crate_name)}",
        crates_versions,
        decode_text,
    )


def maven_check(artifact_id: str) -> RegistryCheck:
    return RegistryCheck(
        f"co.logbrew:{artifact_id}",
        f"https://repo1.maven.org/maven2/co/logbrew/{artifact_id}/maven-metadata.xml",
        maven_versions,
        decode_text,
    )


def openupm_check(package_name: str) -> RegistryCheck:
    encoded = urllib.parse.quote(package_name, safe="")
    return RegistryCheck(package_name, f"https://package.openupm.com/{encoded}", npm_versions)


def checks_for(args: argparse.Namespace) -> list[RegistryCheck]:
    requested = set(args.target)
    if "all" in requested:
        requested.update({"npm", "pypi", "rubygems", "nuget"})
        if args.include_crates:
            requested.add("crates")
        if args.include_packagist:
            requested.add("packagist")
        if args.include_maven:
            requested.add("maven")
        if args.include_openupm:
            requested.add("openupm")

    checks: list[RegistryCheck] = []
    if "npm" in requested:
        npm_packages = tuple(args.npm_package) if args.npm_package else NPM_PACKAGES
        checks.extend(npm_check(package_name) for package_name in npm_packages)
        if args.include_unity_npm:
            checks.append(npm_check("co.logbrew.unity"))
    if "pypi" in requested:
        checks.extend(pypi_check(package_name) for package_name in PYPI_PACKAGES)
        if args.include_pypi_extras:
            checks.extend(pypi_check(package_name) for package_name in PYPI_EXTRA_PACKAGES)
    if "rubygems" in requested:
        checks.extend(rubygems_check(package_name) for package_name in RUBYGEMS_PACKAGES)
    if "nuget" in requested:
        checks.extend(nuget_check(package_name) for package_name in NUGET_PACKAGES)
    if "packagist" in requested:
        checks.extend(packagist_check(package_name) for package_name in ("logbrew/sdk",))
    if "crates" in requested:
        checks.extend(crates_check(crate_name) for crate_name in CRATES)
    if "maven" in requested:
        maven_artifacts = tuple(args.maven_artifact) if getattr(args, "maven_artifact", []) else MAVEN_ARTIFACTS
        checks.extend(maven_check(artifact_id) for artifact_id in maven_artifacts)
    if "openupm" in requested:
        checks.extend(openupm_check(package_name) for package_name in OPENUPM_PACKAGES)
    return checks


def expected_versions(version: str) -> set[str]:
    stripped = version.removeprefix("v")
    return {stripped, f"v{stripped}"}


def fetch_payload(url: str, timeout: float, decoder: Callable[[bytes], Any]) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": "LogBrew public registry verifier"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return decoder(response.read())
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as exc:
        if "CERTIFICATE_VERIFY_FAILED" not in str(exc) or shutil.which("curl") is None:
            raise
        result = subprocess.run(
            ["curl", "-fsSL", "--max-time", str(timeout), url],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            error = result.stderr.decode("utf-8", errors="replace").strip()
            fallback = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(error or fallback) from exc
        return decoder(result.stdout)


def fetch_json(url: str, timeout: float) -> Any:
    return fetch_payload(url, timeout, decode_json)


def is_missing_registry_page_error(error: BaseException) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 404
    message = str(error)
    return "HTTP 404" in message or "HTTP Error 404" in message or "returned error: 404" in message


def validate_check(
    check: RegistryCheck,
    expected: set[str],
    timeout: float,
    retries: int = 0,
    retry_delay: float = 5.0,
    fetcher: Callable[[str, float], Any] | None = None,
) -> list[str]:
    last_failure: list[str] = []
    for attempt in range(retries + 1):
        try:
            if fetcher:
                payload = fetcher(check.url, timeout)
            else:
                payload = fetch_payload(check.url, timeout, check.decoder)
        except urllib.error.HTTPError as exc:
            last_failure = [f"{check.label}: registry returned HTTP {exc.code} for {check.url}"]
            if is_missing_registry_page_error(exc):
                break
        except (OSError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError, ET.ParseError) as exc:
            last_failure = [f"{check.label}: failed to read {check.url}: {exc}"]
            if is_missing_registry_page_error(exc):
                break
        else:
            found = check.extractor(payload)
            if found.intersection(expected):
                return []
            last_failure = [f"{check.label}: expected one of {sorted(expected)}, found {sorted(found)}"]

        if attempt < retries:
            time.sleep(retry_delay)

    return last_failure


def go_module_version(version: str) -> str:
    stripped = version.removeprefix("v")
    return f"v{stripped}"


def validate_go_module(version: str) -> list[str]:
    if shutil.which("go") is None:
        return ["go: command not found"]

    module_version = go_module_version(version)
    with tempfile.TemporaryDirectory(prefix="logbrew-go-registry-") as tmp:
        tmp_path = Path(tmp)
        init_result = subprocess.run(
            ["go", "mod", "init", "logbrew.registry.verify"],
            cwd=tmp_path,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if init_result.returncode != 0:
            return [f"go mod init failed: {init_result.stdout.strip()}"]

        get_result = subprocess.run(
            ["go", "get", f"github.com/LogBrewCo/sdk/go/logbrew@{module_version}"],
            cwd=tmp_path,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if get_result.returncode != 0:
            return [
                f"go get github.com/LogBrewCo/sdk/go/logbrew@{module_version} failed: "
                f"{get_result.stdout.strip()}"
            ]
    return []


def validate(args: argparse.Namespace) -> list[str]:
    failures: list[str] = []
    for check in checks_for(args):
        default_version = DEFAULT_PACKAGE_VERSIONS.get(check.label, args.version)
        version = args.package_versions.get(check.label, default_version)
        failures.extend(validate_check(check, expected_versions(version), args.timeout, args.retries, args.retry_delay))
    if "go" in args.target or ("all" in args.target and args.include_go):
        failures.extend(validate_go_module(args.version))
    return failures


def parse_package_versions(
    raw_versions: list[str],
    *,
    allowed_packages: tuple[str, ...] = NPM_VERSION_PACKAGES,
    package_family: str = "npm",
) -> dict[str, str]:
    versions: dict[str, str] = {}
    for raw_version in raw_versions:
        package_name, separator, version = raw_version.partition("=")
        package_name = package_name.strip()
        version = version.strip()
        if not separator or not package_name or not version:
            raise argparse.ArgumentTypeError(
                f"expected {package_family} package version in name=version form, got {raw_version!r}"
            )
        if package_name not in allowed_packages:
            raise argparse.ArgumentTypeError(f"unknown {package_family} package: {package_name}")
        versions[package_name] = version
    return versions


def format_overrides(label: str, versions: dict[str, str]) -> str | None:
    if not versions:
        return None
    formatted = ", ".join(f"{package_name}@{version}" for package_name, version in sorted(versions.items()))
    return f"{label} overrides: {formatted}"


def success_summary(args: argparse.Namespace) -> str:
    targets = ", ".join(args.target)
    requested_targets = set(args.target)
    rubygems_versions = (
        {package_name: DEFAULT_PACKAGE_VERSIONS[package_name] for package_name in RUBYGEMS_PACKAGES}
        if "rubygems" in requested_targets or "all" in requested_targets
        else {}
    )
    overrides = [
        formatted
        for formatted in (
            format_overrides("npm", args.npm_versions),
            format_overrides("pypi", args.pypi_versions),
            format_overrides("RubyGems", rubygems_versions),
            format_overrides("nuget", args.nuget_versions),
            format_overrides("maven", getattr(args, "maven_versions", {})),
        )
        if formatted is not None
    ]
    suffix = f"; {'; '.join(overrides)}" if overrides else ""
    return f"public registry versions ok for {targets} at {args.version}{suffix}"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify public registry package versions.")
    parser.add_argument("--version", default=PUBLIC_VERSION, help="Expected public package version.")
    parser.add_argument(
        "--target",
        action="append",
        choices=("all", "npm", "pypi", "rubygems", "nuget", "packagist", "crates", "maven", "openupm", "go"),
        default=[],
        help="Registry family to verify. May be passed more than once.",
    )
    parser.add_argument("--include-unity-npm", action="store_true")
    parser.add_argument(
        "--npm-package",
        action="append",
        choices=NPM_PACKAGES,
        default=[],
        help="Restrict npm registry verification to one package. May be passed more than once.",
    )
    parser.add_argument(
        "--npm-version",
        action="append",
        default=[],
        metavar="PACKAGE=VERSION",
        help="Expected version for one npm package. May be passed more than once.",
    )
    parser.add_argument(
        "--pypi-version",
        action="append",
        default=[],
        metavar="PACKAGE=VERSION",
        help="Expected version for one PyPI package. May be passed more than once.",
    )
    parser.add_argument(
        "--nuget-version",
        action="append",
        default=[],
        metavar="PACKAGE=VERSION",
        help="Expected version for one NuGet package. May be passed more than once.",
    )
    parser.add_argument(
        "--maven-artifact",
        action="append",
        choices=MAVEN_ARTIFACTS,
        default=[],
        help="Restrict Maven Central verification to one co.logbrew artifact id. May be passed more than once.",
    )
    parser.add_argument(
        "--maven-version",
        action="append",
        default=[],
        metavar="PACKAGE=VERSION",
        help="Expected version for one Maven package, for example co.logbrew:logbrew-sdk=0.1.0.",
    )
    parser.add_argument("--include-pypi-extras", action="store_true")
    parser.add_argument("--include-crates", action="store_true")
    parser.add_argument("--include-packagist", action="store_true")
    parser.add_argument("--include-maven", action="store_true")
    parser.add_argument("--include-openupm", action="store_true")
    parser.add_argument("--include-go", action="store_true")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--retries", type=int, default=6)
    parser.add_argument("--retry-delay", type=float, default=10.0)
    args = parser.parse_args(argv)
    if not args.target:
        args.target = ["all"]
    if args.npm_package and "npm" not in args.target and "all" not in args.target:
        parser.error("--npm-package requires --target npm or --target all")
    if args.pypi_version and "pypi" not in args.target and "all" not in args.target:
        parser.error("--pypi-version requires --target pypi or --target all")
    if args.nuget_version and "nuget" not in args.target and "all" not in args.target:
        parser.error("--nuget-version requires --target nuget or --target all")
    if args.maven_artifact and "maven" not in args.target and "all" not in args.target:
        parser.error("--maven-artifact requires --target maven or --target all")
    if args.maven_version and "maven" not in args.target and "all" not in args.target:
        parser.error("--maven-version requires --target maven or --target all")
    try:
        args.npm_versions = parse_package_versions(args.npm_version)
        args.pypi_versions = parse_package_versions(
            args.pypi_version,
            allowed_packages=PYPI_PACKAGES + PYPI_EXTRA_PACKAGES,
            package_family="PyPI",
        )
        args.nuget_versions = parse_package_versions(
            args.nuget_version,
            allowed_packages=NUGET_PACKAGES,
            package_family="NuGet",
        )
        args.maven_versions = parse_package_versions(
            args.maven_version,
            allowed_packages=MAVEN_PACKAGE_LABELS,
            package_family="Maven",
        )
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))
    args.package_versions = {**args.npm_versions, **args.pypi_versions, **args.nuget_versions, **args.maven_versions}
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    failures = validate(args)
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(success_summary(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
