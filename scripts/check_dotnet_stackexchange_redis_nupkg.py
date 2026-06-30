#!/usr/bin/env python3
from __future__ import annotations

import sys
import zipfile
from pathlib import Path


REQUIRED_FILES = {
    "LogBrew.StackExchangeRedis.nuspec",
    "lib/netstandard2.0/LogBrew.StackExchangeRedis.dll",
    "README.md",
    "logbrew-logo-espresso-bg-128.png",
    "examples/StackExchangeRedisCommandTelemetry.cs",
}

README_NEEDLES = (
    "dotnet add package LogBrew.StackExchangeRedis",
    "TraceLogBrewCommand",
    "TraceLogBrewCommandAsync",
    "LogBrewStackExchangeRedisCommandOptions",
    "does not capture Redis keys",
    "StackExchangeRedisCommandTelemetry.cs",
)


def main() -> int:
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: check_dotnet_stackexchange_redis_nupkg.py package.nupkg [extract-dir]")

    package_path = Path(sys.argv[1])
    extract_dir = Path(sys.argv[2]) if len(sys.argv) == 3 else None

    with zipfile.ZipFile(package_path) as archive:
        if extract_dir is not None:
            archive.extractall(extract_dir)
        names = set(archive.namelist())
        missing = sorted(REQUIRED_FILES - names)
        if missing:
            raise SystemExit(f"missing StackExchange.Redis nupkg files: {missing}")
        readme = archive.read("README.md").decode()
        nuspec = archive.read("LogBrew.StackExchangeRedis.nuspec").decode()

    if 'dependency id="LogBrew"' not in nuspec:
        raise SystemExit("missing LogBrew dependency metadata")
    if 'dependency id="StackExchange.Redis"' not in nuspec:
        raise SystemExit("missing StackExchange.Redis dependency metadata")
    if "<icon>logbrew-logo-espresso-bg-128.png</icon>" not in nuspec:
        raise SystemExit("missing StackExchange.Redis NuGet package icon metadata")
    for needle in README_NEEDLES:
        if needle not in readme:
            raise SystemExit(f"missing StackExchange.Redis README guidance: {needle}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
