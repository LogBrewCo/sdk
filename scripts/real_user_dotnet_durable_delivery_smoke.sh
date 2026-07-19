#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/dotnet/logbrew-dotnet"
verifier="$repo_root/scripts/dotnet_durable_delivery_verifier.py"
tmp_dir="$(mktemp -d)"
timeout_seconds="${LOGBREW_DURABLE_SMOKE_TIMEOUT_SECONDS:-30}"
source "$repo_root/scripts/dotnet_verifier_lock.sh"

terminate_process() {
  local pid="$1"
  if ! kill -TERM "$pid" 2>/dev/null; then
    return 1
  fi
  sleep 1
  kill -KILL "$pid" 2>/dev/null || true
}

fail_stage() {
  echo "$1 failed" >&2
  exit 1
}

require_stage() {
  local label="$1"
  shift
  if ! "$@"; then
    fail_stage "$label"
  fi
}

require_empty_stage() {
  local label="$1"
  local path="$2"
  if [[ -s "$path" ]]; then
    fail_stage "$label"
  fi
}

cleanup() {
  if [[ -n "${watchdog_pid:-}" ]]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
  if [[ -n "${app_pid:-}" ]]; then
    terminate_process "$app_pid" || true
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "${server_pid:-}" ]]; then
    terminate_process "$server_pid" || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
  find "$package_dir" -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + 2>/dev/null || true
  release_dotnet_verifier_lock
}

trap cleanup EXIT

if ! acquire_dotnet_verifier_lock; then
  echo "another .NET SDK verifier run is already in progress" >&2
  exit 1
fi

run_bounded() {
  local label="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  shift 3
  "$@" >"$stdout_path" 2>"$stderr_path" &
  app_pid=$!
  (
    sleep "$timeout_seconds"
    terminate_process "$app_pid"
  ) &
  watchdog_pid=$!
  local status=0
  wait "$app_pid" || status=$?
  app_pid=""
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  watchdog_pid=""
  if [[ "$status" -ne 0 ]]; then
    echo "$label failed or timed out" >&2
    return 1
  fi
}

packages_dir="$tmp_dir/packages"
mkdir -p "$packages_dir"
if ! dotnet pack "$package_dir/src/LogBrew/LogBrew.csproj" \
  --configuration Release \
  --output "$packages_dir" \
  -warnaserror >"$tmp_dir/pack.stdout" 2>"$tmp_dir/pack.stderr"; then
  fail_stage "package build"
fi
if ! dotnet msbuild "$package_dir/src/LogBrew/LogBrew.csproj" \
  -nologo -getProperty:Version >"$tmp_dir/version.stdout" 2>"$tmp_dir/version.stderr"; then
  fail_stage "package identity"
fi
package_version="$(tail -n 1 "$tmp_dir/version.stdout" | xargs)"
nupkg="$packages_dir/LogBrew.${package_version}.nupkg"
require_stage "package identity" test -f "$nupkg"
if ! python3 - "$nupkg" >"$tmp_dir/package.sha256" 2>"$tmp_dir/package-hash.stderr" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
with path.open("rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
then
  fail_stage "package identity"
fi
package_sha256="$(cat "$tmp_dir/package.sha256")"

asset_dir="$tmp_dir/assets"
mkdir -p "$asset_dir"
if ! python3 - "$nupkg" "$asset_dir" >"$tmp_dir/asset-extraction.stdout" 2>"$tmp_dir/asset-extraction.stderr" <<'PY'
import pathlib
import sys
import zipfile

nupkg = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
required = (
    "lib/netstandard2.0/LogBrew.dll",
    "lib/net8.0/LogBrew.dll",
)
with zipfile.ZipFile(nupkg) as archive:
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise SystemExit("duplicate nupkg entry")
    for name in names:
        parts = pathlib.PurePosixPath(name).parts
        if name.startswith("/") or ".." in parts:
            raise SystemExit("unsafe nupkg entry")
    for name in required:
        if name not in names:
            raise SystemExit("missing required nupkg asset")
        output = target / pathlib.PurePosixPath(name).name.replace("LogBrew", pathlib.PurePosixPath(name).parts[1])
        output.write_bytes(archive.read(name))
PY
then
  fail_stage "asset extraction"
fi

export DOTNET_CLI_HOME="$tmp_dir/dotnet-home"
export NUGET_PACKAGES="$tmp_dir/nuget-packages"
export NUGET_HTTP_CACHE_PATH="$tmp_dir/nuget-http-cache"
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
mkdir -p "$DOTNET_CLI_HOME" "$NUGET_PACKAGES" "$NUGET_HTTP_CACHE_PATH"
if ! python3 "$verifier" write-nuget-config "$packages_dir" "$tmp_dir/NuGet.config" \
  >"$tmp_dir/feed-config.stdout" 2>"$tmp_dir/feed-config.stderr"; then
  fail_stage "installed app feed configuration"
fi

app_dir="$tmp_dir/installed-app"
mkdir -p "$app_dir"
if ! cp "$repo_root/scripts/dotnet_durable_storage_preflight.cs" "$app_dir/LinuxDurableStoragePreflight.cs"; then
  fail_stage "installed app preflight source"
fi
if ! cp "$package_dir/src/LogBrew/DurableUnixNative.cs" "$app_dir/DurableUnixNative.cs"; then
  fail_stage "installed app Unix native resolver source"
fi
cat >"$app_dir/InstalledDurableApp.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <RollForward>Major</RollForward>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="LogBrew" Version="$package_version" />
  </ItemGroup>
</Project>
EOF
cat >"$app_dir/Program.cs" <<'CS'
using System.Diagnostics;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using LogBrew;

const string ApiKey = "lbw_ingest_dotnet_durable_fake";
const string FirstId = "evt_dotnet_durable_first";
const string SecondId = "evt_dotnet_durable_second";

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static bool WaitUntil(Func<bool> condition, TimeSpan timeout)
{
    var stopwatch = Stopwatch.StartNew();
    while (!condition() && stopwatch.Elapsed < timeout)
    {
        Thread.Sleep(10);
    }

    return condition();
}

static void RecordAdmissionWitness(string witnessDirectory, string stage)
{
    switch (stage)
    {
        case "runtime-validated":
        case "durable-client-created":
        case "first-admission-persisted":
        case "second-admission-persisted":
        case "retry-observed":
        case "pending-verified":
        case "durable-client-failed-validation":
        case "durable-client-failed-configuration":
        case "durable-client-failed-storage":
        case "durable-client-failed-state":
        case "durable-client-failed-sdk-unknown":
        case "durable-client-failed-non-sdk":
        case "linux-storage-preflight-passed":
        case "linux-storage-preflight-failed-native-bind":
        case "linux-storage-preflight-failed-parent-open-missing":
        case "linux-storage-preflight-failed-parent-open-denied":
        case "linux-storage-preflight-failed-parent-open-invalid":
        case "linux-storage-preflight-failed-parent-open-other":
        case "linux-storage-preflight-failed-parent-statx":
        case "linux-storage-preflight-failed-child-mkdir-open":
        case "linux-storage-preflight-failed-child-statx":
        case "linux-storage-preflight-failed-owner-create-open":
        case "linux-storage-preflight-failed-owner-statx-mode":
        case "linux-storage-preflight-failed-owner-lock":
        case "linux-storage-preflight-failed-root-remove":
        case "recovery-runtime-validated":
        case "recovery-client-created":
        case "recovery-accepted":
        case "recovery-pending-empty":
        case "recovery-health-ready":
        case "recovery-shutdown-complete":
        case "recovery-failed-storage":
        case "recovery-failed-terminal":
        case "recovery-failed-retry-exhausted":
        case "recovery-failed-retry-scheduled":
        case "recovery-failed-in-flight":
        case "recovery-failed-scheduled":
        case "recovery-failed-idle":
            break;
        default:
            throw new InvalidOperationException("invalid admission witness stage");
    }

    Require(Directory.Exists(witnessDirectory), "admission witness directory missing");
    var temporaryPath = Path.Combine(witnessDirectory, ".stage.tmp");
    var finalPath = Path.Combine(witnessDirectory, stage);
    using (var stream = new FileStream(
        temporaryPath,
        FileMode.CreateNew,
        FileAccess.Write,
        FileShare.Read,
        bufferSize: 4096,
        FileOptions.WriteThrough))
    {
        stream.Write("observed"u8);
        stream.Flush(flushToDisk: true);
    }

    File.Move(temporaryPath, finalPath);
}

static string ClassifyDurableClientCreationFailure(string code)
{
    return code switch
    {
        "validation_error" => "durable-client-failed-validation",
        "configuration_error" => "durable-client-failed-configuration",
        "storage_error" => "durable-client-failed-storage",
        "state_error" => "durable-client-failed-state",
        _ => "durable-client-failed-sdk-unknown",
    };
}

static string ClassifyRecoveryFailure(DeliveryHealthSnapshot health)
{
    if (health.PauseReason == DeliveryPauseReason.Storage)
    {
        return "recovery-failed-storage";
    }

    if (health.PauseReason == DeliveryPauseReason.RetryExhausted)
    {
        return "recovery-failed-retry-exhausted";
    }

    if (health.PauseReason != DeliveryPauseReason.None)
    {
        return "recovery-failed-terminal";
    }

    if (health.LastOutcome == DeliveryOutcome.RetryScheduled)
    {
        return "recovery-failed-retry-scheduled";
    }

    if (health.InFlight)
    {
        return "recovery-failed-in-flight";
    }

    if (health.WakePending || health.Activity == DeliveryActivityState.Scheduled)
    {
        return "recovery-failed-scheduled";
    }

    return "recovery-failed-idle";
}

static void RequireExpectedRuntime()
{
    var expectedOs = Environment.GetEnvironmentVariable("LOGBREW_EXPECTED_DURABLE_OS");
    var expectedArchitecture = Environment.GetEnvironmentVariable("LOGBREW_EXPECTED_DURABLE_ARCHITECTURE");
    var expectedRuntimeMajor = Environment.GetEnvironmentVariable("LOGBREW_EXPECTED_DURABLE_RUNTIME_MAJOR");
    if (expectedOs is null && expectedArchitecture is null && expectedRuntimeMajor is null)
    {
        return;
    }

    var actualOs = RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
        ? "linux"
        : RuntimeInformation.IsOSPlatform(OSPlatform.OSX)
            ? "macos"
            : RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? "windows"
                : "unsupported";
    var actualArchitecture = RuntimeInformation.ProcessArchitecture switch
    {
        Architecture.X64 => "x64",
        Architecture.Arm64 => "arm64",
        _ => "unsupported",
    };
    Require(
        string.Equals(expectedOs, actualOs, StringComparison.Ordinal)
            && string.Equals(expectedArchitecture, actualArchitecture, StringComparison.Ordinal)
            && int.TryParse(expectedRuntimeMajor, out var requiredMajor)
            && Environment.Version.Major == requiredMajor,
        "installed runtime environment mismatch");
}

static HashSet<string> PublicTypeNames(string assemblyPath, out HashSet<string> allTypeNames)
{
    using var stream = File.OpenRead(assemblyPath);
    using var pe = new PEReader(stream);
    var metadata = pe.GetMetadataReader();
    var publicNames = new HashSet<string>(StringComparer.Ordinal);
    allTypeNames = new HashSet<string>(StringComparer.Ordinal);
    foreach (var handle in metadata.TypeDefinitions)
    {
        var definition = metadata.GetTypeDefinition(handle);
        var name = metadata.GetString(definition.Name);
        allTypeNames.Add(name);
        if ((definition.Attributes & TypeAttributes.VisibilityMask) == TypeAttributes.Public)
        {
            publicNames.Add(name);
        }
    }

    return publicNames;
}

var admissionWitnessDirectory = args.Length == 6 && args[0] == "admit" ? args[4] : null;
var recoveryWitnessDirectory = args.Length == 5 && args[0] == "recover" ? args[4] : null;
RequireExpectedRuntime();
if (admissionWitnessDirectory is not null)
{
    RecordAdmissionWitness(admissionWitnessDirectory, "runtime-validated");
}
else if (recoveryWitnessDirectory is not null)
{
    RecordAdmissionWitness(recoveryWitnessDirectory, "recovery-runtime-validated");
}

if (args.Length == 3 && args[0] == "inspect-assets")
{
    var standardPublic = PublicTypeNames(args[1], out var standardAll);
    var net8Public = PublicTypeNames(args[2], out var net8All);
    Require(!standardPublic.Contains("DurableDeliveryKey"), "netstandard asset exposed durable key API");
    Require(!standardPublic.Contains("DurableDeliveryOptions"), "netstandard asset exposed durable options API");
    Require(net8Public.Contains("DurableDeliveryKey"), "net8 asset omitted durable key API");
    Require(net8Public.Contains("DurableDeliveryOptions"), "net8 asset omitted durable options API");
    Require(!standardAll.Contains("DurableStoreTestHooks"), "netstandard asset included test hooks");
    Require(!net8All.Contains("DurableStoreTestHooks"), "net8 asset included test hooks");
    return;
}

Require(
    (args.Length == 6 && args[0] == "admit") || (args.Length == 5 && args[0] == "recover"),
    "expected mode, store, endpoint, package version, admission witness, and preflight root");
var mode = args[0];
var parentDirectory = args[1];
var preflightParentDirectory = mode == "admit" ? args[5] : null;
var endpoint = new Uri(args[2], UriKind.Absolute);
var expectedVersion = args[3];
var informationVersion = typeof(LogBrewClient).Assembly
    .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
    .InformationalVersion.Split('+')[0];
Require(informationVersion == expectedVersion, "installed package version changed");
Require(typeof(LogBrewClient).GetMethod(nameof(LogBrewClient.PurgeDurableDelivery)) != null, "PurgeDurableDelivery API missing");

if (mode == "admit"
    && OperatingSystem.IsLinux()
    && !LinuxDurableStoragePreflight.Run(
        preflightParentDirectory!,
        stage => RecordAdmissionWitness(admissionWitnessDirectory!, stage)))
{
    Environment.ExitCode = 1;
    return;
}

var keyBytes = Convert.FromHexString(
    "3131313131313131313131313131313131313131313131313131313131313131");
using var key = new DurableDeliveryKey("primary-2026", keyBytes);
using var storage = new DurableDeliveryOptions(parentDirectory, key);
using var transport = new HttpTransport(new HttpTransportOptions
{
    Endpoint = endpoint,
    Timeout = TimeSpan.FromSeconds(5),
});
LogBrewClient? client = null;
try
{
    client = LogBrewClient.CreateAutomaticDurable(
        ApiKey,
        "dotnet-durable-installed",
        expectedVersion,
        transport,
        storage,
        new AutomaticDeliveryOptions
        {
            FlushAtQueueSize = 2,
            FlushInterval = TimeSpan.FromHours(1),
            MaxQueueSize = 1000,
            MaxQueueBytes = 4 * 1024 * 1024,
            MaxRetries = 2,
            RetryBaseDelay = TimeSpan.FromSeconds(30),
            MaxRetryDelay = TimeSpan.FromSeconds(30),
        });
}
catch (SdkException error) when (admissionWitnessDirectory is not null)
{
    RecordAdmissionWitness(
        admissionWitnessDirectory,
        ClassifyDurableClientCreationFailure(error.Code));
}
catch (Exception) when (admissionWitnessDirectory is not null)
{
    RecordAdmissionWitness(admissionWitnessDirectory, "durable-client-failed-non-sdk");
}

if (client is null)
{
    Environment.ExitCode = 1;
    return;
}

if (admissionWitnessDirectory is not null)
{
    RecordAdmissionWitness(admissionWitnessDirectory, "durable-client-created");
}
else if (recoveryWitnessDirectory is not null)
{
    RecordAdmissionWitness(recoveryWitnessDirectory, "recovery-client-created");
}

if (mode == "admit")
{
    client.Log(FirstId, "2026-06-02T10:00:00Z", LogAttributes.Create("durable first", "info"));
    RecordAdmissionWitness(admissionWitnessDirectory!, "first-admission-persisted");
    client.Log(SecondId, "2026-06-02T10:00:01Z", LogAttributes.Create("durable second", "info"));
    RecordAdmissionWitness(admissionWitnessDirectory!, "second-admission-persisted");
    Require(
        WaitUntil(
            () => client.DeliveryHealth().LastOutcome == DeliveryOutcome.RetryScheduled,
            TimeSpan.FromSeconds(10)),
        "initial retry was not scheduled");
    RecordAdmissionWitness(admissionWitnessDirectory!, "retry-observed");
    Require(client.PendingEvents() == 2, "failed prefix was not retained");
    RecordAdmissionWitness(admissionWitnessDirectory!, "pending-verified");
    Thread.Sleep(Timeout.Infinite);
}

Require(mode == "recover", "unsupported mode");
if (!WaitUntil(
    () => client.DeliveryHealth().AcceptedEvents == 2,
    TimeSpan.FromSeconds(10)))
{
    RecordAdmissionWitness(
        recoveryWitnessDirectory!,
        ClassifyRecoveryFailure(client.DeliveryHealth()));
    Environment.ExitCode = 1;
    return;
}
RecordAdmissionWitness(recoveryWitnessDirectory!, "recovery-accepted");
Require(client.PendingEvents() == 0, "accepted prefix remained queued");
RecordAdmissionWitness(recoveryWitnessDirectory!, "recovery-pending-empty");
var health = client.DeliveryHealth();
Require(health.PauseReason == DeliveryPauseReason.None, "recovered client remained paused");
RecordAdmissionWitness(recoveryWitnessDirectory!, "recovery-health-ready");
Require(client.Shutdown().StatusCode == 204, "recovered client shutdown failed");
RecordAdmissionWitness(recoveryWitnessDirectory!, "recovery-shutdown-complete");
Console.WriteLine(
    "{\"status\":\"passed\",\"acceptedEvents\":2,\"queuedEvents\":0,\"pauseReason\":\"None\",\"packageVersion\":\""
    + expectedVersion
    + "\"}");

CS

if ! dotnet restore "$app_dir/InstalledDurableApp.csproj" --configfile "$tmp_dir/NuGet.config" \
  >"$tmp_dir/restore.stdout" 2>"$tmp_dir/restore.stderr"; then
  fail_stage "installed app dependency resolution"
fi
if ! dotnet build "$app_dir/InstalledDurableApp.csproj" --configuration Release --no-restore -warnaserror \
  >"$tmp_dir/build.stdout" 2>"$tmp_dir/build.stderr"; then
  fail_stage "installed app build"
fi
app_dll="$app_dir/bin/Release/net8.0/InstalledDurableApp.dll"
require_stage "installed app build" test -f "$app_dll"

if run_bounded \
  "runtime identity negative probe" \
  "$tmp_dir/runtime-identity-negative.stdout" \
  "$tmp_dir/runtime-identity-negative.stderr" \
  env \
    LOGBREW_EXPECTED_DURABLE_OS=invalid-os \
    LOGBREW_EXPECTED_DURABLE_ARCHITECTURE=invalid-architecture \
    LOGBREW_EXPECTED_DURABLE_RUNTIME_MAJOR=999 \
    dotnet "$app_dll" inspect-assets "$asset_dir/netstandard2.0.dll" "$asset_dir/net8.0.dll" \
  2>"$tmp_dir/runtime-identity-negative-helper.stderr"; then
  echo "runtime identity negative probe unexpectedly succeeded" >&2
  exit 1
fi
require_empty_stage "runtime identity negative output" "$tmp_dir/runtime-identity-negative.stdout"
require_stage "runtime identity negative output" \
  grep -Fq "installed runtime environment mismatch" "$tmp_dir/runtime-identity-negative.stderr"
require_stage "runtime identity negative output" \
  grep -qx "runtime identity negative probe failed or timed out" \
    "$tmp_dir/runtime-identity-negative-helper.stderr"

run_bounded \
  "asset inspection" \
  "$tmp_dir/asset-inspector.stdout" \
  "$tmp_dir/asset-inspector.stderr" \
  dotnet "$app_dll" inspect-assets "$asset_dir/netstandard2.0.dll" "$asset_dir/net8.0.dll"
require_empty_stage "asset inspection output" "$tmp_dir/asset-inspector.stdout"
require_empty_stage "asset inspection output" "$tmp_dir/asset-inspector.stderr"

server_dir="$tmp_dir/intake"
mkdir -p "$server_dir"
python3 "$verifier" serve-intake "$server_dir" "Bearer lbw_ingest_dotnet_durable_fake" \
  >"$tmp_dir/intake.stdout" 2>"$tmp_dir/intake.stderr" &
server_pid=$!
for _ in {1..200}; do
  [[ -s "$server_dir/port" ]] && break
  sleep 0.05
done
require_stage "fake intake startup" test -s "$server_dir/port"
endpoint="http://127.0.0.1:$(cat "$server_dir/port")/v1/events"
store_root="$tmp_dir/durable-parent"
mkdir -p "$store_root"
chmod 700 "$store_root" 2>/dev/null || true
preflight_root="$tmp_dir/durable-preflight-parent"
mkdir -p "$preflight_root"
chmod 700 "$preflight_root" 2>/dev/null || true

witness_dir="$tmp_dir/admission-witness"
mkdir -p "$witness_dir"
if ! python3 "$verifier" kill-after-ready \
  "$witness_dir" \
  "$server_dir/request-1.bin" \
  "$tmp_dir/admit.stdout" \
  "$tmp_dir/admit.stderr" \
  "$timeout_seconds" \
  -- dotnet "$app_dll" admit "$store_root" "$endpoint" "$package_version" "$witness_dir" "$preflight_root"; then
  exit 1
fi
require_empty_stage "admission output" "$tmp_dir/admit.stdout"
require_empty_stage "admission output" "$tmp_dir/admit.stderr"
require_stage "external kill witness validation" test -s "$witness_dir/external-kill-requested"
require_stage "post-kill reap witness validation" test -s "$witness_dir/post-kill-reaped"

if ! python3 - "$store_root" >"$tmp_dir/encrypted-storage.stdout" 2>"$tmp_dir/encrypted-storage.stderr" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
child = root / ".logbrew-delivery-v1"
names = sorted(path.name for path in child.iterdir())
if names != [
    ".owner",
    "delivery-state.lbd",
    "event-00000000000000000001.lbd",
    "event-00000000000000000002.lbd",
]:
    raise SystemExit("unexpected durable record set")
forbidden = (
    b"lbw_ingest_dotnet_durable_fake",
    b"evt_dotnet_durable_first",
    b"evt_dotnet_durable_second",
    b"durable first",
    b"durable second",
    bytes.fromhex("3131313131313131313131313131313131313131313131313131313131313131"),
    str(root).encode(),
)
for path in child.iterdir():
    data = path.read_bytes()
    if any(value in data for value in forbidden):
        raise SystemExit("durable storage leaked protected content")
PY
then
  fail_stage "encrypted storage validation"
fi

recovery_witness_dir="$tmp_dir/recovery-witness"
mkdir -p "$recovery_witness_dir"
if ! run_bounded \
  "installed recovery process" \
  "$tmp_dir/recover.stdout" \
  "$tmp_dir/recover.stderr" \
  dotnet "$app_dll" recover "$store_root" "$endpoint" "$package_version" "$recovery_witness_dir"; then
  recovery_stage="$(python3 "$verifier" recovery-stage "$recovery_witness_dir")"
  recovery_storage_stage="$(python3 "$verifier" recovery-storage-stage "$store_root")"
  printf 'installed recovery failed after %s\n' "$recovery_stage" >&2
  printf 'installed recovery storage state %s\n' "$recovery_storage_stage" >&2
  exit 1
fi
recovery_stage="$(python3 "$verifier" recovery-stage "$recovery_witness_dir")"
require_stage "recovery witness validation" test "$recovery_stage" = "recovery-shutdown-complete"
require_empty_stage "recovery output" "$tmp_dir/recover.stderr"
require_stage "recovery output" \
  grep -qx "{\"status\":\"passed\",\"acceptedEvents\":2,\"queuedEvents\":0,\"pauseReason\":\"None\",\"packageVersion\":\"$package_version\"}" \
    "$tmp_dir/recover.stdout"

if ! wait "$server_pid"; then
  fail_stage "fake intake completion"
fi
server_pid=""
require_empty_stage "fake intake completion" "$tmp_dir/intake.stdout"
require_empty_stage "fake intake completion" "$tmp_dir/intake.stderr"
require_stage "fake intake completion" test -s "$server_dir/request-2.bin"
require_stage "retry body identity" cmp "$server_dir/request-1.bin" "$server_dir/request-2.bin"

if ! python3 - "$server_dir/request-1.bin" "$store_root" "$tmp_dir/recover.stdout" "$endpoint" \
  >"$tmp_dir/accepted-storage.stdout" 2>"$tmp_dir/accepted-storage.stderr" <<'PY'
from pathlib import Path
import json
import sys

body = Path(sys.argv[1]).read_bytes()
payload = json.loads(body)
events = payload.get("events")
if not isinstance(events, list):
    raise SystemExit("request events missing")
ids = [event.get("id") for event in events]
if ids != ["evt_dotnet_durable_first", "evt_dotnet_durable_second"]:
    raise SystemExit("request order changed")
child = Path(sys.argv[2]) / ".logbrew-delivery-v1"
if sorted(path.name for path in child.iterdir()) != [".owner"]:
    raise SystemExit("accepted durable records remain")
output = Path(sys.argv[3]).read_text(encoding="utf-8")
for forbidden in (
    "lbw_ingest_dotnet_durable_fake",
    "evt_dotnet_durable_first",
    "evt_dotnet_durable_second",
    str(Path(sys.argv[2])),
    sys.argv[4],
):
    if forbidden in output:
        raise SystemExit("consumer output leaked protected content")
PY
then
  fail_stage "accepted storage validation"
fi

printf 'dotnet durable delivery smoke passed: version=%s digest=sha256:%s requests=2\n' \
  "$package_version" "$package_sha256"
