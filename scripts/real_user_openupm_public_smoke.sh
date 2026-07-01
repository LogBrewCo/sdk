#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-${LOGBREW_OPENUPM_VERSION:-0.1.0}}"
registry_url="${LOGBREW_OPENUPM_REGISTRY_URL:-https://package.openupm.com}"
package_name="co.logbrew.unity"
tmp_dir="$(mktemp -d)"

on_error() {
  local status=$?
  echo "real_user_openupm_public_smoke failed near line $LINENO" >&2
  for diagnostic in \
    "$tmp_dir/pack.json" \
    "$tmp_dir/UnityProject/Packages/manifest.json" \
    "$tmp_dir/UnityProject/Packages/co.logbrew.unity/package.json" \
    "$tmp_dir/installed-readme.stdout.json" \
    "$tmp_dir/installed-readme.stderr.json" \
    "$tmp_dir/installed-smoke.stdout.json" \
    "$tmp_dir/installed-smoke.stderr.json"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,140p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap 'rm -rf "$tmp_dir"' EXIT
trap on_error ERR

pack_dir="$tmp_dir/pack"
mkdir -p "$pack_dir"
(
  cd "$pack_dir"
  npm pack co.logbrew.unity@"$version" --registry "$registry_url" --json > "$tmp_dir/pack.json"
)

tarball="$pack_dir/$(python3 - "$tmp_dir/pack.json" "$package_name" "$version" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
package_name = sys.argv[2]
version = sys.argv[3]
if not isinstance(payload, list) or len(payload) != 1:
    raise SystemExit("expected one npm pack result")
entry = payload[0]
if entry.get("name") != package_name or entry.get("version") != version:
    raise SystemExit("unexpected OpenUPM package metadata")
filename = entry.get("filename")
if not isinstance(filename, str) or not filename.endswith(".tgz"):
    raise SystemExit("OpenUPM pack filename missing")
if not isinstance(entry.get("integrity"), str) or not entry["integrity"].startswith("sha512-"):
    raise SystemExit("OpenUPM pack integrity missing")
files = {
    item.get("path")
    for item in entry.get("files", [])
    if isinstance(item, dict) and isinstance(item.get("path"), str)
}
expected_files = {
    ".editorconfig",
    "README.md",
    "Runtime/JsonSupport.cs",
    "Runtime/LogBrew.Unity.asmdef",
    "Runtime/LogBrewClient.cs",
    "Runtime/PublicTypes.cs",
    "Runtime/UnityHelpers.cs",
    "Samples~/ReadmeExample/ReadmeExample.cs",
    "Samples~/RealUserSmoke/RealUserSmoke.cs",
    "examples/Makefile",
    "package.json",
    "tests/LogBrew.Unity.Tests/LogBrew.Unity.Tests.csproj",
    "tests/LogBrew.Unity.Tests/Program.cs",
}
missing = sorted(expected_files - files)
if missing:
    raise SystemExit("OpenUPM package missing expected files: " + ", ".join(missing))
print(filename)
PY
)"

project_dir="$tmp_dir/UnityProject"
installed_package_dir="$project_dir/Packages/co.logbrew.unity"
mkdir -p "$installed_package_dir" "$project_dir/Packages"
tar -xzf "$tarball" --strip-components=1 -C "$installed_package_dir"

cat > "$project_dir/Packages/manifest.json" <<EOF
{
  "scopedRegistries": [
    {
      "name": "OpenUPM",
      "url": "$registry_url",
      "scopes": [
        "co.logbrew"
      ]
    }
  ],
  "dependencies": {
    "co.logbrew.unity": "$version"
  }
}
EOF

python3 - "$project_dir/Packages/manifest.json" "$installed_package_dir/package.json" "$registry_url" "$version" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
package_manifest = json.loads(Path(sys.argv[2]).read_text())
registry_url = sys.argv[3]
version = sys.argv[4]

scoped_registries = manifest.get("scopedRegistries")
if not isinstance(scoped_registries, list) or len(scoped_registries) != 1:
    raise SystemExit("Unity scoped registry missing")
registry = scoped_registries[0]
if registry.get("url") != registry_url or "co.logbrew" not in registry.get("scopes", []):
    raise SystemExit("Unity OpenUPM scoped registry mismatch")
if manifest.get("dependencies", {}).get("co.logbrew.unity") != version:
    raise SystemExit("Unity package dependency mismatch")
if package_manifest.get("name") != "co.logbrew.unity" or package_manifest.get("version") != version:
    raise SystemExit("installed Unity package metadata mismatch")
PY

for required_file in \
  README.md \
  Runtime/JsonSupport.cs \
  Runtime/LogBrew.Unity.asmdef \
  Runtime/LogBrewClient.cs \
  Runtime/PublicTypes.cs \
  Runtime/UnityHelpers.cs \
  Samples~/ReadmeExample/ReadmeExample.cs \
  Samples~/RealUserSmoke/RealUserSmoke.cs \
  examples/Makefile; do
  test -f "$installed_package_dir/$required_file"
done

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
    <StartupObject>ReadmeExample</StartupObject>
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

printf 'openupm public install smoke passed for %s %s\n' "$package_name" "$version"
