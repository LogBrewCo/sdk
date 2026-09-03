#!/usr/bin/env python3
"""Validate one LogBrew .NET integration package archive."""

import sys
import zipfile
from pathlib import Path


PACKAGES = {
    "LogBrew.AspNetCore": (
        "AspNetCoreMiddlewareTelemetry.cs",
        (),
        (
            "builder.AddLogBrew()",
            "app.UseLogBrew()",
            "LogBrewAspNetCoreRuntime",
            "UseLogBrewRequestTelemetry",
            "AddLogBrewDependencyActivitySourceTelemetry",
            "UseLogBrewDependencyActivitySourceTelemetry",
            "WithRequestFilter",
            "WithRouteTemplateSelector",
            "WithContextProvider",
            "opaque approved session ID",
            "does not read request or response bodies",
            "mechanism `aspnetcore.middleware`",
            "omits exception messages, raw stack text",
            "LOGBREW_SERVER_API_KEY",
            "logbrew projects create aspnet-service",
            "--ingest-key-file",
            "logbrew doctor --project",
            "logbrew traces --project",
            "logbrew projects archive",
        ),
    ),
    "LogBrew.EntityFrameworkCore": (
        "EntityFrameworkCoreCommandTelemetry.cs",
        ("Microsoft.EntityFrameworkCore.Relational",),
        (
            "AddLogBrewCommandTelemetry",
            "LogBrewEntityFrameworkCoreCommandInterceptor",
            "WithCommandFilter",
            "WithMetadataProvider",
            "does not capture raw database statements",
        ),
    ),
    "LogBrew.Hangfire": (
        "HangfireJobTelemetry.cs",
        ("Hangfire.Core", "Newtonsoft.Json"),
        (
            "UseLogBrewHangfire",
            "job.execute",
            "Microsoft.Extensions.Logging",
            "serialized arguments",
            "exception messages",
            "optional third",
        ),
    ),
    "LogBrew.OpenTelemetry": (
        "OpenTelemetrySpanProcessorTelemetry.cs",
        ("OpenTelemetry",),
        (
            "TracerProviderBuilder.AddLogBrew",
            "LogBrewOpenTelemetrySpanProcessor",
            "LogBrewOpenTelemetrySpanExporter",
            "SimpleActivityExportProcessor",
            "WithServiceName",
            "WithDeploymentEnvironment",
            "does not create an OpenTelemetry provider",
            "OTLP forwarding path",
            "payload/header/full-URL/query capture",
            "matching `TelemetryContext` trace identity",
        ),
    ),
    "LogBrew.StackExchangeRedis": (
        "StackExchangeRedisCommandTelemetry.cs",
        ("StackExchange.Redis",),
        (
            "TraceLogBrewCommand",
            "TraceLogBrewCommandAsync",
            "LogBrewStackExchangeRedisCommandOptions",
            "does not capture Redis keys",
        ),
    ),
}


def main() -> int:
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: check_dotnet_integration_nupkg.py package.nupkg [extract-dir]")
    package_path = Path(sys.argv[1])
    extract_dir = Path(sys.argv[2]) if len(sys.argv) == 3 else None
    with zipfile.ZipFile(package_path) as archive:
        if extract_dir is not None:
            archive.extractall(extract_dir)
        names = set(archive.namelist())
        nuspecs = [name for name in names if "/" not in name and name.endswith(".nuspec")]
        if len(nuspecs) != 1 or nuspecs[0][:-7] not in PACKAGES:
            raise SystemExit("unknown LogBrew .NET integration package")
        package_id = nuspecs[0][:-7]
        example, dependencies, readme_needles = PACKAGES[package_id]
        framework = "net10.0" if package_id.endswith(("AspNetCore", "EntityFrameworkCore")) else "netstandard2.0"
        required = {
            nuspecs[0],
            f"lib/{framework}/{package_id}.dll",
            "README.md",
            "logbrew-logo-espresso-bg-128.png",
            f"examples/{example}",
        }
        missing = sorted(required - names)
        if missing:
            raise SystemExit(f"missing {package_id} nupkg files: {missing}")
        readme = archive.read("README.md").decode()
        nuspec = archive.read(nuspecs[0]).decode()
    for dependency in ("LogBrew", *dependencies):
        if f'dependency id="{dependency}"' not in nuspec:
            raise SystemExit(f"missing {package_id} dependency metadata: {dependency}")
    if "<icon>logbrew-logo-espresso-bg-128.png</icon>" not in nuspec:
        raise SystemExit(f"missing {package_id} NuGet package icon metadata")
    for needle in (f"dotnet add package {package_id}", example, *readme_needles):
        if needle not in readme:
            raise SystemExit(f"missing {package_id} README guidance: {needle}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
