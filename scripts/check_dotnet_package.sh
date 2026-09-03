#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/dotnet/logbrew-dotnet"
tmp_dir="$(mktemp -d)"
tmp_dir="$(cd "$tmp_dir" && pwd -P)"
source "$repo_root/scripts/dotnet_verifier_lock.sh"

clean_generated_artifacts() {
  find "$package_dir" -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + 2>/dev/null || true
}

clean_after_run() {
  rm -rf "$tmp_dir"
  clean_generated_artifacts
  release_dotnet_verifier_lock
}

trap clean_after_run EXIT

if ! acquire_dotnet_verifier_lock; then
  echo "another .NET SDK verifier run is already in progress" >&2
  exit 1
fi

package_ids=(LogBrew LogBrew.AspNetCore LogBrew.EntityFrameworkCore LogBrew.Hangfire LogBrew.HttpClient LogBrew.StackExchangeRedis LogBrew.OpenTelemetry)
for package_id in "${package_ids[@]}"; do
  project="$package_dir/src/$package_id/$package_id.csproj"
  dotnet build "$project" --configuration Release -warnaserror >/dev/null
  dotnet pack "$project" --configuration Release --output "$tmp_dir/packages" >/dev/null
  version="$(dotnet msbuild "$project" -nologo -getProperty:Version | tail -n 1 | xargs)"
  archive_variable="${package_id//./_}_nupkg"
  printf -v "$archive_variable" '%s' "$tmp_dir/packages/$package_id.${version}.nupkg"
  test -f "${!archive_variable}"
done
for package_id in "${package_ids[@]}"; do
  dotnet run --project "$package_dir/tests/$package_id.Tests/$package_id.Tests.csproj" --configuration Release
done
# shellcheck disable=SC2154
python3 - "$LogBrew_nupkg" <<'PY'
import sys
import zipfile

nupkg = sys.argv[1]
with zipfile.ZipFile(nupkg) as archive:
    names = set(archive.namelist())
    required = {
        "lib/netstandard2.0/LogBrew.dll",
        "lib/net8.0/LogBrew.dll",
        "README.md",
        "logbrew-logo-transparent-128.png",
        "examples/ReadmeExample.cs",
        "examples/RealUserSmoke.cs",
        "examples/IssueDiagnostics.cs",
        "examples/FirstUsefulTelemetry.cs",
        "examples/HttpTraceCorrelation.cs",
        "examples/ActivityTraceCorrelation.cs",
        "examples/ActivitySourceListenerTelemetry.cs",
        "examples/DependencySpansTelemetry.cs",
        "examples/DbCommandTelemetry.cs",
        "examples/HttpClientOutboundTelemetry.cs",
        "examples/AspNetCoreRequestTelemetry.cs",
        "examples/Makefile",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing nupkg files: {missing}")
    core_property_files = {
        name for name in names
        if name.startswith("package/services/metadata/core-properties/")
        and name.endswith(".psmdcp")
    }
    if len(core_property_files) != 1:
        raise SystemExit("expected exactly one NuGet core-properties file")
    allowed = required | core_property_files | {
        "_rels/.rels",
        "LogBrew.nuspec",
        "[Content_Types].xml",
    }
    unexpected = sorted(names - allowed)
    if unexpected:
        raise SystemExit(f"unexpected nupkg files: {unexpected}")
    readme = archive.read("README.md").decode()
    nuspec = archive.read("LogBrew.nuspec").decode()
if 'dependency id="Microsoft.Extensions.Logging"' not in nuspec:
    raise SystemExit("missing Microsoft.Extensions.Logging dependency metadata")
if "<icon>logbrew-logo-transparent-128.png</icon>" not in nuspec:
    raise SystemExit("missing NuGet package icon metadata")
for needle in (
    "dotnet add package LogBrew",
    "LOGBREW_API_KEY",
    "PreviewJson()",
    "IssueAttributes.FromException",
    "IssueExceptionInfo",
    "IssueDiagnostics.cs",
    "raw stack text",
    "## Shared Telemetry Context",
    "TelemetryContext",
    "TelemetryResource",
    "LogBrewClientOptions",
    "DisableRuntimeContext",
    "LogBrewTelemetry.ActivateContext",
    "schemaVersion: 1",
    "MetricAttributes",
    'Metrics answer "how much?"',
    "This SDK does not automatically collect CLR, runtime, or framework metrics yet.",
    "ProductTimeline",
    "without visual replay, HTTP client patching, request/response payload capture, or header capture",
    "Traceparent",
    "LogBrewHttpRequestTelemetry",
    "LogBrewTrace.Current",
    "TryCreateChildFromCurrentActivity",
    "TryCreateChildFromActivityContext",
    "ActivityTraceCorrelation.cs",
    "ActivitySourceListenerTelemetry.cs",
    "DependencySpansTelemetry.cs",
    "DbCommandTelemetry.cs",
    "LogBrewDbCommandTelemetry",
    "LogBrewDbCommandOptions",
    "dotnet add package LogBrew.StackExchangeRedis",
    "dotnet add package LogBrew.OpenTelemetry",
    "TraceLogBrewCommand",
    "StackExchangeRedisCommandTelemetry.cs",
    "OpenTelemetrySpanProcessorTelemetry.cs",
    "LogBrewActivitySourceListener",
    "WithHttpClientSources",
    "WithCommonDotNetSources",
    "WithServiceName",
    "WithServiceVersion",
    "WithDeploymentEnvironment",
    "Calling `Start(client)` without source names is fail-closed",
    "does not create OpenTelemetry processors, exporters",
    "LogBrewHttpClientTelemetry",
    "LogBrewHttpClientHandler",
    "WithRouteTemplateSelector",
    "WithRequestFilter",
    "WithContextProvider",
    "HttpClientOutboundTelemetry.cs",
    "MetadataWithCurrentTrace",
    "HttpTraceCorrelation.cs",
    "LogBrewOperationTracing",
    "SpanEventSummary",
    "exceptionEscaped",
    "LogBrewServerRequestTelemetry",
    "AspNetCoreRequestTelemetry.cs",
    "dotnet add package LogBrew.AspNetCore",
    "builder.AddLogBrew()",
    "app.UseLogBrew()",
    "LogBrewAspNetCoreRuntime.Health()",
    "UseLogBrewRequestTelemetry",
    "AddLogBrewDependencyActivitySourceTelemetry",
    "UseLogBrewDependencyActivitySourceTelemetry",
    "AspNetCoreMiddlewareTelemetry.cs",
    "does not patch ASP.NET Core",
    "first useful .NET service telemetry",
    "HttpTransport",
    "System.Net.Http",
    "CreateAutomatic",
    "CreateAutomaticDurable",
    "AutomaticDeliveryOptions",
    "DurableDeliveryKey",
    "DurableDeliveryOptions",
    "PurgeDurableDelivery()",
    "encrypted restart delivery is available only to .NET 8 applications",
    "DeliveryHealth()",
    "RecoverAutomaticDelivery()",
    "at-least-once ambiguity",
    "AddLogBrew(client",
    "Microsoft.Extensions.Logging",
    "IncludeExceptionStackTrace",
    "SupportTicketDraft",
    "This helper does not send data, open support tickets",
    "copyable snippets",
):
    if needle not in readme:
        raise SystemExit(f"missing README guidance: {needle}")
PY

# shellcheck disable=SC2154
for integration_nupkg in "$LogBrew_AspNetCore_nupkg" "$LogBrew_EntityFrameworkCore_nupkg" "$LogBrew_Hangfire_nupkg" "$LogBrew_OpenTelemetry_nupkg" "$LogBrew_StackExchangeRedis_nupkg"; do
  python3 "$repo_root/scripts/check_dotnet_integration_nupkg.py" "$integration_nupkg" >/dev/null
done

run_example() {
  local source_file="$1"
  local project_name="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  local app_dir="$tmp_dir/$project_name"
  dotnet new console --framework net10.0 --name "$project_name" --output "$app_dir" >/dev/null
  cp "$package_dir/examples/$source_file" "$app_dir/Program.cs"
  cat > "$app_dir/$project_name.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="$package_dir/src/LogBrew/LogBrew.csproj" />
  </ItemGroup>
</Project>
EOF
  dotnet run --project "$app_dir/$project_name.csproj" --configuration Release > "$stdout_path" 2> "$stderr_path"
}

run_example ReadmeExample.cs ReadmeExample "$tmp_dir/readme-example.stdout.json" "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme-example.stderr.json"

run_example RealUserSmoke.cs RealUserSmoke "$tmp_dir/real-user-smoke.stdout.json" "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"supportDraftRedacted":true' "$tmp_dir/real-user-smoke.stderr.json"

run_example IssueDiagnostics.cs IssueDiagnostics "$tmp_dir/issue-diagnostics.stdout.json" "$tmp_dir/issue-diagnostics.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/issue-diagnostics.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_issue_diagnostics_payload.py" "$tmp_dir/issue-diagnostics.stdout.json" "$tmp_dir/issue-diagnostics.stderr.json" >/dev/null

run_example FirstUsefulTelemetry.cs FirstUsefulTelemetry "$tmp_dir/first-useful.stdout.json" "$tmp_dir/first-useful.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/first-useful.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_first_useful_payload.py" "$tmp_dir/first-useful.stdout.json" "$tmp_dir/first-useful.stderr.json" >/dev/null

run_example HttpTraceCorrelation.cs HttpTraceCorrelation "$tmp_dir/http-trace.stdout.json" "$tmp_dir/http-trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/http-trace.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_http_trace_payload.py" "$tmp_dir/http-trace.stdout.json" "$tmp_dir/http-trace.stderr.json" >/dev/null

run_example ActivityTraceCorrelation.cs ActivityTraceCorrelation "$tmp_dir/activity-trace.stdout.json" "$tmp_dir/activity-trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/activity-trace.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_activity_trace_payload.py" "$tmp_dir/activity-trace.stdout.json" "$tmp_dir/activity-trace.stderr.json" >/dev/null

run_example ActivitySourceListenerTelemetry.cs ActivitySourceListenerTelemetry "$tmp_dir/activity-source-listener.stdout.json" "$tmp_dir/activity-source-listener.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/activity-source-listener.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_activity_source_listener_payload.py" "$tmp_dir/activity-source-listener.stdout.json" "$tmp_dir/activity-source-listener.stderr.json" >/dev/null

run_example DependencySpansTelemetry.cs DependencySpansTelemetry "$tmp_dir/dependency-spans.stdout.json" "$tmp_dir/dependency-spans.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/dependency-spans.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_dependency_spans_payload.py" "$tmp_dir/dependency-spans.stdout.json" "$tmp_dir/dependency-spans.stderr.json" >/dev/null

run_example DbCommandTelemetry.cs DbCommandTelemetry "$tmp_dir/db-command.stdout.json" "$tmp_dir/db-command.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/db-command.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_db_command_payload.py" "$tmp_dir/db-command.stdout.json" "$tmp_dir/db-command.stderr.json" >/dev/null

run_example HttpClientOutboundTelemetry.cs HttpClientOutboundTelemetry "$tmp_dir/http-client.stdout.json" "$tmp_dir/http-client.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/http-client.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_http_client_payload.py" "$tmp_dir/http-client.stdout.json" "$tmp_dir/http-client.stderr.json" >/dev/null

run_integration_example() {
  local package_id="$1"
  local example="$2"
  local output_name="$3"
  local app_dir="$tmp_dir/$example"
  dotnet new console --framework net10.0 --name "$example" --output "$app_dir" >/dev/null
  cp "$package_dir/examples/$example.cs" "$app_dir/Program.cs"
  dotnet add "$app_dir/$example.csproj" reference \
    "$package_dir/src/LogBrew/LogBrew.csproj" \
    "$package_dir/src/$package_id/$package_id.csproj" >/dev/null
  dotnet run --project "$app_dir/$example.csproj" --configuration Release -warnaserror \
    > "$tmp_dir/$output_name.stdout.json" 2> "$tmp_dir/$output_name.stderr.json"
}

run_integration_example LogBrew.EntityFrameworkCore EntityFrameworkCoreCommandTelemetry efcore
test ! -s "$tmp_dir/efcore.stdout.json"
grep -q '"example":"EntityFrameworkCoreCommandTelemetry"' "$tmp_dir/efcore.stderr.json"

run_integration_example LogBrew.StackExchangeRedis StackExchangeRedisCommandTelemetry stackexchange-redis
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/stackexchange-redis.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_stackexchange_redis_payload.py" "$tmp_dir/stackexchange-redis.stdout.json" "$tmp_dir/stackexchange-redis.stderr.json" >/dev/null

run_integration_example LogBrew.OpenTelemetry OpenTelemetrySpanProcessorTelemetry opentelemetry
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/opentelemetry.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_opentelemetry_payload.py" "$tmp_dir/opentelemetry.stdout.json" "$tmp_dir/opentelemetry.stderr.json" >/dev/null

web_dir="$tmp_dir/AspNetCoreRequestTelemetry"
dotnet new web --framework net10.0 --name AspNetCoreRequestTelemetry --output "$web_dir" >/dev/null
cp "$package_dir/examples/AspNetCoreRequestTelemetry.cs" "$web_dir/Program.cs"
dotnet add "$web_dir/AspNetCoreRequestTelemetry.csproj" reference "$package_dir/src/LogBrew/LogBrew.csproj" >/dev/null
dotnet build "$web_dir/AspNetCoreRequestTelemetry.csproj" --configuration Release -warnaserror >/dev/null

middleware_web_dir="$tmp_dir/AspNetCoreMiddlewareTelemetry"
dotnet new web --framework net10.0 --name AspNetCoreMiddlewareTelemetry --output "$middleware_web_dir" >/dev/null
cp "$package_dir/examples/AspNetCoreMiddlewareTelemetry.cs" "$middleware_web_dir/Program.cs"
dotnet add "$middleware_web_dir/AspNetCoreMiddlewareTelemetry.csproj" reference \
  "$package_dir/src/LogBrew/LogBrew.csproj" \
  "$package_dir/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj" >/dev/null
dotnet build "$middleware_web_dir/AspNetCoreMiddlewareTelemetry.csproj" --configuration Release >/dev/null

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
grep -qx 'run-issue-diagnostics -> make run-issue-diagnostics' "$tmp_dir/examples-help.txt"
grep -qx 'run-first-useful-telemetry -> make run-first-useful-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' "$tmp_dir/examples-help.txt"
grep -qx 'run-activity-trace-correlation -> make run-activity-trace-correlation' "$tmp_dir/examples-help.txt"
grep -qx 'run-activity-source-listener-telemetry -> make run-activity-source-listener-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-dependency-spans-telemetry -> make run-dependency-spans-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-db-command-telemetry -> make run-db-command-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-http-client-outbound-telemetry -> make run-http-client-outbound-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-entity-framework-core-command-telemetry -> make run-entity-framework-core-command-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-stackexchange-redis-command-telemetry -> make run-stackexchange-redis-command-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-opentelemetry-span-processor-telemetry -> make run-opentelemetry-span-processor-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-aspnetcore-request-telemetry -> make run-aspnetcore-request-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-aspnetcore-middleware-telemetry -> make run-aspnetcore-middleware-telemetry' "$tmp_dir/examples-help.txt"

LOGBREW_DOTNET_VERIFIER_LOCK_HELD=1 bash "$repo_root/scripts/real_user_dotnet_httpclient_factory_smoke.sh"

echo "dotnet package checks passed"
