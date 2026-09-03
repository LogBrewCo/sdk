from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DotnetReleasePackage:
    package_id: str
    project_path: str
    version_output: str


DOTNET_RELEASE_PACKAGES = (
    DotnetReleasePackage("LogBrew", "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj", "core_version"),
    DotnetReleasePackage(
        "LogBrew.AspNetCore",
        "dotnet/logbrew-dotnet/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj",
        "aspnetcore_version",
    ),
    DotnetReleasePackage(
        "LogBrew.EntityFrameworkCore",
        "dotnet/logbrew-dotnet/src/LogBrew.EntityFrameworkCore/LogBrew.EntityFrameworkCore.csproj",
        "efcore_version",
    ),
    DotnetReleasePackage(
        "LogBrew.Hangfire",
        "dotnet/logbrew-dotnet/src/LogBrew.Hangfire/LogBrew.Hangfire.csproj",
        "hangfire_version",
    ),
    DotnetReleasePackage(
        "LogBrew.HttpClient",
        "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
        "httpclient_version",
    ),
    DotnetReleasePackage(
        "LogBrew.StackExchangeRedis",
        "dotnet/logbrew-dotnet/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj",
        "redis_version",
    ),
    DotnetReleasePackage(
        "LogBrew.OpenTelemetry",
        "dotnet/logbrew-dotnet/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj",
        "otel_version",
    ),
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


def validate_dotnet_packages(
    root: Path,
    failures: list[str],
    core_version: str,
    aspnetcore_version: str,
    efcore_version: str,
    hangfire_version: str,
    redis_version: str,
    otel_version: str,
    public_license: str,
    repo_url: str,
    httpclient_version: str = "0.1.0",
) -> None:
    _validate_release_catalog(root, failures)
    _validate_package(
        root,
        failures,
        "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
        required_paths=(
            "dotnet/logbrew-dotnet/README.md",
            "dotnet/logbrew-dotnet/examples/FirstUsefulTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/ActivityTraceCorrelation.cs",
            "dotnet/logbrew-dotnet/examples/ActivitySourceListenerTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/DependencySpansTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/DbCommandTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/HttpClientOutboundTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/AspNetCoreRequestTelemetry.cs",
            "assets/brand/logbrew-logo-transparent-128.png",
        ),
        expected={
            "TargetFrameworks": "netstandard2.0;net8.0",
            "PackageId": "LogBrew",
            "Version": core_version,
            "Authors": "LogBrew",
            "Company": "LogBrew",
            "PackageLicenseExpression": public_license,
            "PackageProjectUrl": repo_url,
            "RepositoryUrl": repo_url,
            "PackageReadmeFile": "README.md",
            "PackageIcon": "logbrew-logo-transparent-128.png",
        },
        project_needles=(
            (
                "PackageVersion Condition=\"'$(LogBrewProjectReferenceVersion)' != ''\"",
                "core package must expose the bounded project-reference pack seam",
            ),
            ("examples/FirstUsefulTelemetry.cs", "package must include examples/FirstUsefulTelemetry.cs"),
            ("examples/ActivityTraceCorrelation.cs", "package must include examples/ActivityTraceCorrelation.cs"),
            ("examples/ActivitySourceListenerTelemetry.cs", "package must include examples/ActivitySourceListenerTelemetry.cs"),
            ("examples/DependencySpansTelemetry.cs", "package must include examples/DependencySpansTelemetry.cs"),
            ("examples/DbCommandTelemetry.cs", "package must include examples/DbCommandTelemetry.cs"),
            ("examples/HttpClientOutboundTelemetry.cs", "package must include examples/HttpClientOutboundTelemetry.cs"),
            ("examples/AspNetCoreRequestTelemetry.cs", "package must include examples/AspNetCoreRequestTelemetry.cs"),
        ),
    )
    _validate_package(
        root,
        failures,
        "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
        required_paths=(
            "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/README.md",
            "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/examples/HttpClientFactoryCorrelation.cs",
            "assets/brand/logbrew-logo-espresso-bg-128.png",
        ),
        expected={
            "TargetFrameworks": "netstandard2.0;net8.0",
            "IsAotCompatible": "true",
            "SignAssembly": "false",
            "LogBrewCoreDependencyVersion": compatible_dependency_range(core_version),
            "PackageId": "LogBrew.HttpClient",
            "Version": httpclient_version,
            "Authors": "LogBrew",
            "Company": "LogBrew",
            "PackageLicenseExpression": public_license,
            "PackageProjectUrl": repo_url,
            "RepositoryUrl": repo_url,
            "PackageReadmeFile": "README.md",
            "PackageIcon": "logbrew-logo-espresso-bg-128.png",
        },
        project_needles=(
            (
                "ProjectReference Include=\"../LogBrew/LogBrew.csproj\"",
                "package must depend on the core LogBrew project",
            ),
            ("PackageReference Include=\"Microsoft.Extensions.Http\"", "package must depend on IHttpClientFactory APIs"),
            ("examples/HttpClientFactoryCorrelation.cs", "package must include its selected-client example"),
        ),
    )
    for package_id, framework, version, example, dependency_needles in (
        (
            "LogBrew.AspNetCore",
            "net10.0",
            aspnetcore_version,
            "AspNetCoreMiddlewareTelemetry.cs",
            ("FrameworkReference Include=\"Microsoft.AspNetCore.App\"",),
        ),
        (
            "LogBrew.EntityFrameworkCore",
            "net10.0",
            efcore_version,
            "EntityFrameworkCoreCommandTelemetry.cs",
            ("PackageReference Include=\"Microsoft.EntityFrameworkCore.Relational\"",),
        ),
        (
            "LogBrew.Hangfire",
            "netstandard2.0",
            hangfire_version,
            "HangfireJobTelemetry.cs",
            (
                "PackageReference Include=\"Hangfire.Core\"",
                "PackageReference Include=\"Newtonsoft.Json\"",
            ),
        ),
        (
            "LogBrew.StackExchangeRedis",
            "netstandard2.0",
            redis_version,
            "StackExchangeRedisCommandTelemetry.cs",
            ("PackageReference Include=\"StackExchange.Redis\"",),
        ),
        (
            "LogBrew.OpenTelemetry",
            "netstandard2.0",
            otel_version,
            "OpenTelemetrySpanProcessorTelemetry.cs",
            ("PackageReference Include=\"OpenTelemetry\"",),
        ),
    ):
        _validate_integration_package(
            root,
            failures,
            package_id,
            framework,
            version,
            example,
            dependency_needles,
            public_license,
            repo_url,
        )


def _validate_integration_package(
    root: Path,
    failures: list[str],
    package_id: str,
    framework: str,
    version: str,
    example: str,
    dependency_needles: tuple[str, ...],
    public_license: str,
    repo_url: str,
) -> None:
    package_root = f"dotnet/logbrew-dotnet/src/{package_id}"
    _validate_package(
        root,
        failures,
        f"{package_root}/{package_id}.csproj",
        required_paths=(
            f"{package_root}/README.md",
            f"dotnet/logbrew-dotnet/examples/{example}",
            "assets/brand/logbrew-logo-espresso-bg-128.png",
        ),
        expected={
            "TargetFramework": framework,
            "PackageId": package_id,
            "Version": version,
            "Authors": "LogBrew",
            "Company": "LogBrew",
            "PackageLicenseExpression": public_license,
            "PackageProjectUrl": repo_url,
            "RepositoryUrl": repo_url,
            "PackageReadmeFile": "README.md",
            "PackageIcon": "logbrew-logo-espresso-bg-128.png",
        },
        project_needles=(
            (
                "ProjectReference Include=\"../LogBrew/LogBrew.csproj\"",
                "package must depend on the core LogBrew project",
            ),
            *(
                (needle, f"package dependency metadata is missing {needle}")
                for needle in dependency_needles
            ),
            (f"examples/{example}", f"package must include examples/{example}"),
        ),
    )


def _validate_release_catalog(root: Path, failures: list[str]) -> None:
    source_root = root / "dotnet" / "logbrew-dotnet" / "src"
    discovered: dict[str, str] = {}
    if source_root.exists():
        for project_path in sorted(source_root.glob("*/*.csproj")):
            project = _parse_xml(project_path, failures)
            if project is None:
                continue
            properties = (_direct_children(project, "PropertyGroup") or [ET.Element("PropertyGroup")])[0]
            if (_child_text(properties, "IsPackable") or "").lower() == "false":
                continue
            package_id = _child_text(properties, "PackageId")
            if not package_id:
                failures.append(f"{project_path}: public package project must declare PackageId")
                continue
            discovered[package_id] = project_path.relative_to(root).as_posix()

    expected = {package.package_id: package.project_path for package in DOTNET_RELEASE_PACKAGES}
    for package_id in sorted(expected.keys() - discovered.keys()):
        failures.append(f"NuGet release catalog package is missing from source: {package_id}")
    for package_id in sorted(discovered.keys() - expected.keys()):
        failures.append(f"NuGet release catalog is missing public package: {package_id}")
    for package_id in sorted(expected.keys() & discovered.keys()):
        if expected[package_id] != discovered[package_id]:
            failures.append(
                f"NuGet release catalog path mismatch for {package_id}: "
                f"expected {expected[package_id]}, found {discovered[package_id]}"
            )


def _validate_package(
    root: Path,
    failures: list[str],
    location: str,
    *,
    required_paths: tuple[str, ...],
    expected: dict[str, str],
    project_needles: tuple[tuple[str, str], ...],
) -> None:
    project_path = _require_path(root, location, failures)
    for required in required_paths:
        _require_path(root, required, failures)
    if not project_path.exists():
        return

    project = _parse_xml(project_path, failures)
    if project is None:
        return

    properties = (_direct_children(project, "PropertyGroup") or [ET.Element("PropertyGroup")])[0]
    for field, value in expected.items():
        _require_equal(failures, location, field, _child_text(properties, field), value)
    _require_contains(failures, location, "Description", _child_text(properties, "Description"), "LogBrew")

    project_text = project_path.read_text(encoding="utf-8")
    for needle, message in project_needles:
        _require(needle in project_text, failures, f"{location}: {message}")


def _require(condition: bool, failures: list[str], message: str) -> None:
    if not condition:
        failures.append(message)


def _require_path(root: Path, relative: str, failures: list[str]) -> Path:
    path = root / relative
    if not path.exists():
        failures.append(f"missing {relative}")
    return path


def _require_equal(failures: list[str], location: str, field: str, actual: object, expected: object) -> None:
    if actual != expected:
        failures.append(f"{location}: expected {field}={expected!r}, found {actual!r}")


def _require_contains(failures: list[str], location: str, field: str, actual: object, needle: str) -> None:
    if not isinstance(actual, str) or needle not in actual:
        failures.append(f"{location}: expected {field} to contain {needle!r}")


def _parse_xml(path: Path, failures: list[str]) -> ET.Element | None:
    try:
        return ET.parse(path).getroot()
    except ET.ParseError as error:
        failures.append(f"{path}: invalid XML: {error}")
        return None


def _direct_children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if _strip_namespace(child.tag) == name]


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in _direct_children(element, name):
        return child.text
    return None


def _strip_namespace(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag
