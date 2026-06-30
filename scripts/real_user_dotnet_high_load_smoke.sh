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
package_version="$(dotnet msbuild "$package_dir/src/LogBrew/LogBrew.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
nupkg="$tmp_dir/packages/LogBrew.${package_version}.nupkg"
test -f "$nupkg"

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

app_dir="$tmp_dir/dotnet-high-load-app"
dotnet new console --framework net10.0 --name DotnetHighLoadApp --output "$app_dir" >/dev/null
dotnet add "$app_dir/DotnetHighLoadApp.csproj" package LogBrew --version "$package_version" >/dev/null
dotnet remove "$app_dir/DotnetHighLoadApp.csproj" package LogBrew >/dev/null
if grep -q 'PackageReference Include="LogBrew"' "$app_dir/DotnetHighLoadApp.csproj"; then
  echo "expected dotnet remove package to remove LogBrew reference" >&2
  exit 1
fi
dotnet add "$app_dir/DotnetHighLoadApp.csproj" package LogBrew --version "$package_version" >/dev/null
grep -q "PackageReference Include=\"LogBrew\" Version=\"$package_version\"" "$app_dir/DotnetHighLoadApp.csproj"

cat > "$app_dir/Program.cs" <<'CS'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using Microsoft.Extensions.Logging;

const string ApiKey = "lbw_ingest_dotnet_high_load_fake";
const int HighVolumeLogs = 1500;
const int MaxQueueSize = 1000;
const string TraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const string ParentSpanId = "00f067aa0ba902b7";
const string ChildSpanId = "b7ad6b7169203331";

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
    "dotnet-high-load-smoke",
    "0.1.0",
    maxRetries: 1,
    onEventDropped: drops.Add);
var root = LogBrewTraceContext.FromTraceparent(
    "00-" + TraceId + "-" + ParentSpanId + "-01",
    ChildSpanId);

client.Release("evt_dotnet_high_load_release", Timestamp(0), ReleaseAttributes.Create("checkout@1.2.3"));
client.Environment("evt_dotnet_high_load_environment", Timestamp(1), EnvironmentAttributes.Create("production"));
client.Span(
    "evt_dotnet_high_load_request_span",
    Timestamp(2),
    SpanAttributes.Create("POST /checkout/:cart_id", root.TraceId, root.SpanId, "ok")
        .WithParentSpanId(root.ParentSpanId!)
        .WithDurationMs(42.5)
        .WithMetadata(new Dictionary<string, object?>
        {
            ["service"] = "checkout-api",
            ["routeTemplate"] = "/checkout/:cart_id"
        }));
client.Action(
    "evt_dotnet_high_load_action",
    Timestamp(3),
    ActionAttributes.Create("checkout.submit", "success")
        .WithMetadata(new Dictionary<string, object?>
        {
            ["release"] = "checkout@1.2.3",
            ["environment"] = "production"
        }));

using (LogBrewTrace.Activate(root))
using (ILoggerFactory factory = LoggerFactory.Create(builder =>
{
    builder.SetMinimumLevel(LogLevel.Information);
    builder.AddLogBrew(client, new LogBrewLoggerOptions
    {
        MinimumLevel = LogLevel.Information,
        Metadata = new Dictionary<string, object?>
        {
            ["service"] = "checkout-api",
            ["release"] = "checkout@1.2.3",
            ["environment"] = "production"
        },
        EventIdPrefix = "dotnet_high_load",
        TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:01:00Z", CultureInfo.InvariantCulture)
    });
}))
{
    var logger = factory.CreateLogger("CheckoutHighLoad");
    for (var index = 0; index < HighVolumeLogs; index++)
    {
        logger.Log(
            index % 10 == 0 ? LogLevel.Warning : LogLevel.Information,
            new EventId(index + 1, "HighLoad"),
            new Dictionary<string, object?>
            {
                ["sequence"] = index,
                ["routeTemplate"] = "/checkout/:cart_id",
                ["unsafePayload"] = new object()
            },
            null,
            static (_, _) => "checkout queue heartbeat");
    }
}

var expectedDrops = 4 + HighVolumeLogs - MaxQueueSize;
Require(client.PendingEvents() == MaxQueueSize, "expected bounded queue size");
Require(client.DroppedEvents() == expectedDrops, "expected dropped event count");
Require(drops.Count == expectedDrops, "expected drop callback count");
Require(drops[0].EventId == "dotnet_high_load_997", "expected first dropped log event id");
Require(drops[0].EventType == "log", "expected first dropped event type");
Require(drops[0].Reason == "queue_overflow", "expected first dropped event reason");
Require(drops[0].DroppedEvents == 1, "expected first dropped event count");

var preview = client.PreviewJson();
Require(preview.Contains("evt_dotnet_high_load_release", StringComparison.Ordinal), "expected release context");
Require(preview.Contains("evt_dotnet_high_load_environment", StringComparison.Ordinal), "expected environment context");
Require(preview.Contains("evt_dotnet_high_load_request_span", StringComparison.Ordinal), "expected span context");
Require(preview.Contains("evt_dotnet_high_load_action", StringComparison.Ordinal), "expected action context");
Require(CountOccurrences(preview, "\"type\": \"log\"") == MaxQueueSize - 4, "expected accepted log count");
Require(!preview.Contains("unsafePayload", StringComparison.Ordinal), "expected unsafe metadata to be omitted");

var advisoryClient = LogBrewClient.Create(
    ApiKey,
    "dotnet-high-load-advisory-drop-smoke",
    "0.1.0",
    maxRetries: 1,
    maxQueueSize: 1,
    onEventDropped: _ => throw new InvalidOperationException("drop callback must not interrupt logging"));
advisoryClient.Log("evt_dotnet_advisory_001", Timestamp(2000), LogAttributes.Create("queued", "info"));
advisoryClient.Log("evt_dotnet_advisory_002", Timestamp(2001), LogAttributes.Create("dropped", "info"));
Require(advisoryClient.PendingEvents() == 1, "expected advisory queue size");
Require(advisoryClient.DroppedEvents() == 1, "expected advisory dropped count");

using var intake = FakeIntake.Start();
var response = client.Flush(new HttpTransport(new HttpTransportOptions
{
    Endpoint = new Uri("http://127.0.0.1:" + intake.Port.ToString(CultureInfo.InvariantCulture) + "/v1/events"),
    Headers = new Dictionary<string, string> { ["x-logbrew-source"] = "dotnet-high-load-smoke" },
    Timeout = TimeSpan.FromSeconds(5)
}));

Require(response.StatusCode == 202, "expected retry flush status");
Require(response.Attempts == 2, "expected retry attempts");
Require(intake.RequestCount == 2, "expected fake intake retry count");
Require(client.PendingEvents() == 0, "expected queue after flush");
Require(client.DroppedEvents() == expectedDrops, "expected drop count to survive flush");

var body = intake.LastBody;
Require(CountOccurrences(body, "\"type\": \"log\"") == MaxQueueSize - 4, "expected flushed log count");
Require(body.Contains("\"name\": \"dotnet-high-load-smoke\"", StringComparison.Ordinal), "expected sdk name");
Require(body.Contains("\"traceId\": \"" + TraceId + "\"", StringComparison.Ordinal), "expected trace correlation");
Require(body.Contains("\"parentSpanId\": \"" + ParentSpanId + "\"", StringComparison.Ordinal), "expected parent span correlation");
Require(body.Contains("\"release\": \"checkout@1.2.3\"", StringComparison.Ordinal), "expected release correlation");
Require(body.Contains("\"environment\": \"production\"", StringComparison.Ordinal), "expected environment correlation");
Require(body.Contains("\"level\": \"warning\"", StringComparison.Ordinal), "expected canonical warning level");
Require(body.Contains("\"dotnetCategory\": \"CheckoutHighLoad\"", StringComparison.Ordinal), "expected logger source");
Require(body.Contains("\"dotnetEventName\": \"HighLoad\"", StringComparison.Ordinal), "expected event name");
Require(!body.Contains("dotnet_high_load_997", StringComparison.Ordinal), "expected first dropped log omitted");
foreach (var unsafeText in new[] { ApiKey, "authorization", "unsafePayload", "coupon=private", "#fragment" })
{
    Require(!body.Contains(unsafeText, StringComparison.Ordinal), "expected payload to omit " + unsafeText);
}

var shutdownClient = LogBrewClient.Create(ApiKey, "dotnet-high-load-shutdown-smoke", "0.1.0");
shutdownClient.Log("evt_dotnet_shutdown_001", Timestamp(3000), LogAttributes.Create("shutdown flush", "info"));
var shutdownResponse = shutdownClient.Shutdown(RecordingTransport.AlwaysAccept());
Require(shutdownResponse.StatusCode == 202, "expected shutdown status");
try
{
    shutdownClient.Log("evt_dotnet_shutdown_after_001", Timestamp(3001), LogAttributes.Create("after shutdown", "info"));
    throw new InvalidOperationException("expected post-shutdown log to fail");
}
catch (SdkException error) when (error.Code == "shutdown_error")
{
}

Console.WriteLine("{"
    + "\"ok\":true,"
    + "\"droppedEvents\":" + client.DroppedEvents().ToString(CultureInfo.InvariantCulture) + ","
    + "\"flushedEvents\":" + MaxQueueSize.ToString(CultureInfo.InvariantCulture) + ","
    + "\"highVolumeLogs\":" + HighVolumeLogs.ToString(CultureInfo.InvariantCulture) + ","
    + "\"pendingEvents\":" + client.PendingEvents().ToString(CultureInfo.InvariantCulture) + ","
    + "\"retryAttempts\":" + response.Attempts.ToString(CultureInfo.InvariantCulture) + ","
    + "\"shutdownStatus\":" + shutdownResponse.StatusCode.ToString(CultureInfo.InvariantCulture)
    + "}");

internal sealed class FakeIntake : IDisposable
{
    private const string ExpectedApiKey = "lbw_ingest_dotnet_high_load_fake";
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

            if (!headerText.Contains("x-logbrew-source: dotnet-high-load-smoke", StringComparison.OrdinalIgnoreCase))
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

if ! dotnet run --project "$app_dir/DotnetHighLoadApp.csproj" --configuration Release > "$tmp_dir/high-load.stdout.json" 2> "$tmp_dir/high-load.stderr.txt"; then
  cat "$tmp_dir/high-load.stdout.json" >&2 || true
  cat "$tmp_dir/high-load.stderr.txt" >&2 || true
  exit 1
fi
grep -q '"ok":true' "$tmp_dir/high-load.stdout.json"
grep -q '"droppedEvents":504' "$tmp_dir/high-load.stdout.json"
grep -q '"flushedEvents":1000' "$tmp_dir/high-load.stdout.json"
grep -q '"retryAttempts":2' "$tmp_dir/high-load.stdout.json"

echo "dotnet high-load installed-artifact smoke passed"
