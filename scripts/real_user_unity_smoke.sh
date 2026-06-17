#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/unity/logbrew-unity"
tmp_dir="$(mktemp -d)"
lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-unity-checks.lock"
lock_pid_file="$lock_dir/pid"
intake_pid=""

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
  if [[ -n "$intake_pid" ]]; then
    kill "$intake_pid" 2>/dev/null || true
    wait "$intake_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
  clean_generated_artifacts
  rmdir "$lock_dir" 2>/dev/null || true
}

trap clean_after_run EXIT

if ! acquire_lock; then
  echo "another Unity SDK verifier run is already in progress" >&2
  exit 1
fi

package_tgz="$tmp_dir/co.logbrew.unity-0.1.0.tgz"
(cd "$package_dir" && tar -czf "$package_tgz" package.json README.md Runtime Samples~ examples)

project_dir="$tmp_dir/UnityProject"
installed_package_dir="$project_dir/Packages/co.logbrew.unity"
mkdir -p "$installed_package_dir" "$project_dir/Packages"
tar -xzf "$package_tgz" -C "$installed_package_dir"
cat > "$project_dir/Packages/manifest.json" <<EOF
{
  "dependencies": {
    "co.logbrew.unity": "file:Packages/co.logbrew.unity"
  }
}
EOF

python3 - "$project_dir/Packages/manifest.json" "$installed_package_dir/package.json" <<'PY'
import json
import sys
from pathlib import Path

project_manifest = json.loads(Path(sys.argv[1]).read_text())
package_manifest = json.loads(Path(sys.argv[2]).read_text())
if project_manifest["dependencies"].get("co.logbrew.unity") != "file:Packages/co.logbrew.unity":
    raise SystemExit("Unity project dependency entry missing")
if package_manifest.get("name") != "co.logbrew.unity" or package_manifest.get("version") != "0.1.0":
    raise SystemExit("installed Unity package metadata mismatch")
PY

python3 - "$project_dir/Packages/manifest.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = json.loads(path.read_text())
payload["dependencies"].pop("co.logbrew.unity")
path.write_text(json.dumps(payload, indent=2) + "\n")
if "co.logbrew.unity" in json.loads(path.read_text())["dependencies"]:
    raise SystemExit("dependency removal failed")
payload["dependencies"]["co.logbrew.unity"] = "file:Packages/co.logbrew.unity"
path.write_text(json.dumps(payload, indent=2) + "\n")
if json.loads(path.read_text())["dependencies"].get("co.logbrew.unity") != "file:Packages/co.logbrew.unity":
    raise SystemExit("dependency re-add failed")
PY

run_installed_sample() {
  local project_name="$1"
  local include_real_user="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  local app_dir="$tmp_dir/$project_name"
  mkdir -p "$app_dir"
  if [[ "$include_real_user" == true ]]; then
    cat > "$app_dir/$project_name.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <StartupObject>RealUserSmoke</StartupObject>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="$installed_package_dir/Runtime/*.cs" />
    <Compile Include="$installed_package_dir/Samples~/ReadmeExample/ReadmeExample.cs" />
    <Compile Include="$installed_package_dir/Samples~/RealUserSmoke/RealUserSmoke.cs" />
  </ItemGroup>
</Project>
EOF
  else
    cat > "$app_dir/$project_name.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="$installed_package_dir/Runtime/*.cs" />
    <Compile Include="$installed_package_dir/Samples~/ReadmeExample/ReadmeExample.cs" />
  </ItemGroup>
</Project>
EOF
  fi
  dotnet run --project "$app_dir/$project_name.csproj" --configuration Release > "$stdout_path" 2> "$stderr_path"
}

run_installed_sample InstalledReadme false "$tmp_dir/installed-readme.stdout.json" "$tmp_dir/installed-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/installed-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/installed-readme.stderr.json"

run_installed_sample InstalledSmoke true "$tmp_dir/installed-smoke.stdout.json" "$tmp_dir/installed-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/installed-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/installed-smoke.stderr.json"
grep -q '"unityHelperEvents":3' "$tmp_dir/installed-smoke.stderr.json"
grep -q '"httpAttempts":1' "$tmp_dir/installed-smoke.stderr.json"

test -f "$installed_package_dir/Runtime/LogBrewTrace.cs"
test -f "$installed_package_dir/Runtime/UnityCoroutineTrace.cs"
test -f "$installed_package_dir/Runtime/UnityLifecycleTracker.cs"
test -f "$installed_package_dir/Runtime/UnityRequestTrace.cs"
test -f "$installed_package_dir/examples/trace_correlation/TraceCorrelation.cs"
test -f "$installed_package_dir/examples/lifecycle_spans/LifecycleSpans.cs"
test -f "$installed_package_dir/examples/lifecycle_tracker/LifecycleTracker.cs"
test -f "$installed_package_dir/examples/request_tracker/RequestTracker.cs"
make --no-print-directory -C "$installed_package_dir/examples" run-trace-correlation > "$tmp_dir/installed-trace-correlation.stdout.json" 2> "$tmp_dir/installed-trace-correlation.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-trace-correlation.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_unity_trace_correlation_payload.py" "$tmp_dir/installed-trace-correlation.stdout.json" "$tmp_dir/installed-trace-correlation.stderr.json"
make --no-print-directory -C "$installed_package_dir/examples" run-lifecycle-spans > "$tmp_dir/installed-lifecycle-spans.stdout.json" 2> "$tmp_dir/installed-lifecycle-spans.stderr.json"
test ! -s "$tmp_dir/installed-lifecycle-spans.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-lifecycle-spans.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_unity_lifecycle_payload.py" "$tmp_dir/installed-lifecycle-spans.stdout.json"
make --no-print-directory -C "$installed_package_dir/examples" run-lifecycle-tracker > "$tmp_dir/installed-lifecycle-tracker.stdout.json" 2> "$tmp_dir/installed-lifecycle-tracker.stderr.json"
test ! -s "$tmp_dir/installed-lifecycle-tracker.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-lifecycle-tracker.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_unity_lifecycle_payload.py" "$tmp_dir/installed-lifecycle-tracker.stdout.json"
make --no-print-directory -C "$installed_package_dir/examples" run-request-tracker > "$tmp_dir/installed-request-tracker.stdout.json" 2> "$tmp_dir/installed-request-tracker.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-request-tracker.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_unity_request_tracker_payload.py" "$tmp_dir/installed-request-tracker.stdout.json" "$tmp_dir/installed-request-tracker.stderr.json"

smoke_dir="$tmp_dir/smoke-app"
mkdir -p "$smoke_dir"
cat > "$smoke_dir/SmokeApp.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="$installed_package_dir/Runtime/*.cs" />
    <Compile Include="$smoke_dir/Program.cs" />
  </ItemGroup>
</Project>
EOF
cat > "$smoke_dir/Program.cs" <<'CS'
using System;
using System.Collections.Generic;
using LogBrew.Unity;

static LogBrewClient NewClient(int maxRetries = 2)
{
    return LogBrewUnity.CreateClient("LOGBREW_API_KEY", "unity-smoke-app", maxRetries);
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

var helper = NewClient();
var context = UnityContext.Create()
    .WithPlatform("ios")
    .WithSceneName("MainMenu")
    .WithGameObjectName("Player")
    .WithSessionId("session_001")
    .WithFrame(42);
LogBrewUnity.CaptureSceneLoaded(helper, "evt_scene_loaded_001", "2026-06-02T10:00:06Z", "MainMenu", 1, context);
LogBrewUnity.CaptureLogMessage(helper, "evt_unity_log_001", "2026-06-02T10:00:07Z", "button clicked", "Warning", context);
LogBrewUnity.CaptureException(helper, "evt_unity_exception_001", "2026-06-02T10:00:08Z", "NullReferenceException", "stack trace", context);
if (!helper.PreviewJson().Contains("\"sceneName\": \"MainMenu\"", StringComparison.Ordinal))
{
    throw new InvalidOperationException("missing Unity context");
}

var httpEndpoint = Environment.GetEnvironmentVariable("LOGBREW_UNITY_HTTP_ENDPOINT")
    ?? throw new InvalidOperationException("missing HTTP endpoint");
var http = NewClient(maxRetries: 1);
http.Log(
    "evt_unity_http_transport",
    "2026-06-02T10:00:09Z",
    LogAttributes.Create("unity http transport sent", "info").WithLogger("unity-http"));
var httpResponse = http.Flush(new HttpTransport(
    new Uri(httpEndpoint),
    new Dictionary<string, string> { ["x-logbrew-source"] = "unity-smoke-app" },
    TimeSpan.FromSeconds(5)));
if (httpResponse.StatusCode != 202 || httpResponse.Attempts != 2 || http.PendingEvents() != 0)
{
    throw new InvalidOperationException("unexpected HTTP transport state");
}

var closed = NewClient();
EnqueueAll(closed);
closed.Shutdown(RecordingTransport.AlwaysAccept());
Expect("shutdown_error", () => closed.Action("evt_action_002", "2026-06-02T10:00:06Z", ActionAttributes.Create("deploy", "success")));

Console.Error.WriteLine("{\"ok\":true,\"status\":202,\"attempts\":1,\"events\":6,\"unityHelperEvents\":3,\"httpAttempts\":" + httpResponse.Attempts + "}");
CS

intake_port="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
cat > "$tmp_dir/unity_intake.py" <<'PY'
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

port = int(sys.argv[1])
ready_path = Path(sys.argv[2])
log_path = Path(sys.argv[3])


class Handler(BaseHTTPRequestHandler):
    count = 0

    def do_POST(self):
        content_length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(content_length).decode("utf-8")
        Handler.count += 1
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "authorization": self.headers.get("authorization"),
                "body": body,
                "contentType": self.headers.get("content-type"),
                "source": self.headers.get("x-logbrew-source"),
                "path": self.path,
            }) + "\n")
        self.send_response(503 if Handler.count == 1 else 202)
        self.end_headers()
        self.wfile.write(b"accepted")

    def log_message(self, _format, *_args):
        return


server = HTTPServer(("127.0.0.1", port), Handler)
ready_path.write_text("ready", encoding="utf-8")
while Handler.count < 2:
    server.handle_request()
PY
intake_ready="$tmp_dir/intake.ready"
intake_log="$tmp_dir/intake.jsonl"
python3 "$tmp_dir/unity_intake.py" "$intake_port" "$intake_ready" "$intake_log" &
intake_pid="$!"
for _attempt in {1..50}; do
  if [[ -f "$intake_ready" ]]; then
    break
  fi
  sleep 0.1
done
test -f "$intake_ready"

LOGBREW_UNITY_HTTP_ENDPOINT="http://127.0.0.1:$intake_port/v1/events" \
  dotnet run --project "$smoke_dir/SmokeApp.csproj" --configuration Release > "$tmp_dir/smoke-app.stdout.json" 2> "$tmp_dir/smoke-app.stderr.json"
wait "$intake_pid"
intake_pid=""
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke-app.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke-app.stderr.json"
grep -q '"unityHelperEvents":3' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/smoke-app.stderr.json"
python3 - "$intake_log" <<'PY'
import json
import sys
from pathlib import Path

requests = [
    json.loads(line)
    for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
]
if len(requests) != 2:
    raise SystemExit(f"expected 2 HTTP delivery attempts, got {len(requests)}")
for request in requests:
    if request["authorization"] != "Bearer LOGBREW_API_KEY":
        raise SystemExit(f"unexpected authorization header: {request['authorization']}")
    if request["contentType"].split(";", maxsplit=1)[0] != "application/json":
        raise SystemExit(f"unexpected content type: {request['contentType']}")
    if request["source"] != "unity-smoke-app":
        raise SystemExit(f"unexpected source header: {request['source']}")
    if request["path"] != "/v1/events":
        raise SystemExit(f"unexpected intake path: {request['path']}")
if "evt_unity_http_transport" not in requests[1]["body"]:
    raise SystemExit("missing HTTP transport event in final request body")
PY

make --no-print-directory -C "$installed_package_dir/examples" > "$tmp_dir/installed-examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/installed-examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/installed-examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/installed-examples-help.txt"
grep -qx 'run-trace-correlation -> make run-trace-correlation' "$tmp_dir/installed-examples-help.txt"
grep -qx 'run-lifecycle-spans -> make run-lifecycle-spans' "$tmp_dir/installed-examples-help.txt"

echo "unity real-user smoke passed"
