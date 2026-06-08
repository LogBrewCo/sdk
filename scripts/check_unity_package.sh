#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/unity/logbrew-unity"
tmp_dir="$(mktemp -d)"
lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-unity-checks.lock"
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
  echo "another Unity SDK verifier run is already in progress" >&2
  exit 1
fi

python3 - "$package_dir/package.json" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "name": "co.logbrew.unity",
    "version": "0.1.0",
    "displayName": "LogBrew Unity SDK",
    "unity": "2021.3",
    "license": "MIT",
}
for key, value in expected.items():
    if manifest.get(key) != value:
        raise SystemExit(f"unexpected package.json {key}: {manifest.get(key)!r}")
repository = manifest.get("repository", {})
if repository.get("type") != "git":
    raise SystemExit(f"unexpected package.json repository.type: {repository.get('type')!r}")
if repository.get("url") != "git+https://github.com/LogBrewCo/sdk.git":
    raise SystemExit(f"unexpected package.json repository.url: {repository.get('url')!r}")
samples = {sample["path"] for sample in manifest.get("samples", [])}
if samples != {"Samples~/ReadmeExample", "Samples~/RealUserSmoke"}:
    raise SystemExit(f"unexpected sample paths: {sorted(samples)}")
PY

dotnet run --project "$package_dir/tests/LogBrew.Unity.Tests/LogBrew.Unity.Tests.csproj" --configuration Release

package_tgz="$tmp_dir/co.logbrew.unity-0.1.0.tgz"
(cd "$package_dir" && tar -czf "$package_tgz" package.json README.md Runtime Samples~ examples)
tar -tzf "$package_tgz" > "$tmp_dir/package-contents.txt"
grep -qx 'package.json' "$tmp_dir/package-contents.txt"
grep -qx 'README.md' "$tmp_dir/package-contents.txt"
grep -qx 'Runtime/LogBrew.Unity.asmdef' "$tmp_dir/package-contents.txt"
grep -qx 'Runtime/PublicTypes.cs' "$tmp_dir/package-contents.txt"
grep -qx 'Runtime/LogBrewClient.cs' "$tmp_dir/package-contents.txt"
grep -qx 'Runtime/JsonSupport.cs' "$tmp_dir/package-contents.txt"
grep -qx 'Runtime/UnityHelpers.cs' "$tmp_dir/package-contents.txt"
grep -qx 'Samples~/ReadmeExample/ReadmeExample.cs' "$tmp_dir/package-contents.txt"
grep -qx 'Samples~/RealUserSmoke/RealUserSmoke.cs' "$tmp_dir/package-contents.txt"
grep -qx 'examples/Makefile' "$tmp_dir/package-contents.txt"

python3 - "$package_tgz" <<'PY'
import json
import sys
import tarfile
from pathlib import Path

package_tgz = Path(sys.argv[1])
with tarfile.open(package_tgz, "r:gz") as archive:
    manifest = json.loads(archive.extractfile("package.json").read().decode())
    readme = archive.extractfile("README.md").read().decode()
if manifest["name"] != "co.logbrew.unity":
    raise SystemExit("wrong package name")
for needle in ("LOGBREW_API_KEY", "LogBrewUnity.CreateClient", "HttpTransport", "https://api.logbrew.com/v1/events", "sample source"):
    if needle not in readme:
        raise SystemExit(f"missing README guidance: {needle}")
PY

run_sample() {
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
    <Compile Include="$package_dir/Runtime/*.cs" />
    <Compile Include="$package_dir/Samples~/ReadmeExample/ReadmeExample.cs" />
    <Compile Include="$package_dir/Samples~/RealUserSmoke/RealUserSmoke.cs" />
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
    <Compile Include="$package_dir/Runtime/*.cs" />
    <Compile Include="$package_dir/Samples~/ReadmeExample/ReadmeExample.cs" />
  </ItemGroup>
</Project>
EOF
  fi
  dotnet run --project "$app_dir/$project_name.csproj" --configuration Release > "$stdout_path" 2> "$stderr_path"
}

run_sample ReadmeSample false "$tmp_dir/readme-sample.stdout.json" "$tmp_dir/readme-sample.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-sample.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-sample.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme-sample.stderr.json"

run_sample RealUserSample true "$tmp_dir/real-user-sample.stdout.json" "$tmp_dir/real-user-sample.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-sample.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-sample.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/real-user-sample.stderr.json"
grep -q '"unityHelperEvents":3' "$tmp_dir/real-user-sample.stderr.json"
grep -q '"httpAttempts":1' "$tmp_dir/real-user-sample.stderr.json"

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"

echo "unity package checks passed"
