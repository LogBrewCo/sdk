.PHONY: help run run-readme-example run-real-user-smoke run-trace-correlation run-lifecycle-spans run-lifecycle-tracker run-request-tracker run-coroutine-tracker

PACKAGE_DIR := $(abspath ..)

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'
	@printf '%s\n' 'run-trace-correlation -> make run-trace-correlation'
	@printf '%s\n' 'run-lifecycle-spans -> make run-lifecycle-spans'
	@printf '%s\n' 'run-lifecycle-tracker -> make run-lifecycle-tracker'
	@printf '%s\n' 'run-request-tracker -> make run-request-tracker'
	@printf '%s\n' 'run-coroutine-tracker -> make run-coroutine-tracker'

run: run-real-user-smoke

run-readme-example:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/Samples~/ReadmeExample/ReadmeExample.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/ReadmeExample.csproj" && dotnet run --project "$$tmp_dir/app/ReadmeExample.csproj" --configuration Release

run-real-user-smoke:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>RealUserSmoke</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/Samples~/ReadmeExample/ReadmeExample.cs" /><Compile Include="$(PACKAGE_DIR)/Samples~/RealUserSmoke/RealUserSmoke.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/RealUserSmoke.csproj" && dotnet run --project "$$tmp_dir/app/RealUserSmoke.csproj" --configuration Release

run-trace-correlation:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>TraceCorrelation</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/examples/trace_correlation/TraceCorrelation.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/TraceCorrelation.csproj" && dotnet run --project "$$tmp_dir/app/TraceCorrelation.csproj" --configuration Release

run-lifecycle-spans:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>LifecycleSpans</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/examples/lifecycle_spans/LifecycleSpans.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/LifecycleSpans.csproj" && dotnet run --project "$$tmp_dir/app/LifecycleSpans.csproj" --configuration Release

run-lifecycle-tracker:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>LifecycleTracker</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/examples/lifecycle_tracker/LifecycleTracker.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/LifecycleTracker.csproj" && dotnet run --project "$$tmp_dir/app/LifecycleTracker.csproj" --configuration Release

run-request-tracker:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>RequestTracker</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/examples/request_tracker/RequestTracker.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/RequestTracker.csproj" && dotnet run --project "$$tmp_dir/app/RequestTracker.csproj" --configuration Release

run-coroutine-tracker:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>CoroutineTracker</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/examples/coroutine_tracker/CoroutineTracker.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/CoroutineTracker.csproj" && dotnet run --project "$$tmp_dir/app/CoroutineTracker.csproj" --configuration Release
