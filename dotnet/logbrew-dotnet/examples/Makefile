.PHONY: help run run-readme-example run-real-user-smoke run-first-useful-telemetry run-http-trace-correlation run-activity-trace-correlation run-activity-source-listener-telemetry run-dependency-spans-telemetry run-db-command-telemetry run-http-client-outbound-telemetry run-aspnetcore-request-telemetry run-aspnetcore-middleware-telemetry

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'
	@printf '%s\n' 'run-first-useful-telemetry -> make run-first-useful-telemetry'
	@printf '%s\n' 'run-http-trace-correlation -> make run-http-trace-correlation'
	@printf '%s\n' 'run-activity-trace-correlation -> make run-activity-trace-correlation'
	@printf '%s\n' 'run-activity-source-listener-telemetry -> make run-activity-source-listener-telemetry'
	@printf '%s\n' 'run-dependency-spans-telemetry -> make run-dependency-spans-telemetry'
	@printf '%s\n' 'run-db-command-telemetry -> make run-db-command-telemetry'
	@printf '%s\n' 'run-http-client-outbound-telemetry -> make run-http-client-outbound-telemetry'
	@printf '%s\n' 'run-aspnetcore-request-telemetry -> make run-aspnetcore-request-telemetry'
	@printf '%s\n' 'run-aspnetcore-middleware-telemetry -> make run-aspnetcore-middleware-telemetry'

run: run-real-user-smoke

run-readme-example:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name ReadmeExample --output "$$tmp_dir/app" >/dev/null && cp ReadmeExample.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/ReadmeExample.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/ReadmeExample.csproj" --configuration Release

run-real-user-smoke:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name RealUserSmoke --output "$$tmp_dir/app" >/dev/null && cp RealUserSmoke.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/RealUserSmoke.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/RealUserSmoke.csproj" --configuration Release

run-first-useful-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name FirstUsefulTelemetry --output "$$tmp_dir/app" >/dev/null && cp FirstUsefulTelemetry.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/FirstUsefulTelemetry.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/FirstUsefulTelemetry.csproj" --configuration Release

run-http-trace-correlation:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name HttpTraceCorrelation --output "$$tmp_dir/app" >/dev/null && cp HttpTraceCorrelation.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/HttpTraceCorrelation.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/HttpTraceCorrelation.csproj" --configuration Release

run-activity-trace-correlation:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name ActivityTraceCorrelation --output "$$tmp_dir/app" >/dev/null && cp ActivityTraceCorrelation.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/ActivityTraceCorrelation.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/ActivityTraceCorrelation.csproj" --configuration Release

run-activity-source-listener-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name ActivitySourceListenerTelemetry --output "$$tmp_dir/app" >/dev/null && cp ActivitySourceListenerTelemetry.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/ActivitySourceListenerTelemetry.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/ActivitySourceListenerTelemetry.csproj" --configuration Release

run-dependency-spans-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name DependencySpansTelemetry --output "$$tmp_dir/app" >/dev/null && cp DependencySpansTelemetry.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/DependencySpansTelemetry.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/DependencySpansTelemetry.csproj" --configuration Release

run-db-command-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name DbCommandTelemetry --output "$$tmp_dir/app" >/dev/null && cp DbCommandTelemetry.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/DbCommandTelemetry.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/DbCommandTelemetry.csproj" --configuration Release

run-http-client-outbound-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name HttpClientOutboundTelemetry --output "$$tmp_dir/app" >/dev/null && cp HttpClientOutboundTelemetry.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/HttpClientOutboundTelemetry.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/HttpClientOutboundTelemetry.csproj" --configuration Release

run-aspnetcore-request-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && app_dir="$$tmp_dir/app" && project_path="$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new web --framework net10.0 --name AspNetCoreRequestTelemetry --output "$$app_dir" >/dev/null && cp AspNetCoreRequestTelemetry.cs "$$app_dir/Program.cs" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk.Web">' '  <PropertyGroup>' '    <TargetFramework>net10.0</TargetFramework>' '    <Nullable>enable</Nullable>' '    <ImplicitUsings>enable</ImplicitUsings>' '    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>' '  </PropertyGroup>' '  <ItemGroup>' "    <ProjectReference Include=\"$$project_path\" />" '  </ItemGroup>' '</Project>' > "$$app_dir/AspNetCoreRequestTelemetry.csproj" && dotnet build "$$app_dir/AspNetCoreRequestTelemetry.csproj" --configuration Release >/dev/null && printf '%s\n' 'aspnetcore request telemetry example builds'

run-aspnetcore-middleware-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && app_dir="$$tmp_dir/app" && package_dir="$$(cd .. && pwd -P)" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new web --framework net10.0 --name AspNetCoreMiddlewareTelemetry --output "$$app_dir" >/dev/null && cp AspNetCoreMiddlewareTelemetry.cs "$$app_dir/Program.cs" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk.Web">' '  <PropertyGroup>' '    <TargetFramework>net10.0</TargetFramework>' '    <Nullable>enable</Nullable>' '    <ImplicitUsings>enable</ImplicitUsings>' '    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>' '  </PropertyGroup>' '  <ItemGroup>' "    <ProjectReference Include=\"$$package_dir/src/LogBrew/LogBrew.csproj\" />" "    <ProjectReference Include=\"$$package_dir/src/LogBrew.AspNetCore/LogBrew.AspNetCore.csproj\" />" '  </ItemGroup>' '</Project>' > "$$app_dir/AspNetCoreMiddlewareTelemetry.csproj" && dotnet build "$$app_dir/AspNetCoreMiddlewareTelemetry.csproj" --configuration Release >/dev/null && printf '%s\n' 'aspnetcore middleware telemetry example builds'
