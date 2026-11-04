#!/usr/bin/env bash
# Install the Unity package as a local UPM package under $1/Packages, the way a Unity project embeds one.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
package="$sdk/unity/logbrew-unity"
target="$work/Packages/co.logbrew.unity"

command -v dotnet >/dev/null || { echo "the Unity probe compiles the Runtime sources with the .NET SDK; install dotnet" >&2; exit 1; }
mkdir -p "$target"
rsync -a --delete --exclude '/tests/' --exclude 'obj/' --exclude 'bin/' "$package/" "$target/"
