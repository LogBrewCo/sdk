from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path


def validate_dotnet_packages(
    root: Path,
    failures: list[str],
    core_version: str,
    aspnetcore_version: str,
    public_license: str,
    repo_url: str,
) -> None:
    _validate_package(
        root,
        failures,
        "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
        required_paths=(
            "dotnet/logbrew-dotnet/README.md",
            "dotnet/logbrew-dotnet/examples/FirstUsefulTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/ActivityTraceCorrelation.cs",
            "dotnet/logbrew-dotnet/examples/ActivitySourceListenerTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/HttpClientOutboundTelemetry.cs",
            "dotnet/logbrew-dotnet/examples/AspNetCoreRequestTelemetry.cs",
            "assets/brand/logbrew-logo-transparent-128.png",
        ),
        expected={
            "TargetFramework": "netstandard2.0",
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
            ("examples/FirstUsefulTelemetry.cs", "package must include examples/FirstUsefulTelemetry.cs"),
            ("examples/ActivityTraceCorrelation.cs", "package must include examples/ActivityTraceCorrelation.cs"),
            ("examples/ActivitySourceListenerTelemetry.cs", "package must include examples/ActivitySourceListenerTelemetry.cs"),
            ("examples/HttpClientOutboundTelemetry.cs", "package must include examples/HttpClientOutboundTelemetry.cs"),
            ("examples/AspNetCoreRequestTelemetry.cs", "package must include examples/AspNetCoreRequestTelemetry.cs"),
        ),
    )
    _validate_package(
        root,
        failures,
        "dotnet/logbrew-dotnet/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj",
        required_paths=(
            "dotnet/logbrew-dotnet/src/LogBrew.AspNetCore/README.md",
            "dotnet/logbrew-dotnet/examples/AspNetCoreMiddlewareTelemetry.cs",
            "assets/brand/logbrew-logo-espresso-bg-128.png",
        ),
        expected={
            "TargetFramework": "net10.0",
            "PackageId": "LogBrew.AspNetCore",
            "Version": aspnetcore_version,
            "Authors": "LogBrew",
            "Company": "LogBrew",
            "PackageLicenseExpression": public_license,
            "PackageProjectUrl": repo_url,
            "RepositoryUrl": repo_url,
            "PackageReadmeFile": "README.md",
            "PackageIcon": "logbrew-logo-espresso-bg-128.png",
        },
        project_needles=(
            ("FrameworkReference Include=\"Microsoft.AspNetCore.App\"", "package must include ASP.NET Core framework reference"),
            ("ProjectReference Include=\"../LogBrew/LogBrew.csproj\"", "package must depend on the core LogBrew project"),
            ("examples/AspNetCoreMiddlewareTelemetry.cs", "package must include examples/AspNetCoreMiddlewareTelemetry.cs"),
        ),
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
