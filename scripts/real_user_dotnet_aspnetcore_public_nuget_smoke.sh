#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
source "$repo_root/scripts/dotnet_verifier_lock.sh"

aspnetcore_version="${1:-${LOGBREW_NUGET_ASPNETCORE_VERSION:-}}"
source_commit="${2:-${LOGBREW_NUGET_SOURCE_COMMIT:-}}"
nuget_source="${LOGBREW_NUGET_SOURCE:-https://api.nuget.org/v3/index.json}"

cleanup() {
  rm -rf "$tmp_dir"
  release_dotnet_verifier_lock
}
trap cleanup EXIT

if [[ ! "$aspnetcore_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: bash scripts/real_user_dotnet_aspnetcore_public_nuget_smoke.sh VERSION [SOURCE_COMMIT]" >&2
  exit 2
fi
if [[ -n "$source_commit" && ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "invalid ASP.NET Core source commit" >&2
  exit 2
fi
if [[ -z "$nuget_source" || "$nuget_source" == *$'\n'* || "$nuget_source" == *$'\r'* ]]; then
  echo "invalid ASP.NET Core package source" >&2
  exit 2
fi
if ! acquire_dotnet_verifier_lock; then
  echo "another .NET SDK verifier run is already in progress" >&2
  exit 1
fi

export NUGET_PACKAGES="$tmp_dir/nuget-packages"
export NUGET_HTTP_CACHE_PATH="$tmp_dir/nuget-http-cache"
export NUGET_PLUGINS_CACHE_PATH="$tmp_dir/nuget-plugin-cache"

app_dir="$tmp_dir/aspnetcore-public-app"
dotnet new web --framework net10.0 --name AspNetCorePublicApp --output "$app_dir" >/dev/null
dotnet add "$app_dir/AspNetCorePublicApp.csproj" package LogBrew.AspNetCore \
  --version "$aspnetcore_version" \
  --source "$nuget_source" >/dev/null

package_path="$NUGET_PACKAGES/logbrew.aspnetcore/$aspnetcore_version/logbrew.aspnetcore.$aspnetcore_version.nupkg"
python3 - "$package_path" "$aspnetcore_version" "$source_commit" <<'PY'
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

package_path = Path(sys.argv[1])
version = sys.argv[2]
source_commit = sys.argv[3]
try:
    with zipfile.ZipFile(package_path) as archive:
        nuspec_names = [name for name in archive.namelist() if name.endswith(".nuspec")]
        if len(nuspec_names) != 1:
            raise ValueError
        root = ET.fromstring(archive.read(nuspec_names[0]))
except (OSError, ET.ParseError, ValueError, zipfile.BadZipFile):
    raise SystemExit("invalid installed ASP.NET Core package") from None

metadata = next((item for item in root if item.tag.split("}", 1)[-1] == "metadata"), None)
if metadata is None:
    raise SystemExit("installed ASP.NET Core package metadata is missing")
values = {item.tag.split("}", 1)[-1]: item for item in metadata}
if values.get("id") is None or values["id"].text != "LogBrew.AspNetCore":
    raise SystemExit("installed ASP.NET Core package id mismatch")
if values.get("version") is None or values["version"].text != version:
    raise SystemExit("installed ASP.NET Core package version mismatch")
repository = values.get("repository")
if (
    repository is None
    or repository.attrib.get("type") != "git"
    or repository.attrib.get("url") != "https://github.com/LogBrewCo/sdk"
):
    raise SystemExit("installed ASP.NET Core package source mismatch")
if source_commit and repository.attrib.get("commit") != source_commit:
    raise SystemExit("installed ASP.NET Core package commit mismatch")
if source_commit and re.fullmatch(r"[0-9a-f]{40}", source_commit) is None:
    raise SystemExit("invalid expected ASP.NET Core package commit")
PY

cat > "$app_dir/Program.cs" <<'CS'
using System.Linq;
using System.Net;
using System.Net.Http;
using LogBrew;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var expectedVersion = args.Single();
var transport = RecordingTransport.AlwaysAccept();
var builder = WebApplication.CreateBuilder(Array.Empty<string>());
builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
builder.Logging.ClearProviders();
builder.AddLogBrew(options => options
    .WithServerApiKey("public-smoke-key")
    .WithServiceName("aspnetcore-public-smoke")
    .WithEnvironment("verification")
    .WithRelease("1.2.3")
    .WithTransport(transport)
    .ConfigureDelivery(delivery =>
    {
        delivery.FlushAtQueueSize = 100;
        delivery.FlushInterval = TimeSpan.FromMinutes(5);
    })
    .ConfigureLogging(logging => logging.MinimumLevel = LogLevel.Warning));

var app = builder.Build();
try
{
    app.UseRouting();
    app.UseLogBrew();
    app.MapGet("/orders/{orderId}", (ILogger<Program> logger, string orderId) =>
    {
        _ = orderId;
        logger.LogWarning("public package request accepted");
        return Results.Accepted();
    });

    await app.StartAsync().ConfigureAwait(false);
    var server = app.Services.GetRequiredService<IServer>();
    var address = server.Features.Get<IServerAddressesFeature>()?.Addresses.SingleOrDefault();
    Require(!string.IsNullOrWhiteSpace(address), "public package server address is missing");
    using var client = new HttpClient();
    using var response = await client.GetAsync(
        address + "/orders/order_123?coupon=dropme").ConfigureAwait(false);
    Require(response.StatusCode == HttpStatusCode.Accepted, "public package changed the app response");

    await app.StopAsync().ConfigureAwait(false);
    var runtime = app.Services.GetRequiredService<LogBrewAspNetCoreRuntime>();
    var health = runtime.Health();
    Require(health.State == "stopped", "public package did not stop its lifecycle");
    Require(health.LastShutdownStatusCode == 202, "public package did not drain on shutdown");
    var payload = string.Join("\n", transport.SentBodies);
    foreach (var expected in new[]
    {
        "\"name\": \"logbrew-dotnet-aspnetcore\"",
        "\"version\": \"" + expectedVersion + "\"",
        "\"type\": \"environment\"",
        "\"type\": \"release\"",
        "\"type\": \"log\"",
        "\"type\": \"span\"",
        "\"type\": \"metric\"",
        "\"name\": \"GET /orders/{orderId}\"",
        "public package request accepted"
    })
    {
        Require(payload.Contains(expected, StringComparison.Ordinal), "public package payload is incomplete");
    }

    foreach (var blocked in new[]
    {
        "order_123",
        "coupon=dropme",
        "public-smoke-key",
        "scope.RequestPath",
        "scope.ConnectionId",
        "scope.RequestId"
    })
    {
        Require(!payload.Contains(blocked, StringComparison.Ordinal), "public package payload crossed its privacy boundary");
    }

    Console.WriteLine("ASP.NET Core public NuGet automatic lifecycle ok");
}
finally
{
    await app.DisposeAsync().ConfigureAwait(false);
}

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
CS

dotnet run --project "$app_dir/AspNetCorePublicApp.csproj" --configuration Release -- "$aspnetcore_version" \
  >"$tmp_dir/run.out" 2>"$tmp_dir/run.err"
grep -qx 'ASP.NET Core public NuGet automatic lifecycle ok' "$tmp_dir/run.out"

echo "LogBrew.AspNetCore $aspnetcore_version public NuGet lifecycle smoke passed"
