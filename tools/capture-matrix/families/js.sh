#!/usr/bin/env bash
# Install every JavaScript package from its packed tarball, with the frameworks the probes use, into $1.
# The frameworks come from scripts/lockfiles/npm/capture-matrix-js.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$sdk/scripts/npm_locked.sh"

mkdir -p "$work/tarballs"
rm -f "$work"/tarballs/*.tgz
for package in "$sdk"/js/logbrew-*/; do
  (cd "$package" && npm pack --silent --pack-destination "$work/tarballs" >/dev/null)
done
stamp="$(cat "$work"/tarballs/*.tgz "${BASH_SOURCE[0]}" "$lockfiles_root/capture-matrix-js/package-lock.json" | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi

cd "$work"
printf '{"name":"capture-probes","private":true,"type":"module"}\n' >package.json
npm_ci_locked capture-matrix-js --silent >/dev/null
npm_add_logbrew --silent "$work"/tarballs/*.tgz >/dev/null
printf '%s' "$stamp" >"$work/.installed"
