#!/usr/bin/env bash
# Install the PHP package from a copy of its source directory with Composer into $1/vendor.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
package="$sdk/php/logbrew-php"

stamp="$(
  cd "$package"
  find src composer.json -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d ' ' -f 1
)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi

rm -rf "$work/src" "$work/vendor" "$work/composer.lock"
mkdir -p "$work/src"
cp -R "$package/src" "$package/composer.json" "$work/src/"
cat >"$work/composer.json" <<'JSON'
{
  "name": "logbrew/capture-probes",
  "type": "project",
  "repositories": [{ "type": "path", "url": "src", "options": { "symlink": false, "versions": { "logbrew/sdk": "1.0.0" } } }],
  "require": { "logbrew/sdk": "1.0.0" }
}
JSON
COMPOSER_NO_INTERACTION=1 composer --working-dir="$work" install --quiet --no-dev --no-progress
printf '%s' "$stamp" >"$work/.installed"
