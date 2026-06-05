#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
publint_version="0.3.21"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

cd "$tmp_dir"
npm init -y >/dev/null
npm install \
  --save-exact \
  --no-package-lock \
  --ignore-scripts \
  --no-audit \
  --fund=false \
  "publint@$publint_version" \
  >/dev/null

installed_version="$(node -p 'require("./node_modules/publint/package.json").version')"
if [[ "$installed_version" != "$publint_version" ]]; then
  printf 'expected publint %s but installed %s\n' "$publint_version" "$installed_version" >&2
  exit 1
fi

cd "$repo_root"
package_dirs=()
while IFS= read -r package_dir; do
  package_dirs+=("$package_dir")
done < <(
  python3 - <<'PY'
from pathlib import Path

for package_json in sorted(Path("js").glob("*/package.json")):
    print(package_json.parent.as_posix())
PY
)

if (( ${#package_dirs[@]} == 0 )); then
  printf '%s\n' "no JavaScript package manifests found" >&2
  exit 1
fi

for package_dir in "${package_dirs[@]}"; do
  "$tmp_dir/node_modules/.bin/publint" \
    --strict \
    --pack npm \
    "$repo_root/$package_dir"
done

printf 'javascript package publishing checks ok (publint %s)\n' "$publint_version"
