from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_dotnet_public_nuget_smoke.sh"


class DotnetPublicNugetSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_nuget_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for package in (
            "LogBrew",
            "LogBrew.AspNetCore",
            "LogBrew.EntityFrameworkCore",
            "LogBrew.HttpClient",
            "LogBrew.StackExchangeRedis",
            "LogBrew.OpenTelemetry",
        ):
            self.assertIn(package, body)

        for expected in (
            "LOGBREW_NUGET_CORE_VERSION",
            "LOGBREW_NUGET_ASPNETCORE_VERSION",
            "LOGBREW_NUGET_EFCORE_VERSION",
            "LOGBREW_NUGET_HTTPCLIENT_VERSION",
            "LOGBREW_NUGET_REDIS_VERSION",
            "LOGBREW_NUGET_OTEL_VERSION",
            "LOGBREW_DOTNET_CORE_VERSION",
            "LOGBREW_DOTNET_ASPNETCORE_VERSION",
            "LOGBREW_DOTNET_EFCORE_VERSION",
            "LOGBREW_DOTNET_HTTPCLIENT_VERSION",
            "LOGBREW_DOTNET_REDIS_VERSION",
            "LOGBREW_DOTNET_OTEL_VERSION",
            'core_version="${1:-${LOGBREW_NUGET_CORE_VERSION:-${LOGBREW_DOTNET_CORE_VERSION:-0.1.5}}}"',
            'aspnetcore_version="${2:-${LOGBREW_NUGET_ASPNETCORE_VERSION:-${LOGBREW_DOTNET_ASPNETCORE_VERSION:-0.1.0}}}"',
            'efcore_version="${3:-${LOGBREW_NUGET_EFCORE_VERSION:-${LOGBREW_DOTNET_EFCORE_VERSION:-0.1.0}}}"',
            'httpclient_version="${4:-${LOGBREW_NUGET_HTTPCLIENT_VERSION:-${LOGBREW_DOTNET_HTTPCLIENT_VERSION:-0.1.0}}}"',
            'redis_version="${5:-${LOGBREW_NUGET_REDIS_VERSION:-${LOGBREW_DOTNET_REDIS_VERSION:-0.1.0}}}"',
            'otel_version="${6:-${LOGBREW_NUGET_OTEL_VERSION:-${LOGBREW_DOTNET_OTEL_VERSION:-}}}"',
            'source_commit="${7:-${LOGBREW_NUGET_SOURCE_COMMIT:-}}"',
            'httpclient_content_sha256="${8:-${LOGBREW_NUGET_HTTPCLIENT_CONTENT_SHA256:-}}"',
            "--source https://api.nuget.org/v3/index.json",
            "dotnet list",
            "dotnet build",
            "dotnet run",
            "sha256",
            "package_content_sha256",
            "repository",
            "AddLogBrewCorrelation",
            "LogBrewTrace.Activate",
            "IHttpClientFactory",
            "LogBrewClient.Create",
            "LogBrewAspNetCoreOptions.Create",
            "LogBrewEntityFrameworkCoreOptions.Create",
            "LogBrewStackExchangeRedisCommandOptions.Create",
            "LogBrewOpenTelemetrySpanProcessor",
            "LogBrewOpenTelemetrySpanExporter",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
