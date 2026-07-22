#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
source "$repo_root/scripts/dotnet_verifier_lock.sh"

core_version="${1:-${LOGBREW_NUGET_CORE_VERSION:-${LOGBREW_DOTNET_CORE_VERSION:-0.1.4}}}"
aspnetcore_version="${2:-${LOGBREW_NUGET_ASPNETCORE_VERSION:-${LOGBREW_DOTNET_ASPNETCORE_VERSION:-0.1.0}}}"
efcore_version="${3:-${LOGBREW_NUGET_EFCORE_VERSION:-${LOGBREW_DOTNET_EFCORE_VERSION:-0.1.0}}}"
httpclient_version="${4:-${LOGBREW_NUGET_HTTPCLIENT_VERSION:-${LOGBREW_DOTNET_HTTPCLIENT_VERSION:-0.1.0}}}"
redis_version="${5:-${LOGBREW_NUGET_REDIS_VERSION:-${LOGBREW_DOTNET_REDIS_VERSION:-0.1.0}}}"
otel_version="${6:-${LOGBREW_NUGET_OTEL_VERSION:-${LOGBREW_DOTNET_OTEL_VERSION:-}}}"
source_commit="${7:-${LOGBREW_NUGET_SOURCE_COMMIT:-}}"
httpclient_content_sha256="${8:-${LOGBREW_NUGET_HTTPCLIENT_CONTENT_SHA256:-}}"

cleanup() {
  rm -rf "$tmp_dir"
  release_dotnet_verifier_lock
}

require_version() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "missing required $label version" >&2
    echo "usage: bash scripts/real_user_dotnet_public_nuget_smoke.sh [LogBrew] [LogBrew.AspNetCore] [LogBrew.EntityFrameworkCore] [LogBrew.HttpClient] [LogBrew.StackExchangeRedis] [LogBrew.OpenTelemetry] [source commit] [HttpClient SHA-256]" >&2
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
require_version "LogBrew.HttpClient" "$httpclient_version"
require_version "LogBrew.StackExchangeRedis" "$redis_version"

export NUGET_PACKAGES="$tmp_dir/nuget-packages"
export NUGET_HTTP_CACHE_PATH="$tmp_dir/nuget-http-cache"

app_dir="$tmp_dir/dotnet-public-nuget-app"
dotnet new console --framework net10.0 --name DotnetPublicNuGetApp --output "$app_dir" >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew --version "$core_version" --source https://api.nuget.org/v3/index.json >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.AspNetCore --version "$aspnetcore_version" --source https://api.nuget.org/v3/index.json >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.EntityFrameworkCore --version "$efcore_version" --source https://api.nuget.org/v3/index.json >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.HttpClient --version "$httpclient_version" --source https://api.nuget.org/v3/index.json >/dev/null
dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.StackExchangeRedis --version "$redis_version" --source https://api.nuget.org/v3/index.json >/dev/null
if [[ -n "$otel_version" ]]; then
  dotnet add "$app_dir/DotnetPublicNuGetApp.csproj" package LogBrew.OpenTelemetry --version "$otel_version" --source https://api.nuget.org/v3/index.json >/dev/null
fi

dotnet list "$app_dir/DotnetPublicNuGetApp.csproj" package > "$tmp_dir/packages.txt"
require_package_line "LogBrew" "$core_version"
require_package_line "LogBrew.AspNetCore" "$aspnetcore_version"
require_package_line "LogBrew.EntityFrameworkCore" "$efcore_version"
require_package_line "LogBrew.HttpClient" "$httpclient_version"
require_package_line "LogBrew.StackExchangeRedis" "$redis_version"
if [[ -n "$otel_version" ]]; then
  require_package_line "LogBrew.OpenTelemetry" "$otel_version"
fi

httpclient_digests="$(python3 - "$repo_root/scripts" "$NUGET_PACKAGES/logbrew.httpclient/$httpclient_version/logbrew.httpclient.$httpclient_version.nupkg" "$source_commit" "$httpclient_content_sha256" <<'PY'
import hashlib
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from check_dotnet_release_artifacts import package_content_sha256

package_path = Path(sys.argv[2])
source_commit = sys.argv[3]
expected_content_digest = sys.argv[4]
if source_commit and re.fullmatch(r"[0-9a-f]{40}", source_commit) is None:
    raise SystemExit("invalid expected source commit")
if expected_content_digest and re.fullmatch(r"[0-9a-f]{64}", expected_content_digest) is None:
    raise SystemExit("invalid expected HttpClient content digest")

try:
    package_bytes = package_path.read_bytes()
    with zipfile.ZipFile(package_path) as archive:
        nuspec_names = [name for name in archive.namelist() if name.endswith(".nuspec")]
        if len(nuspec_names) != 1:
            raise ValueError
        root = ET.fromstring(archive.read(nuspec_names[0]))
except (OSError, ET.ParseError, ValueError, zipfile.BadZipFile):
    raise SystemExit("invalid installed HttpClient package") from None

metadata = next((item for item in root if item.tag.split("}", 1)[-1] == "metadata"), None)
repository = None if metadata is None else next(
    (item for item in metadata if item.tag.split("}", 1)[-1] == "repository"),
    None,
)
if (
    repository is None
    or repository.attrib.get("type") != "git"
    or repository.attrib.get("url") != "https://github.com/LogBrewCo/sdk"
):
    raise SystemExit("installed HttpClient package source mismatch")
if source_commit and repository.attrib.get("commit") != source_commit:
    raise SystemExit("installed HttpClient package commit mismatch")

digest = hashlib.sha256(package_bytes).hexdigest()
try:
    content_digest = package_content_sha256(package_path)
except (OSError, RuntimeError, ValueError, zipfile.BadZipFile):
    raise SystemExit("invalid installed HttpClient package content") from None
if expected_content_digest and content_digest != expected_content_digest:
    raise SystemExit("installed HttpClient package content digest mismatch")
print(digest, content_digest)
PY
)"
read -r httpclient_digest installed_content_digest <<< "$httpclient_digests"

cat > "$app_dir/Program.cs" <<'CS'
using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using LogBrew.EntityFrameworkCore;
using LogBrew.HttpClient;
using LogBrew.StackExchangeRedis;
using Microsoft.Extensions.DependencyInjection;

const string CallerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

var client = LogBrewClient.Create("LOGBREW_API_KEY", "public-nuget-smoke", "0.1.0", maxRetries: 1, maxQueueSize: 2);
client.Log("evt_public_nuget_smoke", "2026-06-30T16:00:00Z", LogAttributes.Create("public package smoke", "info"));

var aspnetCoreOptions = LogBrewAspNetCoreOptions.Create();
var efCoreOptions = LogBrewEntityFrameworkCoreOptions.Create();
var redisOptions = LogBrewStackExchangeRedisCommandOptions.Create();
var observedTraceparent = string.Empty;
using var expectedResponse = new HttpResponseMessage(HttpStatusCode.NoContent);
var services = new ServiceCollection();
services
    .AddHttpClient("release-receipt")
    .ConfigurePrimaryHttpMessageHandler(() => new ReceiptHandler(request =>
    {
        observedTraceparent = request.Headers.GetValues("traceparent").Single();
        return expectedResponse;
    }))
    .AddLogBrewCorrelation(client);
using var provider = services.BuildServiceProvider();
var factory = provider.GetRequiredService<IHttpClientFactory>();
using var request = new HttpRequestMessage(HttpMethod.Get, new Uri("https://release.example.test/receipt", UriKind.Absolute));
request.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
HttpResponseMessage response;
using (LogBrewTrace.Activate(LogBrewTraceContext.CreateRoot()))
{
    using var selected = factory.CreateClient("release-receipt");
    response = await selected.SendAsync(request);
}

Require(ReferenceEquals(response, expectedResponse), "selected client changed response identity");
Require(observedTraceparent.Length == 55 && observedTraceparent.StartsWith("00-", StringComparison.Ordinal), "selected client did not inject W3C correlation");
Require(observedTraceparent != CallerTraceparent, "selected client retained the caller traceparent");
Require(request.Headers.GetValues("traceparent").Single() == CallerTraceparent, "selected client did not reset caller header state");
Require(client.PendingEvents() == 2, "selected client did not retain exactly one completion span");

Console.WriteLine(client.PendingEvents());
Console.WriteLine(aspnetCoreOptions.GetType().FullName);
Console.WriteLine(efCoreOptions.GetType().FullName);
Console.WriteLine(redisOptions.GetType().FullName);
Console.WriteLine("LogBrew.HttpClient selected-client receipt");
CS

if [[ -n "$otel_version" ]]; then
  cat >> "$app_dir/Program.cs" <<'CS'
var otelProcessor = new LogBrew.OpenTelemetry.LogBrewOpenTelemetrySpanProcessor(client);
using var otelExporter = new LogBrew.OpenTelemetry.LogBrewOpenTelemetrySpanExporter(client);
Console.WriteLine(otelProcessor.GetType().FullName);
Console.WriteLine(otelExporter.GetType().FullName);
CS
fi

cat >> "$app_dir/Program.cs" <<'CS'

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

sealed class ReceiptHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> send;

    internal ReceiptHandler(Func<HttpRequestMessage, HttpResponseMessage> send)
    {
        this.send = send;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        return Task.FromResult(send(request));
    }
}
CS

dotnet build "$app_dir/DotnetPublicNuGetApp.csproj" --configuration Release --no-restore >/dev/null
dotnet run --project "$app_dir/DotnetPublicNuGetApp.csproj" --configuration Release --no-build > "$tmp_dir/run.out"

grep -qx '2' "$tmp_dir/run.out"
grep -q '^LogBrew\.LogBrewAspNetCoreOptions$' "$tmp_dir/run.out"
grep -q '^LogBrew\.EntityFrameworkCore\.LogBrewEntityFrameworkCoreOptions$' "$tmp_dir/run.out"
grep -q '^LogBrew\.StackExchangeRedis\.LogBrewStackExchangeRedisCommandOptions$' "$tmp_dir/run.out"
grep -q '^LogBrew\.HttpClient selected-client receipt$' "$tmp_dir/run.out"
if [[ -n "$otel_version" ]]; then
  grep -q '^LogBrew\.OpenTelemetry\.LogBrewOpenTelemetrySpanProcessor$' "$tmp_dir/run.out"
  grep -q '^LogBrew\.OpenTelemetry\.LogBrewOpenTelemetrySpanExporter$' "$tmp_dir/run.out"
fi

echo "LogBrew.HttpClient $httpclient_version sha256 $httpclient_digest content_sha256 $installed_content_digest"
echo "dotnet public NuGet install smoke passed"
