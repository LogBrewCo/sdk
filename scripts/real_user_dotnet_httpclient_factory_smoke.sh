#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/dotnet/logbrew-dotnet"
tmp_dir="$(mktemp -d)"
source "$repo_root/scripts/dotnet_verifier_lock.sh"
lock_owned=0

cleanup() {
  find "$package_dir" -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + 2>/dev/null || true
  if [[ "$lock_owned" == "1" ]]; then
    release_dotnet_verifier_lock
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

if [[ "${LOGBREW_DOTNET_VERIFIER_LOCK_HELD:-0}" != "1" ]]; then
  if ! acquire_dotnet_verifier_lock; then
    echo "dotnet HttpClient verifier lock unavailable" >&2
    exit 1
  fi
  lock_owned=1
fi

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export NUGET_PACKAGES="$tmp_dir/nuget-packages"
export NUGET_HTTP_CACHE_PATH="$tmp_dir/nuget-http-cache"
mkdir -p "$tmp_dir/packages"

dotnet pack "$package_dir/src/LogBrew/LogBrew.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
dotnet pack "$package_dir/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null

core_package_version="$(dotnet msbuild "$package_dir/src/LogBrew/LogBrew.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
httpclient_package_version="$(dotnet msbuild "$package_dir/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
core_nupkg="$tmp_dir/packages/LogBrew.${core_package_version}.nupkg"
httpclient_nupkg="$tmp_dir/packages/LogBrew.HttpClient.${httpclient_package_version}.nupkg"
test -f "$core_nupkg"
test -f "$httpclient_nupkg"

httpclient_sha256="$(python3 - "$httpclient_nupkg" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"

python3 - "$httpclient_nupkg" <<'PY'
import re
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    names = set(archive.namelist())
    required = {
        "LogBrew.HttpClient.nuspec",
        "README.md",
        "examples/HttpClientFactoryCorrelation.cs",
        "lib/netstandard2.0/LogBrew.HttpClient.dll",
        "lib/net8.0/LogBrew.HttpClient.dll",
        "logbrew-logo-espresso-bg-128.png",
    }
    if missing := sorted(required - names):
        raise SystemExit(f"missing HttpClient package files: {missing}")
    property_files = {
        name
        for name in names
        if re.fullmatch(r"package/services/metadata/core-properties/[0-9a-f]{32}\.psmdcp", name)
    }
    allowed = required | property_files | {
        "_rels/.rels",
        "[Content_Types].xml",
    }
    if len(property_files) != 1 or names != allowed:
        raise SystemExit("unexpected HttpClient package contents")
    nuspec = archive.read("LogBrew.HttpClient.nuspec").decode("utf-8")
    readme = archive.read("README.md").decode("utf-8")
for dependency in ('id="LogBrew"', 'id="Microsoft.Extensions.Http"'):
    if dependency not in nuspec:
        raise SystemExit("missing HttpClient package dependency")
for guidance in (
    "AddLogBrewCorrelation",
    "active `LogBrewTrace.Current`",
    "does not evaluate its filter",
    "response identity",
    "SDK delivery requests are excluded",
):
    if guidance not in readme:
        raise SystemExit("missing HttpClient package guidance")
PY

app_dir="$tmp_dir/app"
dotnet new console --framework net10.0 --name HttpClientFactorySmoke --output "$app_dir" >/dev/null
dotnet add "$app_dir/HttpClientFactorySmoke.csproj" package LogBrew.HttpClient --version "$httpclient_package_version" --no-restore >/dev/null
grep -q "PackageReference Include=\"LogBrew.HttpClient\" Version=\"$httpclient_package_version\"" "$app_dir/HttpClientFactorySmoke.csproj"

cat > "$app_dir/HttpClientFactorySmoke.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnableNETAnalyzers>true</EnableNETAnalyzers>
    <AnalysisMode>Recommended</AnalysisMode>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="LogBrew.HttpClient" Version="$httpclient_package_version" />
  </ItemGroup>
</Project>
EOF

cat > "$app_dir/Program.cs" <<'CS'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using LogBrew.HttpClient;
using Microsoft.Extensions.DependencyInjection;

const string TraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const string ParentSpanId = "b7ad6b7169203331";
const string CallerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
const string IngestKey = "lbw_ingest_dotnet_httpclient_factory_fake";
var sensitivePath = "/sensitive-order";
var sensitiveQuery = "code=sample";
var sensitiveHeader = "app-owned-header-value";
var sensitiveBody = "app-owned-body-value";

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static int Count(string value, string needle)
{
    var count = 0;
    var index = 0;
    while ((index = value.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
    {
        count++;
        index += needle.Length;
    }

    return count;
}

using var server = new LoopbackServer();
var telemetry = LogBrewClient.Create(IngestKey, "installed-httpclient-correlation", "0.1.0");
var services = new ServiceCollection();
services
    .AddHttpClient("selected-client")
    .AddHttpMessageHandler(() => new RetryOnceHandler())
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler())
    .AddLogBrewCorrelation(
        telemetry,
        options => options
            .WithEventIdPrefix("installed_httpclient")
            .WithTimestampProvider(() => "2026-07-20T10:30:00Z"));
services
    .AddHttpClient("plain-client")
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler());

using var provider = services.BuildServiceProvider();
var factory = provider.GetRequiredService<IHttpClientFactory>();
using var selected = factory.CreateClient("selected-client");
using var plain = factory.CreateClient("plain-client");
var root = LogBrewTraceContext.FromTraceparent(
    "00-" + TraceId + "-00f067aa0ba902b7-01",
    ParentSpanId);

using var selectedRequest = new HttpRequestMessage(
    HttpMethod.Post,
    new Uri(server.BaseUri, sensitivePath + "?" + sensitiveQuery + "#fragment"));
selectedRequest.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
selectedRequest.Headers.TryAddWithoutValidation("x-app-owned", sensitiveHeader);
selectedRequest.Content = new StringContent(sensitiveBody, Encoding.UTF8, "text/plain");
HttpResponseMessage selectedResponse;
using (LogBrewTrace.Activate(root))
{
    selectedResponse = await selected.SendAsync(
        selectedRequest,
        HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
}

using (selectedResponse)
{
    Require(selectedResponse.StatusCode == HttpStatusCode.OK, "selected response");
}

Require(
    selectedRequest.Headers.GetValues("traceparent").Single() == CallerTraceparent,
    "caller traceparent reset");
Require(telemetry.PendingEvents() == 2, "one span per retry execution");

using var noParentRequest = new HttpRequestMessage(HttpMethod.Get, new Uri(server.BaseUri, "/no-parent"));
noParentRequest.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
using (var noParentResponse = await selected.SendAsync(noParentRequest).ConfigureAwait(false))
{
    Require(noParentResponse.StatusCode == HttpStatusCode.OK, "no-parent response");
}

Require(telemetry.PendingEvents() == 2, "no-parent pass-through");
using (LogBrewTrace.Activate(root))
using (var plainResponse = await plain.GetAsync(new Uri(server.BaseUri, "/plain")).ConfigureAwait(false))
{
    Require(plainResponse.StatusCode == HttpStatusCode.OK, "plain response");
}

Require(telemetry.PendingEvents() == 2, "unselected pass-through");
var preview = telemetry.PreviewJson();
Require(Count(preview, "\"type\": \"span\"") == 2, "captured spans");
Require(preview.Contains("\"host\": \"localhost\"", StringComparison.Ordinal), "normalized host");
Require(preview.Contains("\"statusCode\": 503", StringComparison.Ordinal), "retry failure status");
Require(preview.Contains("\"statusCode\": 200", StringComparison.Ordinal), "retry success status");
foreach (var blocked in new[]
{
    sensitivePath,
    sensitiveQuery,
    sensitiveHeader,
    sensitiveBody,
    "selected-client",
    CallerTraceparent,
    "fragment",
    server.BaseUri.Port.ToString(CultureInfo.InvariantCulture)
})
{
    Require(!preview.Contains(blocked, StringComparison.OrdinalIgnoreCase), "privacy boundary");
}

using var transport = new HttpTransport(new HttpTransportOptions
{
    Endpoint = new Uri(server.BaseUri, "/v1/events"),
    HttpClient = selected
});
using (LogBrewTrace.Activate(root))
{
    var delivery = telemetry.Flush(transport);
    Require(delivery.StatusCode == 202, "SDK delivery response");
}

Require(telemetry.PendingEvents() == 0, "SDK delivery self-correlation");
await server.WaitForRequests(5).ConfigureAwait(false);
var requests = server.Requests;
Require(requests.Count == 5, "loopback request count");
var retryRequests = requests.Where(request => request.Path.StartsWith(sensitivePath, StringComparison.Ordinal)).ToList();
Require(retryRequests.Count == 2, "retry request count");
Require(retryRequests.All(request => request.Traceparent.StartsWith("00-" + TraceId + "-", StringComparison.Ordinal)), "retry trace id");
Require(retryRequests.Select(request => request.Traceparent).Distinct(StringComparer.Ordinal).Count() == 2, "retry child identity");
Require(requests.Single(request => request.Path == "/no-parent").Traceparent == CallerTraceparent, "no-parent header");
Require(requests.Single(request => request.Path == "/plain").Traceparent.Length == 0, "plain header");
var intake = requests.Single(request => request.Path == "/v1/events");
Require(intake.Traceparent.Length == 0, "SDK delivery traceparent");
Require(intake.Authorization == "Bearer " + IngestKey, "SDK delivery authentication");
Require(Count(intake.Body, "\"type\": \"span\"") == 2, "intake span count");
Require(!intake.Body.Contains(IngestKey, StringComparison.Ordinal), "ingest key body privacy");

Console.WriteLine("{\"ok\":true,\"requests\":5,\"sdkDeliveryRequests\":1}");

internal sealed class RetryOnceHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var first = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (first.StatusCode != HttpStatusCode.ServiceUnavailable)
        {
            return first;
        }

        first.Dispose();
        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}

internal sealed class RecordedRequest
{
    internal RecordedRequest(string path, string traceparent, string authorization, string body)
    {
        Path = path;
        Traceparent = traceparent;
        Authorization = authorization;
        Body = body;
    }

    internal string Path { get; }

    internal string Traceparent { get; }

    internal string Authorization { get; }

    internal string Body { get; }
}

internal sealed class LoopbackServer : IDisposable
{
    private readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
    private readonly Task acceptTask;
    private readonly List<RecordedRequest> requests = new List<RecordedRequest>();

    internal LoopbackServer()
    {
        listener.Start();
        BaseUri = new Uri(
            "http://localhost:" + ((IPEndPoint)listener.LocalEndpoint).Port.ToString(CultureInfo.InvariantCulture),
            UriKind.Absolute);
        acceptTask = AcceptLoop();
    }

    internal Uri BaseUri { get; }

    internal IReadOnlyList<RecordedRequest> Requests
    {
        get
        {
            lock (requests)
            {
                return requests.ToArray();
            }
        }
    }

    internal async Task WaitForRequests(int count)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (Requests.Count < count && DateTime.UtcNow < deadline)
        {
            await Task.Delay(10).ConfigureAwait(false);
        }
    }

    public void Dispose()
    {
        cancellation.Cancel();
        listener.Stop();
        try
        {
            acceptTask.GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
        }

        cancellation.Dispose();
    }

    private async Task AcceptLoop()
    {
        while (!cancellation.IsCancellationRequested)
        {
            TcpClient? socket = null;
            try
            {
                socket = await listener.AcceptTcpClientAsync(cancellation.Token).ConfigureAwait(false);
                await Handle(socket).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                return;
            }
            catch (SocketException) when (cancellation.IsCancellationRequested)
            {
                return;
            }
            finally
            {
                socket?.Dispose();
            }
        }
    }

    private async Task Handle(TcpClient socket)
    {
        using var stream = socket.GetStream();
        using var reader = new StreamReader(
            stream,
            Encoding.ASCII,
            detectEncodingFromByteOrderMarks: false,
            bufferSize: 1024,
            leaveOpen: true);
        var requestLine = await reader.ReadLineAsync().ConfigureAwait(false) ?? string.Empty;
        var requestParts = requestLine.Split(' ');
        var path = requestParts.Length > 1 ? requestParts[1] : string.Empty;
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        while (true)
        {
            var line = await reader.ReadLineAsync().ConfigureAwait(false);
            if (string.IsNullOrEmpty(line))
            {
                break;
            }

            var separator = line.IndexOf(':');
            if (separator > 0)
            {
                headers[line.Substring(0, separator).Trim()] = line.Substring(separator + 1).Trim();
            }
        }

        var contentLength = headers.TryGetValue("content-length", out var contentLengthValue)
            && int.TryParse(contentLengthValue, NumberStyles.None, CultureInfo.InvariantCulture, out var parsedLength)
                ? parsedLength
                : 0;
        var bodyBuffer = new char[contentLength];
        var bodyLength = 0;
        while (bodyLength < contentLength)
        {
            var read = await reader.ReadAsync(bodyBuffer, bodyLength, contentLength - bodyLength).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            bodyLength += read;
        }

        var traceparent = headers.TryGetValue("traceparent", out var traceValue) ? traceValue : string.Empty;
        var authorization = headers.TryGetValue("authorization", out var authValue) ? authValue : string.Empty;
        int requestNumber;
        lock (requests)
        {
            requests.Add(new RecordedRequest(path, traceparent, authorization, new string(bodyBuffer, 0, bodyLength)));
            requestNumber = requests.Count;
        }

        var status = path == "/v1/events" ? 202 : requestNumber == 1 ? 503 : 200;
        var reason = status == 202 ? "Accepted" : status == 503 ? "Service Unavailable" : "OK";
        var response = "HTTP/1.1 "
            + status.ToString(CultureInfo.InvariantCulture)
            + " "
            + reason
            + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        var responseBytes = Encoding.ASCII.GetBytes(response);
        await stream.WriteAsync(responseBytes, cancellation.Token).ConfigureAwait(false);
    }
}
CS

cat > "$tmp_dir/NuGet.Config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="$tmp_dir/packages" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
EOF

dotnet restore "$app_dir/HttpClientFactorySmoke.csproj" --configfile "$tmp_dir/NuGet.Config" --no-cache >/dev/null
dotnet build "$app_dir/HttpClientFactorySmoke.csproj" --configuration Release --no-restore -warnaserror >/dev/null

if ! python3 - "$app_dir" "$tmp_dir/app.stdout" "$tmp_dir/app.stderr" <<'PY'
import pathlib
import subprocess
import sys

app_dir, stdout_path, stderr_path = sys.argv[1:]
with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
    try:
        result = subprocess.run(
            ["dotnet", "run", "--project", app_dir, "--configuration", "Release", "--no-build", "--no-restore"],
            stdout=stdout,
            stderr=stderr,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit(1)
if result.returncode != 0:
    raise SystemExit(1)
if pathlib.Path(stdout_path).read_text() != '{"ok":true,"requests":5,"sdkDeliveryRequests":1}\n':
    raise SystemExit(1)
if pathlib.Path(stderr_path).read_bytes():
    raise SystemExit(1)
PY
then
  echo "installed HttpClient correlation smoke failed" >&2
  exit 1
fi

printf 'dotnet HttpClient factory installed smoke passed version=%s core=%s sha256=%s requests=5\n' \
  "$httpclient_package_version" \
  "$core_package_version" \
  "$httpclient_sha256"
