.PHONY: help run run-readme-example run-real-user-smoke run-trace-correlation

PACKAGE_DIR := $(abspath ..)

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'
	@printf '%s\n' 'run-trace-correlation -> make run-trace-correlation'

run: run-real-user-smoke

run-readme-example:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/Samples~/ReadmeExample/ReadmeExample.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/ReadmeExample.csproj" && dotnet run --project "$$tmp_dir/app/ReadmeExample.csproj" --configuration Release

run-real-user-smoke:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>RealUserSmoke</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/Samples~/ReadmeExample/ReadmeExample.cs" /><Compile Include="$(PACKAGE_DIR)/Samples~/RealUserSmoke/RealUserSmoke.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/RealUserSmoke.csproj" && dotnet run --project "$$tmp_dir/app/RealUserSmoke.csproj" --configuration Release

run-trace-correlation:
	@tmp_dir="$$(realpath "$$(mktemp -d)")" && trap 'rm -rf "$$tmp_dir"' EXIT && mkdir -p "$$tmp_dir/app" && printf '%s\n' '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>TraceCorrelation</StartupObject></PropertyGroup><ItemGroup><Compile Include="$(PACKAGE_DIR)/Runtime/*.cs" /><Compile Include="$(PACKAGE_DIR)/examples/trace_correlation/TraceCorrelation.cs" /></ItemGroup></Project>' > "$$tmp_dir/app/TraceCorrelation.csproj" && dotnet run --project "$$tmp_dir/app/TraceCorrelation.csproj" --configuration Release
