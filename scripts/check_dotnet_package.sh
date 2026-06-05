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

dotnet build "$package_dir/src/LogBrew/LogBrew.csproj" --configuration Release -warnaserror >/dev/null
dotnet run --project "$package_dir/tests/LogBrew.Tests/LogBrew.Tests.csproj" --configuration Release
dotnet pack "$package_dir/src/LogBrew/LogBrew.csproj" --configuration Release --output "$tmp_dir/packages" >/dev/null
nupkg="$tmp_dir/packages/LogBrew.0.1.0.nupkg"
test -f "$nupkg"

python3 - "$nupkg" <<'PY'
import sys
import zipfile

nupkg = sys.argv[1]
with zipfile.ZipFile(nupkg) as archive:
    names = set(archive.namelist())
    required = {
        "lib/netstandard2.0/LogBrew.dll",
        "README.md",
        "examples/ReadmeExample.cs",
        "examples/RealUserSmoke.cs",
        "examples/Makefile",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing nupkg files: {missing}")
    readme = archive.read("README.md").decode()
    nuspec = archive.read("LogBrew.nuspec").decode()
if 'dependency id="Microsoft.Extensions.Logging"' not in nuspec:
    raise SystemExit("missing Microsoft.Extensions.Logging dependency metadata")
for needle in (
    "dotnet add package LogBrew",
    "LOGBREW_API_KEY",
    "PreviewJson()",
    "HttpTransport",
    "System.Net.Http",
    "AddLogBrew(client",
    "Microsoft.Extensions.Logging",
    "IncludeExceptionStackTrace",
    "cd examples && make run-real-user-smoke",
):
    if needle not in readme:
        raise SystemExit(f"missing README guidance: {needle}")
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

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"

echo "dotnet package checks passed"
