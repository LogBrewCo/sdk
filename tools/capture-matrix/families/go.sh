#!/usr/bin/env bash
# Download the dependencies of every Go module into the module cache. Each Go probe is its own
# module and builds against this checkout through replace directives, the way an app tries a local
# change of a Go dependency.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
stamp="$(cat "$sdk"/go/logbrew/go.mod "$sdk"/go/logbrew/*/go.mod "$sdk"/go/logbrew/*/go.sum | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi
for manifest in "$sdk/go/logbrew/go.mod" "$sdk"/go/logbrew/*/go.mod; do
  (cd "$(dirname "$manifest")" && go mod download)
done
printf '%s' "$stamp" >"$work/.installed"
