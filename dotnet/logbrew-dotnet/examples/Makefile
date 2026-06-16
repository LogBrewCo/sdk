.PHONY: help run run-readme-example run-real-user-smoke run-first-useful-telemetry run-http-trace-correlation

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'
	@printf '%s\n' 'run-first-useful-telemetry -> make run-first-useful-telemetry'
	@printf '%s\n' 'run-http-trace-correlation -> make run-http-trace-correlation'

run: run-real-user-smoke

run-readme-example:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name ReadmeExample --output "$$tmp_dir/app" >/dev/null && cp ReadmeExample.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/ReadmeExample.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/ReadmeExample.csproj" --configuration Release

run-real-user-smoke:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name RealUserSmoke --output "$$tmp_dir/app" >/dev/null && cp RealUserSmoke.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/RealUserSmoke.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/RealUserSmoke.csproj" --configuration Release

run-first-useful-telemetry:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name FirstUsefulTelemetry --output "$$tmp_dir/app" >/dev/null && cp FirstUsefulTelemetry.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/FirstUsefulTelemetry.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/FirstUsefulTelemetry.csproj" --configuration Release

run-http-trace-correlation:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && dotnet new console --framework net10.0 --name HttpTraceCorrelation --output "$$tmp_dir/app" >/dev/null && cp HttpTraceCorrelation.cs "$$tmp_dir/app/Program.cs" && dotnet add "$$tmp_dir/app/HttpTraceCorrelation.csproj" reference "$$(cd .. && pwd -P)/src/LogBrew/LogBrew.csproj" >/dev/null && dotnet run --project "$$tmp_dir/app/HttpTraceCorrelation.csproj" --configuration Release
