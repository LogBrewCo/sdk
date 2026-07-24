#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="${LOGBREW_RELEASE_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [[ "$repo_root" != /* || -L "$repo_root" || ! -d "$repo_root" ]]; then
  echo "NuGet release source root is invalid" >&2
  exit 1
fi
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-nuget-selected.XXXXXX")"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"
plan=""
artifact_root=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      [[ $# -ge 2 ]] || { echo "--plan requires a path" >&2; exit 2; }
      plan="$2"
      shift 2
      ;;
    --artifact-root)
      [[ $# -ge 2 ]] || { echo "--artifact-root requires a path" >&2; exit 2; }
      artifact_root="$2"
      shift 2
      ;;
    *)
      if [[ -z "$plan" ]]; then
        plan="$1"
        shift
      else
        echo "unexpected argument" >&2
        exit 2
      fi
      ;;
  esac
done

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

run_exact_package_smoke() {
  local bound="$1"
  local core_version="$2"
  local httpclient_version="$3"
  local source_dir="$tmp_dir/exact-source"
  [[ -n "$core_version" && -n "$httpclient_version" ]]
  mkdir "$source_dir"
  ln "$bound/0.nupkg" "$source_dir/LogBrew.${core_version}.nupkg"
  ln "$bound/1.nupkg" \
    "$source_dir/LogBrew.HttpClient.${httpclient_version}.nupkg"
  export NUGET_PACKAGES="$tmp_dir/exact-packages"
  export NUGET_HTTP_CACHE_PATH="$tmp_dir/exact-http-cache"
  export NUGET_PLUGINS_CACHE_PATH="$tmp_dir/exact-plugin-cache"
  cat > "$tmp_dir/NuGet.Config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="receipt" value="$source_dir" />
    <add key="nuget" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <packageSourceMapping>
    <packageSource key="receipt">
      <package pattern="LogBrew*" />
    </packageSource>
    <packageSource key="nuget">
      <package pattern="Microsoft.*" />
      <package pattern="System.*" />
      <package pattern="NETStandard.Library" />
    </packageSource>
  </packageSourceMapping>
</configuration>
EOF
  dotnet new console --framework net10.0 --output "$tmp_dir/exact-app" \
    >"$tmp_dir/exact-new.out" 2>"$tmp_dir/exact-new.err"
  dotnet add "$tmp_dir/exact-app/exact-app.csproj" package LogBrew \
    --version "$core_version" --no-restore \
    >"$tmp_dir/exact-add-core.out" 2>"$tmp_dir/exact-add-core.err"
  dotnet add "$tmp_dir/exact-app/exact-app.csproj" package LogBrew.HttpClient \
    --version "$httpclient_version" --no-restore \
    >"$tmp_dir/exact-add-client.out" 2>"$tmp_dir/exact-add-client.err"
  dotnet restore "$tmp_dir/exact-app/exact-app.csproj" \
    --configfile "$tmp_dir/NuGet.Config" --packages "$NUGET_PACKAGES" \
    >"$tmp_dir/exact-restore.out" 2>"$tmp_dir/exact-restore.err"
  cat > "$tmp_dir/exact-app/Program.cs" <<'CS'
using System.Reflection;

foreach (var packageId in new[] { "LogBrew", "LogBrew.HttpClient" })
{
    var assembly = Assembly.Load(packageId);
    if (!string.Equals(assembly.GetName().Name, packageId, StringComparison.Ordinal))
    {
        return 1;
    }
}
return 0;
CS
  dotnet run --project "$tmp_dir/exact-app/exact-app.csproj" --no-restore \
    >"$tmp_dir/exact-run.out" 2>"$tmp_dir/exact-run.err"
  python3 "$repo_root/scripts/check_nuget_release_receipt_provenance.py" \
    --bound-dir "$bound" --source-dir "$source_dir" \
    --packages-dir "$NUGET_PACKAGES" \
    --assets "$tmp_dir/exact-app/obj/project.assets.json" \
    --core-version "$core_version" --httpclient-version "$httpclient_version" \
    >"$tmp_dir/exact-provenance.out" 2>"$tmp_dir/exact-provenance.err"
}

run_receipt_smoke() {
  local bound="$tmp_dir/receipt-artifacts"
  local metadata="$tmp_dir/receipt-metadata.json"
  local core_version="${LOGBREW_DOTNET_CORE_VERSION:-}"
  local httpclient_version="${LOGBREW_DOTNET_HTTPCLIENT_VERSION:-}"
  [[ -n "$core_version" && -n "$httpclient_version" ]]
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "nuget" --output-dir "$bound" --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  run_exact_package_smoke "$bound" "$core_version" "$httpclient_version"
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "nuget" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  [[ -z "$plan" && -z "$artifact_root" ]]
  run_receipt_smoke
  exit 0
fi

if [[ -z "$plan" ]]; then
  echo "usage: $0 [--plan] RELEASE_PLAN [--artifact-root DIRECTORY]" >&2
  exit 2
fi

python3 "$repo_root/scripts/nuget_release_plan.py" validate \
  --root "$repo_root" \
  --plan "$plan" >/dev/null

mapfile -t selected < <(
  python3 "$repo_root/scripts/nuget_release_plan.py" entries \
    --root "$repo_root" \
    --plan "$plan" \
    --format versions
)
if [[ ${#selected[@]} -eq 0 ]]; then
  echo "NuGet release plan did not select a package" >&2
  exit 1
fi

if [[ -n "$artifact_root" ]]; then
  selection_mode="$(
    python3 "$repo_root/scripts/nuget_release_plan.py" entries \
      --root "$repo_root" --plan "$plan" --format mode
  )"
  if [[ "$selection_mode" != "selected" || -L "$artifact_root" || ! -d "$artifact_root" ]]; then
    echo "NuGet public artifact selection is invalid" >&2
    exit 1
  fi
  core_version=""
  httpclient_version=""
  for item in "${selected[@]}"; do
    package_id="${item%%=*}"
    version="${item#*=}"
    [[ "$package_id" == "LogBrew" ]] && core_version="$version"
    [[ "$package_id" == "LogBrew.HttpClient" ]] && httpclient_version="$version"
  done
  expected=(
    "LogBrew.${core_version}.nupkg"
    "LogBrew.HttpClient.${httpclient_version}.nupkg"
  )
  mapfile -t artifact_entries < <(
    find "$artifact_root" -mindepth 1 -maxdepth 1 -print | sort
  )
  actual=()
  for entry in "${artifact_entries[@]}"; do
    if [[ ! -f "$entry" || -L "$entry" ]]; then
      echo "NuGet public artifact selection is invalid" >&2
      exit 1
    fi
    actual+=("$(basename "$entry")")
  done
  mapfile -t expected_sorted < <(printf '%s\n' "${expected[@]}" | sort)
  if [[ ${#actual[@]} -ne 2 || "${actual[*]}" != "${expected_sorted[*]}" ]]; then
    echo "NuGet public artifact selection is invalid" >&2
    exit 1
  fi
  bound="$tmp_dir/public-bound"
  mkdir "$bound"
  ln "$artifact_root/LogBrew.${core_version}.nupkg" "$bound/0.nupkg"
  ln "$artifact_root/LogBrew.HttpClient.${httpclient_version}.nupkg" \
    "$bound/1.nupkg"
  run_exact_package_smoke "$bound" "$core_version" "$httpclient_version"
  echo "selected NuGet exact artifact install ok (2 packages)"
  exit 0
fi

dotnet new console --framework net10.0 --output "$tmp_dir/app" >/dev/null
for item in "${selected[@]}"; do
  package_id="${item%%=*}"
  version="${item#*=}"
  dotnet add "$tmp_dir/app/app.csproj" package "$package_id" \
    --version "$version" \
    --source https://api.nuget.org/v3/index.json >/dev/null
done

cat > "$tmp_dir/app/Program.cs" <<'CS'
using System.Reflection;

if (args.Length == 0)
{
    return 1;
}
foreach (var packageId in args)
{
    var assembly = Assembly.Load(packageId);
    if (!string.Equals(assembly.GetName().Name, packageId, StringComparison.Ordinal))
    {
        return 1;
    }
}
Console.WriteLine($"selected NuGet install ok ({args.Length} packages)");
return 0;
CS

mapfile -t selected_ids < <(
  python3 "$repo_root/scripts/nuget_release_plan.py" entries \
    --root "$repo_root" \
    --plan "$plan" \
    --format ids
)
dotnet run --project "$tmp_dir/app/app.csproj" --no-restore -- "${selected_ids[@]}"
