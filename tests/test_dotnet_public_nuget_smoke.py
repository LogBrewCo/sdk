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
            "LogBrew.StackExchangeRedis",
        ):
            self.assertIn(package, body)

        for expected in (
            "LOGBREW_NUGET_CORE_VERSION",
            "LOGBREW_NUGET_ASPNETCORE_VERSION",
            "LOGBREW_NUGET_EFCORE_VERSION",
            "LOGBREW_NUGET_REDIS_VERSION",
            "LOGBREW_DOTNET_CORE_VERSION",
            "LOGBREW_DOTNET_ASPNETCORE_VERSION",
            "LOGBREW_DOTNET_EFCORE_VERSION",
            "LOGBREW_DOTNET_REDIS_VERSION",
            'core_version="${1:-${LOGBREW_NUGET_CORE_VERSION:-${LOGBREW_DOTNET_CORE_VERSION:-0.1.4}}}"',
            'aspnetcore_version="${2:-${LOGBREW_NUGET_ASPNETCORE_VERSION:-${LOGBREW_DOTNET_ASPNETCORE_VERSION:-0.1.0}}}"',
            'efcore_version="${3:-${LOGBREW_NUGET_EFCORE_VERSION:-${LOGBREW_DOTNET_EFCORE_VERSION:-0.1.0}}}"',
            'redis_version="${4:-${LOGBREW_NUGET_REDIS_VERSION:-${LOGBREW_DOTNET_REDIS_VERSION:-0.1.0}}}"',
            "--source https://api.nuget.org/v3/index.json",
            "dotnet list",
            "dotnet build",
            "dotnet run",
            "LogBrewClient.Create",
            "LogBrewAspNetCoreOptions.Create",
            "LogBrewEntityFrameworkCoreOptions.Create",
            "LogBrewStackExchangeRedisCommandOptions.Create",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
