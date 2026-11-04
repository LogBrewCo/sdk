#!/usr/bin/env bash
# Pack every .NET package into a local NuGet feed in $1, with a NuGet.config that resolves LogBrew packages only from it.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
dotnet_root="$sdk/dotnet/logbrew-dotnet"
packages=(LogBrew LogBrew.AspNetCore LogBrew.EntityFrameworkCore LogBrew.Hangfire LogBrew.HttpClient LogBrew.OpenTelemetry LogBrew.StackExchangeRedis)

stamp="$(
  {
    dotnet --version
    cd "$sdk"
    find dotnet/logbrew-dotnet/src dotnet/logbrew-dotnet/README.md dotnet/logbrew-dotnet/examples -type f \
      -not -path '*/obj/*' -not -path '*/bin/*' -print0 | sort -z | xargs -0 shasum -a 256
  } | shasum -a 256 | cut -d ' ' -f 1
)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi

# A rebuilt package keeps its version, so drop the cached copies of the old build.
rm -rf "$work/feed" "$work/artifacts" "$work"/nuget-packages/logbrew*
mkdir -p "$work/feed" "$work/nuget-packages"
cat >"$work/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <config>
    <add key="globalPackagesFolder" value="$work/nuget-packages" />
  </config>
  <packageSources>
    <clear />
    <add key="logbrew-local" value="$work/feed" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <packageSourceMapping>
    <packageSource key="logbrew-local">
      <package pattern="LogBrew" />
      <package pattern="LogBrew.*" />
    </packageSource>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
EOF

export NUGET_PACKAGES="$work/nuget-packages"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
for package in "${packages[@]}"; do
  dotnet pack "$dotnet_root/src/$package/$package.csproj" --configuration Release --nologo --verbosity quiet \
    --artifacts-path "$work/artifacts" --output "$work/feed" >/dev/null
done
printf '%s' "$stamp" >"$work/.installed"
