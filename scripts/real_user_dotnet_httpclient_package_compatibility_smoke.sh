#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
source "$repo_root/scripts/dotnet_verifier_lock.sh"

core_version="${1:-}"
httpclient_version="${2:-}"
source_commit="${3:-}"
expected_content_sha256="${4:-}"
package_source="${LOGBREW_NUGET_SOURCE:-https://api.nuget.org/v3/index.json}"
public_source="https://api.nuget.org/v3/index.json"

cleanup() {
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$tmp_dir"
  release_dotnet_verifier_lock
}

trap cleanup EXIT

if ! acquire_dotnet_verifier_lock; then
  echo "another .NET SDK verifier run is already in progress" >&2
  exit 1
fi

if [[ ! "$core_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid LogBrew package version" >&2
  exit 2
fi
if [[ ! "$httpclient_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid LogBrew.HttpClient package version" >&2
  exit 2
fi
if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "invalid package source commit" >&2
  exit 2
fi
if [[ ! "$expected_content_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "invalid package content digest" >&2
  exit 2
fi

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) runtime_id="osx-arm64" ;;
  Darwin:x86_64) runtime_id="osx-x64" ;;
  Linux:aarch64 | Linux:arm64) runtime_id="linux-arm64" ;;
  Linux:x86_64) runtime_id="linux-x64" ;;
  *)
    echo "unsupported NativeAOT verifier platform" >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! command -v brew >/dev/null; then
    echo "NativeAOT verifier dependencies unavailable" >&2
    exit 2
  fi
  openssl_prefix="$(brew --prefix openssl@3 2>/dev/null || true)"
  brotli_prefix="$(brew --prefix brotli 2>/dev/null || true)"
  if [[ ! -f "$openssl_prefix/lib/libssl.a" || ! -f "$openssl_prefix/lib/libcrypto.a" \
    || ! -f "$brotli_prefix/lib/libbrotlienc.a" \
    || ! -f "$brotli_prefix/lib/libbrotlidec.a" \
    || ! -f "$brotli_prefix/lib/libbrotlicommon.a" ]]; then
    echo "NativeAOT verifier dependencies unavailable" >&2
    exit 2
  fi
  export LIBRARY_PATH="$openssl_prefix/lib:$brotli_prefix/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
fi

export NUGET_PACKAGES="$tmp_dir/nuget-packages"
app_dir="$tmp_dir/httpclient-compatibility"
mkdir -p "$app_dir"

cat > "$app_dir/HttpClientCompatibility.csproj" <<CS
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="LogBrew" Version="$core_version" />
    <PackageReference Include="LogBrew.HttpClient" Version="$httpclient_version" />
  </ItemGroup>
</Project>
CS

cat > "$app_dir/Program.cs" <<'CS'
using System.Net;
using System.Net.Http;
using System.Reflection;
using LogBrew;
using LogBrew.HttpClient;
using Microsoft.Extensions.DependencyInjection;

const string CallerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

var client = LogBrewClient.Create("LOGBREW_API_KEY", "package-compatibility", "0.1.0", maxQueueSize: 1);
using var expectedResponse = new HttpResponseMessage(HttpStatusCode.NoContent);
var observedTraceparent = string.Empty;
var services = new ServiceCollection();
services
    .AddHttpClient("package-compatibility")
    .ConfigurePrimaryHttpMessageHandler(() => new ReceiptHandler(request =>
    {
        observedTraceparent = request.Headers.GetValues("traceparent").Single();
        return expectedResponse;
    }))
    .AddLogBrewCorrelation(client);

using var provider = services.BuildServiceProvider();
using var request = new HttpRequestMessage(HttpMethod.Get, "https://compatibility.example.test/receipt");
request.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
HttpResponseMessage response;
using (LogBrewTrace.Activate(LogBrewTraceContext.CreateRoot()))
{
    using var selected = provider.GetRequiredService<IHttpClientFactory>().CreateClient("package-compatibility");
    response = await selected.SendAsync(request);
}

Require(ReferenceEquals(response, expectedResponse), "selected client changed response identity");
Require(observedTraceparent.Length == 55, "selected client did not inject W3C correlation");
Require(observedTraceparent != CallerTraceparent, "selected client retained caller correlation");
Require(request.Headers.GetValues("traceparent").Single() == CallerTraceparent, "caller header state changed");
Require(client.PendingEvents() == 1, "selected client did not retain one completion span");
Require(PublicKeyToken(typeof(LogBrewClient).Assembly) == "unsigned", "core assembly identity changed");
Require(
    PublicKeyToken(typeof(LogBrewHttpClientFactoryOptions).Assembly) == "unsigned",
    "HttpClient assembly identity changed");

Console.WriteLine("LogBrew.HttpClient selected-client receipt");
Console.WriteLine("assembly identity unsigned");

static string PublicKeyToken(Assembly assembly)
{
    var token = assembly.GetName().GetPublicKeyToken();
    return token == null || token.Length == 0 ? "unsigned" : Convert.ToHexString(token).ToLowerInvariant();
}

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

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        return Task.FromResult(send(request));
    }
}
CS

restore_sources=(--source "$package_source")
if [[ "$package_source" != "$public_source" ]]; then
  restore_sources+=(--source "$public_source")
fi

dotnet restore "$app_dir/HttpClientCompatibility.csproj" \
  --runtime "$runtime_id" \
  "${restore_sources[@]}" >/dev/null

installed_package="$NUGET_PACKAGES/logbrew.httpclient/$httpclient_version/logbrew.httpclient.$httpclient_version.nupkg"
package_digests="$(python3 - "$repo_root/scripts" "$installed_package" "$httpclient_version" "$source_commit" "$expected_content_sha256" "$core_version" <<'PY'
import hashlib
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from check_dotnet_release_artifacts import package_content_sha256
from release_metadata_dotnet import compatible_dependency_range

package_path = Path(sys.argv[2])
expected_version = sys.argv[3]
source_commit = sys.argv[4]
expected_content = sys.argv[5]
core_version = sys.argv[6]
expected_range = compatible_dependency_range(core_version)

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
if metadata is None:
    raise SystemExit("installed HttpClient package metadata mismatch")
def value(name: str) -> str | None:
    return next(
        (item.text for item in metadata if item.tag.split("}", 1)[-1] == name),
        None,
    )


repository = next(
    (item for item in metadata if item.tag.split("}", 1)[-1] == "repository"),
    None,
)
dependencies = next(
    (item for item in metadata if item.tag.split("}", 1)[-1] == "dependencies"),
    None,
)
if value("id") != "LogBrew.HttpClient" or value("version") != expected_version:
    raise SystemExit("installed HttpClient package identity mismatch")
if (
    repository is None
    or repository.attrib.get("type") != "git"
    or repository.attrib.get("url") != "https://github.com/LogBrewCo/sdk"
    or repository.attrib.get("commit") != source_commit
):
    raise SystemExit("installed HttpClient package source mismatch")
if dependencies is None:
    raise SystemExit("installed HttpClient package dependency mismatch")
groups = [item for item in dependencies if item.tag.split("}", 1)[-1] == "group"]
if not groups:
    raise SystemExit("installed HttpClient package dependency mismatch")
for group in groups:
    matches = [
        item
        for item in group
        if item.tag.split("}", 1)[-1] == "dependency"
        and item.attrib.get("id") == "LogBrew"
    ]
    if len(matches) != 1 or matches[0].attrib.get("version") != expected_range:
        raise SystemExit("installed HttpClient package dependency mismatch")

raw_digest = hashlib.sha256(package_bytes).hexdigest()
content_digest = package_content_sha256(package_path)
if content_digest != expected_content:
    raise SystemExit("installed HttpClient package content digest mismatch")
print(raw_digest, content_digest)
PY
)"
read -r raw_digest content_digest <<< "$package_digests"

dotnet build "$app_dir/HttpClientCompatibility.csproj" \
  --configuration Release \
  --no-restore >/dev/null
dotnet run --project "$app_dir/HttpClientCompatibility.csproj" \
  --configuration Release \
  --no-build \
  --no-restore > "$tmp_dir/jit.out"

publish_dir="$tmp_dir/native-aot"
dotnet publish "$app_dir/HttpClientCompatibility.csproj" \
  --configuration Release \
  --runtime "$runtime_id" \
  --self-contained true \
  --no-restore \
  -p:PublishAot=true \
  --output "$publish_dir" >/dev/null
native_binary="$publish_dir/HttpClientCompatibility"
native_format="$(file -b "$native_binary" 2>/dev/null || true)"
case "$(uname -s)" in
  Darwin) native_pattern='Mach-O 64-bit executable' ;;
  Linux) native_pattern='ELF 64-bit .* executable' ;;
esac
if [[ ! -x "$native_binary" || ! "$native_format" =~ $native_pattern ]]; then
  echo "NativeAOT publish did not produce a native executable" >&2
  exit 1
fi
"$native_binary" > "$tmp_dir/aot.out"

cmp "$tmp_dir/jit.out" "$tmp_dir/aot.out"
grep -qx 'LogBrew.HttpClient selected-client receipt' "$tmp_dir/jit.out"
grep -qx 'assembly identity unsigned' "$tmp_dir/jit.out"

echo "LogBrew.HttpClient $httpclient_version sha256 $raw_digest content_sha256 $content_digest"
echo "dotnet HttpClient JIT and NativeAOT installed compatibility passed"
