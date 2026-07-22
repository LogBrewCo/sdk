#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plan="${1:-}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-nuget-selected.XXXXXX")"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

run_receipt_smoke() {
  local bound="$tmp_dir/receipt-artifacts"
  local source_dir="$tmp_dir/receipt-source"
  local metadata="$tmp_dir/receipt-metadata.json"
  local core_version="${LOGBREW_DOTNET_CORE_VERSION:-}"
  local httpclient_version="${LOGBREW_DOTNET_HTTPCLIENT_VERSION:-}"
  [[ -n "$core_version" && -n "$httpclient_version" && $# -eq 0 ]]
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "nuget" --output-dir "$bound" --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  mkdir "$source_dir"
  ln "$bound/0.nupkg" "$source_dir/LogBrew.${core_version}.nupkg"
  ln "$bound/1.nupkg" \
    "$source_dir/LogBrew.HttpClient.${httpclient_version}.nupkg"
  export NUGET_PACKAGES="$tmp_dir/receipt-packages"
  export NUGET_HTTP_CACHE_PATH="$tmp_dir/receipt-http-cache"
  export NUGET_PLUGINS_CACHE_PATH="$tmp_dir/receipt-plugin-cache"
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
  dotnet new console --framework net10.0 --output "$tmp_dir/receipt-app" \
    >"$tmp_dir/receipt-new.out" 2>"$tmp_dir/receipt-new.err"
  dotnet add "$tmp_dir/receipt-app/receipt-app.csproj" package LogBrew \
    --version "$core_version" --no-restore \
    >"$tmp_dir/receipt-add-core.out" 2>"$tmp_dir/receipt-add-core.err"
  dotnet add "$tmp_dir/receipt-app/receipt-app.csproj" package LogBrew.HttpClient \
    --version "$httpclient_version" --no-restore \
    >"$tmp_dir/receipt-add-client.out" 2>"$tmp_dir/receipt-add-client.err"
  dotnet restore "$tmp_dir/receipt-app/receipt-app.csproj" \
    --configfile "$tmp_dir/NuGet.Config" --packages "$NUGET_PACKAGES" \
    >"$tmp_dir/receipt-restore.out" 2>"$tmp_dir/receipt-restore.err"
  cat > "$tmp_dir/receipt-app/Program.cs" <<'CS'
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
  dotnet run --project "$tmp_dir/receipt-app/receipt-app.csproj" --no-restore \
    >"$tmp_dir/receipt-run.out" 2>"$tmp_dir/receipt-run.err"
  python3 "$repo_root/scripts/check_nuget_release_receipt_provenance.py" \
    --bound-dir "$bound" --source-dir "$source_dir" \
    --packages-dir "$NUGET_PACKAGES" \
    --assets "$tmp_dir/receipt-app/obj/project.assets.json" \
    --core-version "$core_version" --httpclient-version "$httpclient_version" \
    >"$tmp_dir/receipt-provenance.out" 2>"$tmp_dir/receipt-provenance.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "nuget" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  run_receipt_smoke "$@"
  exit 0
fi

if [[ -z "$plan" || $# -ne 1 ]]; then
  echo "usage: $0 RELEASE_PLAN" >&2
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
