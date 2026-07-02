#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/dotnet/logbrew-dotnet"
tmp_dir="$(mktemp -d)"
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

dotnet build "$package_dir/src/LogBrew/LogBrew.csproj" --configuration Release -warnaserror >/dev/null
dotnet build "$package_dir/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj" --configuration Release -warnaserror >/dev/null
dotnet build "$package_dir/src/LogBrew.EntityFrameworkCore/LogBrew.EntityFrameworkCore.csproj" --configuration Release -warnaserror >/dev/null
dotnet build "$package_dir/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj" --configuration Release -warnaserror >/dev/null
dotnet build "$package_dir/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj" --configuration Release -warnaserror >/dev/null
dotnet run --project "$package_dir/tests/LogBrew.Tests/LogBrew.Tests.csproj" --configuration Release
dotnet run --project "$package_dir/tests/LogBrew.AspNetCore.Tests/LogBrew.AspNetCore.Tests.csproj" --configuration Release
dotnet run --project "$package_dir/tests/LogBrew.EntityFrameworkCore.Tests/LogBrew.EntityFrameworkCore.Tests.csproj" --configuration Release
dotnet run --project "$package_dir/tests/LogBrew.StackExchangeRedis.Tests/LogBrew.StackExchangeRedis.Tests.csproj" --configuration Release
dotnet run --project "$package_dir/tests/LogBrew.OpenTelemetry.Tests/LogBrew.OpenTelemetry.Tests.csproj" --configuration Release
dotnet pack "$package_dir/src/LogBrew/LogBrew.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
dotnet pack "$package_dir/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
dotnet pack "$package_dir/src/LogBrew.EntityFrameworkCore/LogBrew.EntityFrameworkCore.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
dotnet pack "$package_dir/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
dotnet pack "$package_dir/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
package_version="$(dotnet msbuild "$package_dir/src/LogBrew/LogBrew.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
aspnetcore_package_version="$(dotnet msbuild "$package_dir/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
efcore_package_version="$(dotnet msbuild "$package_dir/src/LogBrew.EntityFrameworkCore/LogBrew.EntityFrameworkCore.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
redis_package_version="$(dotnet msbuild "$package_dir/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
otel_package_version="$(dotnet msbuild "$package_dir/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj" -nologo -getProperty:Version | tail -n 1 | xargs)"
nupkg="$tmp_dir/packages/LogBrew.${package_version}.nupkg"
aspnetcore_nupkg="$tmp_dir/packages/LogBrew.AspNetCore.${aspnetcore_package_version}.nupkg"
efcore_nupkg="$tmp_dir/packages/LogBrew.EntityFrameworkCore.${efcore_package_version}.nupkg"
redis_nupkg="$tmp_dir/packages/LogBrew.StackExchangeRedis.${redis_package_version}.nupkg"
otel_nupkg="$tmp_dir/packages/LogBrew.OpenTelemetry.${otel_package_version}.nupkg"
test -f "$nupkg"
test -f "$aspnetcore_nupkg"
test -f "$efcore_nupkg"
test -f "$redis_nupkg"
test -f "$otel_nupkg"

python3 - "$nupkg" <<'PY'
import sys
import zipfile

nupkg = sys.argv[1]
with zipfile.ZipFile(nupkg) as archive:
    names = set(archive.namelist())
    required = {
        "lib/netstandard2.0/LogBrew.dll",
        "README.md",
        "logbrew-logo-transparent-128.png",
        "examples/ReadmeExample.cs",
        "examples/RealUserSmoke.cs",
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
    "MetricAttributes",
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
    "HttpClientOutboundTelemetry.cs",
    "MetadataWithCurrentTrace",
    "HttpTraceCorrelation.cs",
    "LogBrewOperationTracing",
    "SpanEventSummary",
    "exceptionEscaped",
    "LogBrewServerRequestTelemetry",
    "AspNetCoreRequestTelemetry.cs",
    "dotnet add package LogBrew.AspNetCore",
    "UseLogBrewRequestTelemetry",
    "AddLogBrewDependencyActivitySourceTelemetry",
    "UseLogBrewDependencyActivitySourceTelemetry",
    "AspNetCoreMiddlewareTelemetry.cs",
    "does not patch ASP.NET Core",
    "first useful .NET service telemetry",
    "HttpTransport",
    "System.Net.Http",
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

python3 "$repo_root/scripts/check_dotnet_stackexchange_redis_nupkg.py" "$redis_nupkg" >/dev/null

python3 - "$otel_nupkg" <<'PY'
import sys
import zipfile

nupkg = sys.argv[1]
with zipfile.ZipFile(nupkg) as archive:
    names = set(archive.namelist())
    required = {
        "lib/netstandard2.0/LogBrew.OpenTelemetry.dll",
        "README.md",
        "logbrew-logo-espresso-bg-128.png",
        "examples/OpenTelemetrySpanProcessorTelemetry.cs",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing OpenTelemetry nupkg files: {missing}")
    readme = archive.read("README.md").decode()
    nuspec = archive.read("LogBrew.OpenTelemetry.nuspec").decode()
if 'dependency id="LogBrew"' not in nuspec:
    raise SystemExit("missing LogBrew dependency metadata")
if 'dependency id="OpenTelemetry"' not in nuspec:
    raise SystemExit("missing OpenTelemetry dependency metadata")
if "<icon>logbrew-logo-espresso-bg-128.png</icon>" not in nuspec:
    raise SystemExit("missing OpenTelemetry NuGet package icon metadata")
for needle in (
    "dotnet add package LogBrew.OpenTelemetry",
    "TracerProviderBuilder.AddLogBrew",
    "LogBrewOpenTelemetrySpanProcessor",
    "WithServiceName",
    "WithDeploymentEnvironment",
    "does not create an OpenTelemetry provider",
    "payload/header/full-URL/query capture",
    "OpenTelemetrySpanProcessorTelemetry.cs",
):
    if needle not in readme:
        raise SystemExit(f"missing OpenTelemetry README guidance: {needle}")
PY

python3 - "$aspnetcore_nupkg" <<'PY'
import sys
import zipfile

nupkg = sys.argv[1]
with zipfile.ZipFile(nupkg) as archive:
    names = set(archive.namelist())
    required = {
        "lib/net10.0/LogBrew.AspNetCore.dll",
        "README.md",
        "logbrew-logo-espresso-bg-128.png",
        "examples/AspNetCoreMiddlewareTelemetry.cs",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing ASP.NET Core nupkg files: {missing}")
    readme = archive.read("README.md").decode()
    nuspec = archive.read("LogBrew.AspNetCore.nuspec").decode()
if 'dependency id="LogBrew"' not in nuspec:
    raise SystemExit("missing LogBrew dependency metadata")
if "<icon>logbrew-logo-espresso-bg-128.png</icon>" not in nuspec:
    raise SystemExit("missing ASP.NET Core NuGet package icon metadata")
for needle in (
    "dotnet add package LogBrew.AspNetCore",
    "UseLogBrewRequestTelemetry",
    "AddLogBrewDependencyActivitySourceTelemetry",
    "UseLogBrewDependencyActivitySourceTelemetry",
    "WithRequestFilter",
    "WithRouteTemplateSelector",
    "does not read request or response bodies",
    "AspNetCoreMiddlewareTelemetry.cs",
):
    if needle not in readme:
        raise SystemExit(f"missing ASP.NET Core README guidance: {needle}")
PY

python3 - "$efcore_nupkg" <<'PY'
import sys
import zipfile

nupkg = sys.argv[1]
with zipfile.ZipFile(nupkg) as archive:
    names = set(archive.namelist())
    required = {
        "lib/net10.0/LogBrew.EntityFrameworkCore.dll",
        "README.md",
        "logbrew-logo-espresso-bg-128.png",
        "examples/EntityFrameworkCoreCommandTelemetry.cs",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing Entity Framework Core nupkg files: {missing}")
    readme = archive.read("README.md").decode()
    nuspec = archive.read("LogBrew.EntityFrameworkCore.nuspec").decode()
if 'dependency id="LogBrew"' not in nuspec:
    raise SystemExit("missing LogBrew dependency metadata")
if 'dependency id="Microsoft.EntityFrameworkCore.Relational"' not in nuspec:
    raise SystemExit("missing Microsoft.EntityFrameworkCore.Relational dependency metadata")
if "<icon>logbrew-logo-espresso-bg-128.png</icon>" not in nuspec:
    raise SystemExit("missing Entity Framework Core NuGet package icon metadata")
for needle in (
    "dotnet add package LogBrew.EntityFrameworkCore",
    "AddLogBrewCommandTelemetry",
    "LogBrewEntityFrameworkCoreCommandInterceptor",
    "WithCommandFilter",
    "WithMetadataProvider",
    "does not capture raw database statements",
    "EntityFrameworkCoreCommandTelemetry.cs",
):
    if needle not in readme:
        raise SystemExit(f"missing Entity Framework Core README guidance: {needle}")
PY

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

efcore_dir="$tmp_dir/EntityFrameworkCoreCommandTelemetry"
dotnet new console --framework net10.0 --name EntityFrameworkCoreCommandTelemetry --output "$efcore_dir" >/dev/null
cp "$package_dir/examples/EntityFrameworkCoreCommandTelemetry.cs" "$efcore_dir/Program.cs"
cat > "$efcore_dir/EntityFrameworkCoreCommandTelemetry.csproj" <<EOF
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
    <ProjectReference Include="$package_dir/src/LogBrew.EntityFrameworkCore/LogBrew.EntityFrameworkCore.csproj" />
  </ItemGroup>
</Project>
EOF
dotnet run --project "$efcore_dir/EntityFrameworkCoreCommandTelemetry.csproj" --configuration Release > "$tmp_dir/efcore.stdout.txt" 2> "$tmp_dir/efcore.stderr.json"
test ! -s "$tmp_dir/efcore.stdout.txt"
grep -q '"example":"EntityFrameworkCoreCommandTelemetry"' "$tmp_dir/efcore.stderr.json"

redis_dir="$tmp_dir/StackExchangeRedisCommandTelemetry"
dotnet new console --framework net10.0 --name StackExchangeRedisCommandTelemetry --output "$redis_dir" >/dev/null
cp "$package_dir/examples/StackExchangeRedisCommandTelemetry.cs" "$redis_dir/Program.cs"
cat > "$redis_dir/StackExchangeRedisCommandTelemetry.csproj" <<EOF
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
    <ProjectReference Include="$package_dir/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj" />
  </ItemGroup>
</Project>
EOF
dotnet run --project "$redis_dir/StackExchangeRedisCommandTelemetry.csproj" --configuration Release > "$tmp_dir/stackexchange-redis.stdout.json" 2> "$tmp_dir/stackexchange-redis.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/stackexchange-redis.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_stackexchange_redis_payload.py" "$tmp_dir/stackexchange-redis.stdout.json" "$tmp_dir/stackexchange-redis.stderr.json" >/dev/null

otel_dir="$tmp_dir/OpenTelemetrySpanProcessorTelemetry"
dotnet new console --framework net10.0 --name OpenTelemetrySpanProcessorTelemetry --output "$otel_dir" >/dev/null
cp "$package_dir/examples/OpenTelemetrySpanProcessorTelemetry.cs" "$otel_dir/Program.cs"
cat > "$otel_dir/OpenTelemetrySpanProcessorTelemetry.csproj" <<EOF
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
    <ProjectReference Include="$package_dir/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj" />
  </ItemGroup>
</Project>
EOF
dotnet run --project "$otel_dir/OpenTelemetrySpanProcessorTelemetry.csproj" --configuration Release > "$tmp_dir/opentelemetry.stdout.json" 2> "$tmp_dir/opentelemetry.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/opentelemetry.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_dotnet_opentelemetry_payload.py" "$tmp_dir/opentelemetry.stdout.json" "$tmp_dir/opentelemetry.stderr.json" >/dev/null

web_dir="$tmp_dir/AspNetCoreRequestTelemetry"
dotnet new web --framework net10.0 --name AspNetCoreRequestTelemetry --output "$web_dir" >/dev/null
cp "$package_dir/examples/AspNetCoreRequestTelemetry.cs" "$web_dir/Program.cs"
cat > "$web_dir/AspNetCoreRequestTelemetry.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="$package_dir/src/LogBrew/LogBrew.csproj" />
  </ItemGroup>
</Project>
EOF
dotnet build "$web_dir/AspNetCoreRequestTelemetry.csproj" --configuration Release >/dev/null

middleware_web_dir="$tmp_dir/AspNetCoreMiddlewareTelemetry"
dotnet new web --framework net10.0 --name AspNetCoreMiddlewareTelemetry --output "$middleware_web_dir" >/dev/null
cp "$package_dir/examples/AspNetCoreMiddlewareTelemetry.cs" "$middleware_web_dir/Program.cs"
cat > "$middleware_web_dir/AspNetCoreMiddlewareTelemetry.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="$package_dir/src/LogBrew/LogBrew.csproj" />
    <ProjectReference Include="$package_dir/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj" />
  </ItemGroup>
</Project>
EOF
dotnet build "$middleware_web_dir/AspNetCoreMiddlewareTelemetry.csproj" --configuration Release >/dev/null

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
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

echo "dotnet package checks passed"
