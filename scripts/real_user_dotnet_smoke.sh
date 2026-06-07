#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/dotnet/logbrew-dotnet"
tmp_dir="$(mktemp -d)"
lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-dotnet-checks.lock"
lock_pid_file="$lock_dir/pid"

acquire_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock_pid_file"
    return 0
  fi

  local existing_pid=""
  if [[ -f "$lock_pid_file" ]]; then
    existing_pid="$(tr -d '[:space:]' < "$lock_pid_file")"
  fi

  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    return 1
  fi

  rm -rf "$lock_dir"
  mkdir "$lock_dir"
  printf '%s\n' "$$" > "$lock_pid_file"
}

clean_generated_artifacts() {
  find "$package_dir" -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + 2>/dev/null || true
}

clean_after_run() {
  rm -rf "$tmp_dir"
  clean_generated_artifacts
  rmdir "$lock_dir" 2>/dev/null || true
}

trap clean_after_run EXIT

if ! acquire_lock; then
  echo "another .NET SDK verifier run is already in progress" >&2
  exit 1
fi

dotnet pack "$package_dir/src/LogBrew/LogBrew.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
nupkg="$tmp_dir/packages/LogBrew.0.1.0.nupkg"
test -f "$nupkg"
export NUGET_PACKAGES="$tmp_dir/nuget-packages"
nuget_org_source="https://api.nuget.org/v3/index.json"
cat > "$tmp_dir/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local-logbrew" value="$tmp_dir/packages" />
    <add key="nuget.org" value="$nuget_org_source" />
  </packageSources>
</configuration>
EOF

extract_dir="$tmp_dir/package-extract"
mkdir -p "$extract_dir"
python3 - "$nupkg" "$extract_dir" <<'PY'
import sys
import zipfile
from pathlib import Path

nupkg = Path(sys.argv[1])
extract_dir = Path(sys.argv[2])
with zipfile.ZipFile(nupkg) as archive:
    archive.extractall(extract_dir)
    names = set(archive.namelist())
    for required in (
        "LogBrew.nuspec",
        "lib/netstandard2.0/LogBrew.dll",
        "README.md",
        "examples/ReadmeExample.cs",
        "examples/RealUserSmoke.cs",
        "examples/Makefile",
    ):
        if required not in names:
            raise SystemExit(f"missing nupkg file: {required}")
    readme = archive.read("README.md").decode()
    nuspec = archive.read("LogBrew.nuspec").decode()
if 'dependency id="Microsoft.Extensions.Logging"' not in nuspec:
    raise SystemExit("missing Microsoft.Extensions.Logging dependency metadata")
for needle in (
    "dotnet add package LogBrew",
    "LOGBREW_API_KEY",
    "PreviewJson()",
    "MetricAttributes",
    "This SDK does not automatically collect CLR, runtime, or framework metrics yet.",
    "HttpTransport",
    "System.Net.Http",
    "AddLogBrew(client",
    "Microsoft.Extensions.Logging",
    "IncludeExceptionStackTrace",
    "cd examples && make run-real-user-smoke",
):
    if needle not in readme:
        raise SystemExit(f"missing packaged README guidance: {needle}")
PY

run_packaged_example() {
  local source_file="$1"
  local project_name="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  local app_dir="$tmp_dir/$project_name"
  dotnet new console --framework net10.0 --name "$project_name" --output "$app_dir" >/dev/null
  cp "$extract_dir/examples/$source_file" "$app_dir/Program.cs"
  dotnet add "$app_dir/$project_name.csproj" package LogBrew --version 0.1.0 >/dev/null
  dotnet run --project "$app_dir/$project_name.csproj" --configuration Release > "$stdout_path" 2> "$stderr_path"
}

run_packaged_example ReadmeExample.cs PackagedReadme "$tmp_dir/packaged-readme.stdout.json" "$tmp_dir/packaged-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-readme.stderr.json"

run_packaged_example RealUserSmoke.cs PackagedSmoke "$tmp_dir/packaged-smoke.stdout.json" "$tmp_dir/packaged-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/packaged-smoke.stderr.json"

lifecycle_dir="$tmp_dir/lifecycle-app"
dotnet new console --framework net10.0 --name LifecycleApp --output "$lifecycle_dir" >/dev/null
dotnet add "$lifecycle_dir/LifecycleApp.csproj" package LogBrew --version 0.1.0 >/dev/null
dotnet list "$lifecycle_dir/LifecycleApp.csproj" package > "$tmp_dir/lifecycle-packages.txt"
grep -q 'LogBrew' "$tmp_dir/lifecycle-packages.txt"
dotnet list "$lifecycle_dir/LifecycleApp.csproj" package --include-transitive > "$tmp_dir/lifecycle-packages-transitive.txt"
grep -q 'Microsoft.Extensions.Logging' "$tmp_dir/lifecycle-packages-transitive.txt"
dotnet remove "$lifecycle_dir/LifecycleApp.csproj" package LogBrew >/dev/null
if grep -q 'PackageReference Include="LogBrew"' "$lifecycle_dir/LifecycleApp.csproj"; then
  echo "expected dotnet remove package to remove LogBrew reference" >&2
  exit 1
fi
dotnet add "$lifecycle_dir/LifecycleApp.csproj" package LogBrew --version 0.1.0 >/dev/null
grep -q 'PackageReference Include="LogBrew" Version="0.1.0"' "$lifecycle_dir/LifecycleApp.csproj"

logging_dir="$tmp_dir/logging-app"
dotnet new console --framework net10.0 --name LoggingApp --output "$logging_dir" >/dev/null
dotnet add "$logging_dir/LoggingApp.csproj" package LogBrew --version 0.1.0 >/dev/null
cat > "$logging_dir/Program.cs" <<'CS'
using System;
using System.Collections.Generic;
using System.Globalization;
using LogBrew;
using Microsoft.Extensions.Logging;

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

var client = LogBrewClient.Create("LOGBREW_API_KEY", "logging-app", "0.1.0");
var transport = RecordingTransport.AlwaysAccept();
using (ILoggerFactory factory = LoggerFactory.Create(builder =>
{
    builder.SetMinimumLevel(LogLevel.Debug);
    builder.AddLogBrew(client, new LogBrewLoggerOptions
    {
        MinimumLevel = LogLevel.Debug,
        Metadata = new Dictionary<string, object?> { ["service"] = "checkout", ["ignoredBase"] = new object() },
        EventIdPrefix = "installed_dotnet",
        TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:06Z", CultureInfo.InvariantCulture)
    });
}))
{
    var logger = factory.CreateLogger("InstalledCheckout");
    using (logger.BeginScope(new Dictionary<string, object?> { ["requestId"] = "req_456", ["ignoredScope"] = new object() }))
    {
        logger.LogWarning(new EventId(42, "CheckoutSlow"), "Checkout slow for {Region}", "global");
        try
        {
            throw new InvalidOperationException("payment failed");
        }
        catch (InvalidOperationException error)
        {
            logger.LogError(new EventId(43, "CheckoutFailed"), error, "Checkout failed for {Region}", "global");
        }
    }
}

Require(client.PendingEvents() == 2, "expected installed logger provider events");
var body = client.PreviewJson();
foreach (var expected in new[]
{
    "\"id\": \"installed_dotnet_1\"",
    "\"timestamp\": \"2026-06-02T10:00:06.0000000+00:00\"",
    "\"logger\": \"InstalledCheckout\"",
    "\"level\": \"warning\"",
    "\"level\": \"error\"",
    "\"dotnetCategory\": \"InstalledCheckout\"",
    "\"dotnetLogLevel\": \"Warning\"",
    "\"dotnetEventId\": 42",
    "\"dotnetEventName\": \"CheckoutSlow\"",
    "\"Region\": \"global\"",
    "\"messageTemplate\": \"Checkout slow for {Region}\"",
    "\"scope.requestId\": \"req_456\"",
    "\"exceptionType\": \"System.InvalidOperationException\"",
    "\"exceptionMessage\": \"payment failed\""
})
{
    Require(body.Contains(expected, StringComparison.Ordinal), "missing installed logger metadata: " + expected);
}

Require(!body.Contains("exceptionStackTrace", StringComparison.Ordinal), "stack text should be opt-in");
Require(!body.Contains("ignoredBase", StringComparison.Ordinal), "non-primitive base metadata should be skipped");
Require(!body.Contains("ignoredScope", StringComparison.Ordinal), "non-primitive scope metadata should be skipped");
var response = client.Flush(transport);
Require(response.StatusCode == 202 && response.Attempts == 1, "expected installed logger flush");
Require(transport.SentBodies.Count == 1, "expected installed logger transport body");
Console.Error.WriteLine("{\"logging\":true,\"events\":2}");
CS
dotnet run --project "$logging_dir/LoggingApp.csproj" --configuration Release > "$tmp_dir/logging-app.stdout.txt" 2> "$tmp_dir/logging-app.stderr.json"
test ! -s "$tmp_dir/logging-app.stdout.txt"
grep -q '"logging":true' "$tmp_dir/logging-app.stderr.json"

smoke_dir="$tmp_dir/smoke-app"
dotnet new console --framework net10.0 --name SmokeApp --output "$smoke_dir" >/dev/null
dotnet add "$smoke_dir/SmokeApp.csproj" package LogBrew --version 0.1.0 >/dev/null
cat > "$smoke_dir/Program.cs" <<'CS'
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

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static LogBrewClient NewClient(int maxRetries = 2)
{
    return LogBrewClient.Create("LOGBREW_API_KEY", "smoke-app", "0.1.0", maxRetries);
}

static void EnqueueAll(LogBrewClient client)
{
    client.Release("evt_release_001", "2026-06-02T10:00:00Z", ReleaseAttributes.Create("1.2.3").WithCommit("abc123def456").WithNotes("Public release marker"));
    client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes.Create("production").WithRegion("global"));
    client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes.Create("Checkout timeout", "error").WithMessage("Request timed out after retry budget"));
    client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.Create("worker started", "info").WithLogger("job-runner"));
    client.Span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok").WithDurationMs(12.5));
    client.Action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes.Create("deploy", "success"));
}

static void Expect(string code, Action callback)
{
    try
    {
        callback();
    }
    catch (SdkException error) when (error.Code == code)
    {
        return;
    }

    throw new InvalidOperationException("expected " + code);
}

var happy = NewClient();
EnqueueAll(happy);
Console.WriteLine(happy.PreviewJson());
var response = happy.Flush(RecordingTransport.AlwaysAccept());
if (response.StatusCode != 202 || response.Attempts != 1 || happy.PendingEvents() != 0)
{
    throw new InvalidOperationException("unexpected flush state");
}

var empty = happy.Flush(RecordingTransport.AlwaysAccept());
if (empty.StatusCode != 204 || empty.Attempts != 0)
{
    throw new InvalidOperationException("unexpected empty flush");
}

var metrics = NewClient();
metrics.Metric(
    "evt_metric_queue_depth",
    "2026-06-02T10:00:06Z",
    MetricAttributes.Create("queue.depth", "gauge", -2.0, "{items}", "instant")
        .WithMetadata(new Dictionary<string, object?> { ["service"] = "worker", ["queue"] = "default" }));
var metricPayload = metrics.PreviewJson();
Require(metrics.PendingEvents() == 1, "metric queues one event");
Require(metricPayload.Contains("\"type\": \"metric\"", StringComparison.Ordinal), "metric event type");
Require(metricPayload.Contains("\"name\": \"queue.depth\"", StringComparison.Ordinal), "metric name");
Require(metricPayload.Contains("\"kind\": \"gauge\"", StringComparison.Ordinal), "metric kind");
Require(metricPayload.Contains("\"value\": -2", StringComparison.Ordinal), "metric value");
Require(metricPayload.Contains("\"unit\": \"{items}\"", StringComparison.Ordinal), "metric unit");
Require(metricPayload.Contains("\"temporality\": \"instant\"", StringComparison.Ordinal), "metric temporality");
Require(metricPayload.Contains("\"queue\": \"default\"", StringComparison.Ordinal), "metric metadata");
Expect("validation_error", () => metrics.Metric(
    "evt_metric_invalid_value",
    "2026-06-02T10:00:06Z",
    MetricAttributes.Create("queue.depth", "gauge", double.NaN, "{items}", "instant")));
Expect("validation_error", () => metrics.Metric(
    "evt_metric_invalid_counter",
    "2026-06-02T10:00:06Z",
    MetricAttributes.Create("jobs.completed", "counter", -1.0, "1", "delta")));
Expect("validation_error", () => metrics.Metric(
    "evt_metric_invalid_temporality",
    "2026-06-02T10:00:06Z",
    MetricAttributes.Create("queue.depth", "gauge", 2.0, "{items}", "delta")));

Expect("validation_error", () => happy.Log("evt_bad", "2026-06-02T10:00:03", LogAttributes.Create("worker started", "info")));

var unauthenticated = NewClient();
EnqueueAll(unauthenticated);
Expect("unauthenticated", () => unauthenticated.Flush(new RecordingTransport(new object[] { 401 })));
if (unauthenticated.PendingEvents() != 6)
{
    throw new InvalidOperationException("unauthenticated should preserve queue");
}

var retry = NewClient();
EnqueueAll(retry);
var retryResponse = retry.Flush(new RecordingTransport(new object[] { TransportException.Network("temporary outage"), 202 }));
if (retryResponse.Attempts != 2)
{
    throw new InvalidOperationException("expected retry recovery");
}

var exhausted = NewClient(maxRetries: 1);
EnqueueAll(exhausted);
Expect("network_failure", () => exhausted.Flush(new RecordingTransport(new object[]
{
    TransportException.Network("temporary outage"),
    TransportException.Network("still down")
})));
if (exhausted.PendingEvents() != 6)
{
    throw new InvalidOperationException("retry budget should preserve queue");
}

var nonRetryable = NewClient();
EnqueueAll(nonRetryable);
Expect("transport_error", () => nonRetryable.Flush(new RecordingTransport(new object[] { 400 })));
if (nonRetryable.PendingEvents() != 6)
{
    throw new InvalidOperationException("non-retryable status should preserve queue");
}

var httpAttempts = 0;
var httpRequests = 0;
using (var intake = new LocalHttpIntake())
using (var httpTransport = new HttpTransport(new HttpTransportOptions
{
    Endpoint = intake.Endpoint,
    Headers = new Dictionary<string, string> { ["x-logbrew-source"] = "dotnet-smoke" },
    Timeout = TimeSpan.FromSeconds(5)
}))
{
    var http = NewClient(maxRetries: 1);
    http.Log("evt_dotnet_http", "2026-06-02T10:00:08Z", LogAttributes.Create("http delivery", "info"));
    var httpResponse = http.Flush(httpTransport);
    httpAttempts = httpResponse.Attempts;
    httpRequests = intake.RequestCount;
    Require(httpResponse.StatusCode == 202, "expected HTTP delivery status");
    Require(httpAttempts == 2, "expected HTTP retry recovery");
    Require(httpRequests == 2, "expected two HTTP intake requests");
    Require(http.PendingEvents() == 0, "expected HTTP delivery to clear queue");
    Require(intake.LastMethod == "POST", "expected HTTP POST");
    Require(intake.LastPath == "/v1/events", "expected HTTP path");
    Require(intake.LastAuthorization == "Bearer LOGBREW_API_KEY", "expected HTTP authorization header");
    Require(intake.LastSource == "dotnet-smoke", "expected HTTP custom header");
    Require(intake.LastContentType.StartsWith("application/json", StringComparison.Ordinal), "expected HTTP content type");
    Require(intake.LastBody.Contains("evt_dotnet_http", StringComparison.Ordinal), "expected HTTP request body");
    Require(intake.Bodies.Count == 2, "expected retry body capture");
    Require(intake.Bodies[0] == intake.Bodies[1], "expected retry body to stay unchanged");
}

var closed = NewClient();
EnqueueAll(closed);
closed.Shutdown(RecordingTransport.AlwaysAccept());
Expect("shutdown_error", () => closed.Action("evt_action_002", "2026-06-02T10:00:06Z", ActionAttributes.Create("deploy", "success")));

Console.Error.WriteLine(
    "{\"ok\":true,\"status\":202,\"attempts\":1,\"events\":6,\"httpAttempts\":"
    + httpAttempts.ToString(CultureInfo.InvariantCulture)
    + ",\"metricEvents\":1"
    + ",\"httpRequests\":"
    + httpRequests.ToString(CultureInfo.InvariantCulture)
    + "}");

internal sealed class LocalHttpIntake : IDisposable
{
    private readonly TcpListener listener;
    private readonly Task acceptTask;
    private int requestCount;
    private bool disposed;

    internal LocalHttpIntake()
    {
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Endpoint = new Uri("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/v1/events");
        acceptTask = Task.Run(AcceptLoop);
    }

    internal Uri Endpoint { get; }

    internal int RequestCount
    {
        get { return Volatile.Read(ref requestCount); }
    }

    internal string LastMethod { get; private set; } = string.Empty;

    internal string LastPath { get; private set; } = string.Empty;

    internal string LastAuthorization { get; private set; } = string.Empty;

    internal string LastSource { get; private set; } = string.Empty;

    internal string LastContentType { get; private set; } = string.Empty;

    internal string LastBody { get; private set; } = string.Empty;

    internal List<string> Bodies { get; } = new List<string>();

    public void Dispose()
    {
        Volatile.Write(ref disposed, true);
        listener.Stop();
        try
        {
            acceptTask.Wait(TimeSpan.FromSeconds(2));
        }
        catch (AggregateException)
        {
        }
    }

    private async Task AcceptLoop()
    {
        while (!Volatile.Read(ref disposed))
        {
            TcpClient? socket = null;
            try
            {
                socket = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                await HandleClient(socket).ConfigureAwait(false);
            }
            catch (ObjectDisposedException) when (Volatile.Read(ref disposed))
            {
                return;
            }
            catch (SocketException) when (Volatile.Read(ref disposed))
            {
                return;
            }
            finally
            {
                socket?.Dispose();
            }
        }
    }

    private async Task HandleClient(TcpClient socket)
    {
        using var stream = socket.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
        var requestLine = await reader.ReadLineAsync().ConfigureAwait(false) ?? string.Empty;
        var parts = requestLine.Split(' ');
        LastMethod = parts.Length > 0 ? parts[0] : string.Empty;
        LastPath = parts.Length > 1 ? parts[1] : string.Empty;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        while (true)
        {
            var line = await reader.ReadLineAsync().ConfigureAwait(false);
            if (line == null || line.Length == 0)
            {
                break;
            }

            var separator = line.IndexOf(':');
            if (separator > 0)
            {
                headers[line.Substring(0, separator).Trim()] = line.Substring(separator + 1).Trim();
            }
        }

        var contentLength = 0;
        if (headers.TryGetValue("content-length", out var contentLengthValue))
        {
            int.TryParse(contentLengthValue, NumberStyles.None, CultureInfo.InvariantCulture, out contentLength);
        }

        var body = new StringBuilder();
        if (contentLength > 0)
        {
            var buffer = new char[contentLength];
            while (body.Length < contentLength)
            {
                var read = await reader.ReadAsync(buffer, 0, Math.Min(buffer.Length, contentLength - body.Length)).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                body.Append(buffer, 0, read);
            }
        }

        LastBody = body.ToString();
        Bodies.Add(LastBody);
        LastAuthorization = headers.TryGetValue("authorization", out var authorization) ? authorization : string.Empty;
        LastSource = headers.TryGetValue("x-logbrew-source", out var source) ? source : string.Empty;
        LastContentType = headers.TryGetValue("content-type", out var contentType) ? contentType : string.Empty;

        var nextRequest = Interlocked.Increment(ref requestCount);
        var status = nextRequest == 1 ? 503 : 202;
        var reason = status == 503 ? "Service Unavailable" : "Accepted";
        var response = "HTTP/1.1 "
            + status.ToString(CultureInfo.InvariantCulture)
            + " "
            + reason
            + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        var bytes = Encoding.ASCII.GetBytes(response);
        await stream.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
    }
}
CS
dotnet run --project "$smoke_dir/SmokeApp.csproj" --configuration Release > "$tmp_dir/smoke-app.stdout.json" 2> "$tmp_dir/smoke-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke-app.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"metricEvents":1' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpRequests":2' "$tmp_dir/smoke-app.stderr.json"

echo "dotnet real-user smoke passed"
