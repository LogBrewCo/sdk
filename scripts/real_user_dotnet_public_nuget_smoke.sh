#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
source "$repo_root/scripts/dotnet_verifier_lock.sh"

core_version="${1:-${LOGBREW_NUGET_CORE_VERSION:-${LOGBREW_DOTNET_CORE_VERSION:-0.1.4}}}"
aspnetcore_version="${2:-${LOGBREW_NUGET_ASPNETCORE_VERSION:-${LOGBREW_DOTNET_ASPNETCORE_VERSION:-0.1.0}}}"
efcore_version="${3:-${LOGBREW_NUGET_EFCORE_VERSION:-${LOGBREW_DOTNET_EFCORE_VERSION:-0.1.0}}}"
redis_version="${4:-${LOGBREW_NUGET_REDIS_VERSION:-${LOGBREW_DOTNET_REDIS_VERSION:-0.1.0}}}"
otel_version="${5:-${LOGBREW_NUGET_OTEL_VERSION:-${LOGBREW_DOTNET_OTEL_VERSION:-}}}"

cleanup() {
  rm -rf "$tmp_dir"
  release_dotnet_verifier_lock
}

require_version() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "missing required $label version" >&2
    echo "usage: bash scripts/real_user_dotnet_public_nuget_smoke.sh [LogBrew] [LogBrew.AspNetCore] [LogBrew.EntityFrameworkCore] [LogBrew.StackExchangeRedis] [LogBrew.OpenTelemetry]" >&2
    exit 2
  fi
}

require_package_line() {
  local package_name="$1"
  local expected_version="$2"
  if ! awk -v package_name="$package_name" -v expected_version="$expected_version" '
    $1 == ">" && $2 == package_name && $3 == expected_version && $4 == expected_version { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$tmp_dir/packages.txt"; then
    echo "expected $package_name to resolve to $expected_version" >&2
    cat "$tmp_dir/packages.txt" >&2
    exit 1
  fi
}

trap cleanup EXIT

if ! acquire_dotnet_verifier_lock; then
  echo "another .NET SDK verifier run is already in progress" >&2
  exit 1
fi

require_version "LogBrew" "$core_version"
require_version "LogBrew.AspNetCore" "$aspnetcore_version"
require_version "LogBrew.EntityFrameworkCore" "$efcore_version"
require_version "LogBrew.StackExchangeRedis" "$redis_version"

export NUGET_PACKAGES="$tmp_dir/nuget-packages"
export NUGET_HTTP_CACHE_PATH="$tmp_dir/nuget-http-cache"

app_dir="$tmp_dir/dotnet-public-nuget-app"
dotnet new console --framework net10.0 --name DotnetPublicNuGetApp --output "$app_dir" >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew --version "$core_version" --source https://api.nuget.org/v3/index.json >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.AspNetCore --version "$aspnetcore_version" --source https://api.nuget.org/v3/index.json >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.EntityFrameworkCore --version "$efcore_version" --source https://api.nuget.org/v3/index.json >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.StackExchangeRedis --version "$redis_version" --source https://api.nuget.org/v3/index.json >/dev/null
if [[ -n "$otel_version" ]]; then
  dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.OpenTelemetry --version "$otel_version" --source https://api.nuget.org/v3/index.json >/dev/null
fi

dotnet list "$app_dir/DotnetPublicNuGetApp.csproj" package > "$tmp_dir/packages.txt"
require_package_line "LogBrew" "$core_version"
require_package_line "LogBrew.AspNetCore" "$aspnetcore_version"
require_package_line "LogBrew.EntityFrameworkCore" "$efcore_version"
require_package_line "LogBrew.StackExchangeRedis" "$redis_version"
if [[ -n "$otel_version" ]]; then
  require_package_line "LogBrew.OpenTelemetry" "$otel_version"
fi

cat > "$app_dir/Program.cs" <<'CS'
using System;
using LogBrew;
using LogBrew.EntityFrameworkCore;
using LogBrew.StackExchangeRedis;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "public-nuget-smoke", "0.1.0", maxRetries: 1, maxQueueSize: 2);
client.Log("evt_public_nuget_smoke", "2026-06-30T16:00:00Z", LogAttributes.Create("public package smoke", "info"));

var aspnetCoreOptions = LogBrewAspNetCoreOptions.Create();
var efCoreOptions = LogBrewEntityFrameworkCoreOptions.Create();
var redisOptions = LogBrewStackExchangeRedisCommandOptions.Create();

Console.WriteLine(client.PendingEvents());
Console.WriteLine(aspnetCoreOptions.GetType().FullName);
Console.WriteLine(efCoreOptions.GetType().FullName);
Console.WriteLine(redisOptions.GetType().FullName);
CS

if [[ -n "$otel_version" ]]; then
  cat >> "$app_dir/Program.cs" <<'CS'
var otelProcessor = new LogBrew.OpenTelemetry.LogBrewOpenTelemetrySpanProcessor(client);
Console.WriteLine(otelProcessor.GetType().FullName);
CS
fi

dotnet build "$app_dir/DotnetPublicNuGetApp.csproj" --configuration Release --no-restore >/dev/null
dotnet run --project "$app_dir/DotnetPublicNuGetApp.csproj" --configuration Release --no-build > "$tmp_dir/run.out"

grep -qx '1' "$tmp_dir/run.out"
grep -q '^LogBrew\.LogBrewAspNetCoreOptions$' "$tmp_dir/run.out"
grep -q '^LogBrew\.EntityFrameworkCore\.LogBrewEntityFrameworkCoreOptions$' "$tmp_dir/run.out"
grep -q '^LogBrew\.StackExchangeRedis\.LogBrewStackExchangeRedisCommandOptions$' "$tmp_dir/run.out"
if [[ -n "$otel_version" ]]; then
  grep -q '^LogBrew\.OpenTelemetry\.LogBrewOpenTelemetrySpanProcessor$' "$tmp_dir/run.out"
fi

echo "dotnet public NuGet install smoke passed"
