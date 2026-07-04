#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/dotnet/logbrew-dotnet"
tmp_dir="$(mktemp -d)"
source "$repo_root/scripts/dotnet_verifier_lock.sh"

clean_generated_artifacts() {
  find "$package_dir" -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + 2>/dev/null || true
}

cleanup() {
  rm -rf "$tmp_dir"
  clean_generated_artifacts
  release_dotnet_verifier_lock
}

trap cleanup EXIT

if ! acquire_dotnet_verifier_lock; then
  echo "another .NET SDK verifier run is already in progress" >&2
  exit 1
fi

dotnet pack "$package_dir/src/LogBrew/LogBrew.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
dotnet pack "$package_dir/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
package_version="$(dotnet msbuild "$package_dir/src/LogBrew/LogBrew.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
otel_package_version="$(dotnet msbuild "$package_dir/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
test -f "$tmp_dir/packages/LogBrew.${package_version}.nupkg"
test -f "$tmp_dir/packages/LogBrew.OpenTelemetry.${otel_package_version}.nupkg"

export NUGET_PACKAGES="$tmp_dir/nuget-packages"
cat > "$tmp_dir/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local-logbrew" value="$tmp_dir/packages" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
EOF

app_dir="$tmp_dir/dotnet-opentelemetry-high-load-app"
dotnet new console --framework net10.0 --name DotnetOpenTelemetryHighLoadApp --output "$app_dir" >/dev/null
dotnet add "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj" package LogBrew --version "$package_version" >/dev/null
dotnet add "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj" package LogBrew.OpenTelemetry --version "$otel_package_version" >/dev/null
dotnet remove "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj" package LogBrew.OpenTelemetry >/dev/null
if grep -q 'PackageReference Include="LogBrew.OpenTelemetry"' "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj"; then
  echo "expected dotnet remove package to remove LogBrew.OpenTelemetry reference" >&2
  exit 1
fi
dotnet add "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj" package LogBrew.OpenTelemetry --version "$otel_package_version" >/dev/null
grep -q "PackageReference Include=\"LogBrew\" Version=\"$package_version\"" "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj"
grep -q "PackageReference Include=\"LogBrew.OpenTelemetry\" Version=\"$otel_package_version\"" "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj"

cat > "$app_dir/Program.cs" <<'CS'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using LogBrew.OpenTelemetry;
using OpenTelemetry;
using OpenTelemetry.Trace;

const string ApiKey = "lbw_ingest_dotnet_otel_high_load_fake";
const int HighVolumeSpans = 1500;
const int MaxQueueSize = 1000;
const string SourceName = "LogBrew.Smoke.DotNet.OpenTelemetry.HighLoad";

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static int CountOccurrences(string value, string needle)
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

static string Timestamp(int offsetSeconds)
{
    return DateTimeOffset.Parse("2026-06-02T10:00:00Z", CultureInfo.InvariantCulture)
        .AddSeconds(offsetSeconds)
        .ToString("O", CultureInfo.InvariantCulture);
}

var drops = new List<DroppedEvent>();
var client = LogBrewClient.Create(
    ApiKey,
    "dotnet-opentelemetry-high-load-smoke",
    "0.1.0",
    maxRetries: 1,
    maxQueueSize: MaxQueueSize,
    onEventDropped: drops.Add);

using var source = new ActivitySource(SourceName, "1.2.3");
using (Sdk.CreateTracerProviderBuilder()
    .AddSource(SourceName)
    .AddLogBrew(client, options => options
        .WithEventIdPrefix("dotnet_otel_high_load")
        .WithServiceName("checkout-api")
        .WithServiceVersion("1.2.3")
        .WithDeploymentEnvironment("production")
        .WithTimestampProvider(() => Timestamp(30))
        .WithMetadata(new Dictionary<string, object?>
        {
            ["component"] = "checkout",
            ["authorization"] = "Bearer omitted",
            ["query"] = "coupon=private",
            ["safe"] = true
        }))
    .Build())
{
    for (var index = 0; index < HighVolumeSpans; index++)
    {
        using var activity = source.StartActivity("GET /checkout/{id}", ActivityKind.Client);
        Require(activity != null, "expected sampled OpenTelemetry activity");
        activity!.SetTag("http.request.method", "GET");
        activity.SetTag("http.route", "/checkout/{id}");
        activity.SetTag("http.response.status_code", index == 0 ? 503 : 200);
        activity.SetTag("service.name", "checkout-api");
        activity.SetTag("service.instance.id", "instance-opaque-marker");
        activity.SetTag("deployment.environment.name", "production");
        activity.SetTag("telemetry.sdk.name", "opentelemetry");
        activity.SetTag("url.full", "https://example.test/checkout/123?coupon=private#fragment");
        activity.SetTag("message", "omitted payload " + index.ToString(CultureInfo.InvariantCulture));
        if (index == 0)
        {
            activity.AddEvent(new ActivityEvent(
                "exception",
                tags: new ActivityTagsCollection
                {
                    ["exception.type"] = "System.TimeoutException",
                    ["exception.message"] = "private timeout message",
                    ["exception.stacktrace"] = "private stack",
                    ["exception.escaped"] = true
                }));
        }
    }
}

var expectedDrops = HighVolumeSpans - MaxQueueSize;
Require(client.PendingEvents() == MaxQueueSize, "expected bounded OpenTelemetry queue size");
Require(client.DroppedEvents() == expectedDrops, "expected OpenTelemetry dropped event count");
Require(drops.Count == expectedDrops, "expected OpenTelemetry drop callback count");
Require(drops[0].EventType == "span", "expected first dropped OpenTelemetry event type");
Require(drops[0].Reason == "queue_overflow", "expected first dropped OpenTelemetry drop reason");
Require(drops[0].DroppedEvents == 1, "expected first OpenTelemetry dropped count");
Require(drops.TrueForAll(drop => drop.Reason == "queue_overflow"), "expected every OpenTelemetry drop to be queue overflow");

var unsafeTexts = new[]
{
    ApiKey,
    "authorization",
    "Bearer omitted",
    "coupon=private",
    "example.test",
    "#fragment",
    "omitted payload",
    "instance-opaque-marker",
    "service.instance.id",
    "url.full",
    "exception.message",
    "exception.stacktrace",
    "private timeout message",
    "private stack"
};

var preview = client.PreviewJson();
Require(CountOccurrences(preview, "\"type\": \"span\"") == MaxQueueSize, "expected accepted OpenTelemetry span count");
foreach (var expected in new[]
{
    "\"id\": \"dotnet_otel_high_load_span_",
    "\"name\": \"GET /checkout/{id}\"",
    "\"source\": \"dotnet.activity\"",
    "\"activityKind\": \"client\"",
    "\"activitySourceName\": \"" + SourceName + "\"",
    "\"activitySourceVersion\": \"1.2.3\"",
    "\"httpMethod\": \"GET\"",
    "\"httpRoute\": \"/checkout/{id}\"",
    "\"httpStatusCode\": 503",
    "\"status\": \"error\"",
    "\"serviceName\": \"checkout-api\"",
    "\"serviceVersion\": \"1.2.3\"",
    "\"deploymentEnvironment\": \"production\"",
    "\"telemetrySdkName\": \"opentelemetry\"",
    "\"otel.exception_event_count\": 1",
    "\"otel.exception_escaped_count\": 1",
    "\"otel.exception_types\": \"System.TimeoutException\"",
    "\"exceptionType\": \"System.TimeoutException\"",
    "\"exceptionEscaped\": true",
    "\"safe\": true"
})
{
    Require(preview.Contains(expected, StringComparison.Ordinal), "missing OpenTelemetry high-load payload: " + expected);
}

foreach (var unsafeText in unsafeTexts)
{
    Require(!preview.Contains(unsafeText, StringComparison.Ordinal), "expected preview to omit " + unsafeText);
}

using var intake = FakeIntake.Start();
var response = client.Flush(new HttpTransport(new HttpTransportOptions
{
    Endpoint = new Uri("http://127.0.0.1:" + intake.Port.ToString(CultureInfo.InvariantCulture) + "/v1/events"),
    Headers = new Dictionary<string, string> { ["x-logbrew-source"] = "dotnet-otel-high-load-smoke" },
    Timeout = TimeSpan.FromSeconds(5)
}));

Require(response.StatusCode == 202, "expected retry flush status");
Require(response.Attempts == 2, "expected retry attempts");
Require(intake.RequestCount == 2, "expected fake intake retry count");
Require(client.PendingEvents() == 0, "expected OpenTelemetry queue after flush");
Require(client.DroppedEvents() == expectedDrops, "expected OpenTelemetry drop count to survive flush");

var body = intake.LastBody;
Require(CountOccurrences(body, "\"type\": \"span\"") == MaxQueueSize, "expected flushed OpenTelemetry span count");
Require(body.Contains("\"name\": \"dotnet-opentelemetry-high-load-smoke\"", StringComparison.Ordinal), "expected sdk name");
Require(body.Contains("\"source\": \"dotnet.activity\"", StringComparison.Ordinal), "expected Activity source marker");
Require(body.Contains("\"serviceName\": \"checkout-api\"", StringComparison.Ordinal), "expected service correlation");
Require(body.Contains("\"deploymentEnvironment\": \"production\"", StringComparison.Ordinal), "expected environment correlation");
foreach (var unsafeText in unsafeTexts)
{
    Require(!body.Contains(unsafeText, StringComparison.Ordinal), "expected flushed body to omit " + unsafeText);
}

var exporterErrors = new List<string>();
var closedClient = LogBrewClient.Create(ApiKey, "dotnet-opentelemetry-closed-exporter-smoke", "0.1.0");
closedClient.Shutdown(RecordingTransport.AlwaysAccept());
using var exporter = new LogBrewOpenTelemetrySpanExporter(
    closedClient,
    options => options.OnError(error => exporterErrors.Add(error.Code)));
using var closedActivity = new Activity("operation after shutdown");
closedActivity.SetIdFormat(ActivityIdFormat.W3C);
closedActivity.ActivityTraceFlags = ActivityTraceFlags.Recorded;
closedActivity.Start();
closedActivity.Stop();
var exporterResult = exporter.Export(new Batch<Activity>(closedActivity));
Require(exporterResult == ExportResult.Failure, "expected closed-client exporter failure");
Require(exporterErrors.Count == 1, "expected one exporter shutdown error");
Require(exporterErrors[0] == "shutdown_error", "expected exporter shutdown error code");

Console.WriteLine("{"
    + "\"ok\":true,"
    + "\"droppedEvents\":" + client.DroppedEvents().ToString(CultureInfo.InvariantCulture) + ","
    + "\"flushedSpans\":" + MaxQueueSize.ToString(CultureInfo.InvariantCulture) + ","
    + "\"highVolumeSpans\":" + HighVolumeSpans.ToString(CultureInfo.InvariantCulture) + ","
    + "\"pendingEvents\":" + client.PendingEvents().ToString(CultureInfo.InvariantCulture) + ","
    + "\"retryAttempts\":" + response.Attempts.ToString(CultureInfo.InvariantCulture) + ","
    + "\"exporterFailure\":\"" + exporterResult.ToString() + "\""
    + "}");

internal sealed class FakeIntake : IDisposable
{
    private const string ExpectedApiKey = "lbw_ingest_dotnet_otel_high_load_fake";
    private readonly TcpListener listener;
    private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
    private readonly Task loop;
    private readonly List<string> bodies = new List<string>();
    private int requestCount;

    private FakeIntake(TcpListener listener)
    {
        this.listener = listener;
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        loop = Task.Run(ServeAsync);
    }

    public int Port { get; }

    public int RequestCount
    {
        get { return requestCount; }
    }

    public string LastBody
    {
        get
        {
            lock (bodies)
            {
                if (bodies.Count == 0)
                {
                    throw new InvalidOperationException("expected fake intake body");
                }

                return bodies[bodies.Count - 1];
            }
        }
    }

    public static FakeIntake Start()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return new FakeIntake(listener);
    }

    public void Dispose()
    {
        cancellation.Cancel();
        listener.Stop();
        try
        {
            loop.Wait(TimeSpan.FromSeconds(5));
        }
        catch (AggregateException)
        {
        }

        cancellation.Dispose();
    }

    private async Task ServeAsync()
    {
        while (!cancellation.IsCancellationRequested)
        {
            TcpClient? client = null;
            try
            {
                client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                _ = Task.Run(() => HandleAsync(client));
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (SocketException)
            {
                return;
            }
            catch
            {
                client?.Dispose();
            }
        }
    }

    private async Task HandleAsync(TcpClient client)
    {
        using (client)
        {
            var stream = client.GetStream();
            var requestBytes = await ReadRequestAsync(stream).ConfigureAwait(false);
            var requestText = Encoding.UTF8.GetString(requestBytes);
            var headerEnd = requestText.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (headerEnd < 0)
            {
                throw new InvalidOperationException("expected HTTP headers");
            }

            var headerText = requestText.Substring(0, headerEnd);
            var body = requestText.Substring(headerEnd + 4);
            if (!headerText.StartsWith("POST /v1/events HTTP/1.1", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("expected fake intake POST");
            }

            if (!headerText.Contains("x-logbrew-source: dotnet-otel-high-load-smoke", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("expected source header");
            }

            if (!headerText.Contains("Authorization: Bearer " + ExpectedApiKey, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("expected authorization header");
            }

            lock (bodies)
            {
                bodies.Add(body);
            }

            var count = Interlocked.Increment(ref requestCount);
            var status = count == 1 ? "503 Service Unavailable" : "202 Accepted";
            var payload = Encoding.UTF8.GetBytes("accepted");
            var response = Encoding.UTF8.GetBytes(
                "HTTP/1.1 " + status + "\r\n"
                + "Content-Length: " + payload.Length.ToString(CultureInfo.InvariantCulture) + "\r\n"
                + "Connection: close\r\n\r\n");
            await stream.WriteAsync(response, 0, response.Length).ConfigureAwait(false);
            await stream.WriteAsync(payload, 0, payload.Length).ConfigureAwait(false);
        }
    }

    private static async Task<byte[]> ReadRequestAsync(NetworkStream stream)
    {
        var buffer = new byte[8192];
        using var memory = new MemoryStream();
        var headerEnd = -1;
        var contentLength = 0;
        while (true)
        {
            var read = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            memory.Write(buffer, 0, read);
            var bytes = memory.ToArray();
            if (headerEnd < 0)
            {
                headerEnd = IndexOf(bytes, Encoding.ASCII.GetBytes("\r\n\r\n"));
                if (headerEnd >= 0)
                {
                    var headerText = Encoding.ASCII.GetString(bytes, 0, headerEnd);
                    contentLength = ContentLength(headerText);
                }
            }

            if (headerEnd >= 0 && bytes.Length >= headerEnd + 4 + contentLength)
            {
                return bytes;
            }
        }

        return memory.ToArray();
    }

    private static int ContentLength(string headerText)
    {
        foreach (var line in headerText.Split(new[] { "\r\n" }, StringSplitOptions.None))
        {
            var separator = line.IndexOf(':');
            if (separator <= 0)
            {
                continue;
            }

            var name = line.Substring(0, separator).Trim();
            if (string.Equals(name, "Content-Length", StringComparison.OrdinalIgnoreCase))
            {
                return int.Parse(line.Substring(separator + 1).Trim(), CultureInfo.InvariantCulture);
            }
        }

        return 0;
    }

    private static int IndexOf(byte[] bytes, byte[] needle)
    {
        for (var index = 0; index <= bytes.Length - needle.Length; index++)
        {
            var found = true;
            for (var offset = 0; offset < needle.Length; offset++)
            {
                if (bytes[index + offset] != needle[offset])
                {
                    found = false;
                    break;
                }
            }

            if (found)
            {
                return index;
            }
        }

        return -1;
    }
}
CS

if ! dotnet run --project "$app_dir/DotnetOpenTelemetryHighLoadApp.csproj" --configuration Release > "$tmp_dir/high-load.stdout.json" 2> "$tmp_dir/high-load.stderr.txt"; then
  cat "$tmp_dir/high-load.stdout.json" >&2 || true
  cat "$tmp_dir/high-load.stderr.txt" >&2 || true
  exit 1
fi
grep -q '"ok":true' "$tmp_dir/high-load.stdout.json"
grep -q '"droppedEvents":500' "$tmp_dir/high-load.stdout.json"
grep -q '"flushedSpans":1000' "$tmp_dir/high-load.stdout.json"
grep -q '"retryAttempts":2' "$tmp_dir/high-load.stdout.json"
grep -q '"exporterFailure":"Failure"' "$tmp_dir/high-load.stdout.json"
if [[ -s "$tmp_dir/high-load.stderr.txt" ]]; then
  cat "$tmp_dir/high-load.stderr.txt" >&2
  exit 1
fi

echo ".NET OpenTelemetry high-load installed-artifact smoke passed"
