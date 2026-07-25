#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: real_user_swift_build_executable.sh <package-path> <scratch-path> <product>" >&2
  exit 2
fi

package_path="$1"
scratch_path="$2"
product="$3"

swift build \
  --package-path "$package_path" \
  --scratch-path "$scratch_path" \
  --configuration debug \
  --jobs 1 \
  --product "$product" >&2

binary_directory="$(
  swift build \
    --package-path "$package_path" \
    --scratch-path "$scratch_path" \
    --configuration debug \
    --show-bin-path
)"
binary_path="$binary_directory/$product"
if [[ ! -x "$binary_path" ]]; then
  echo "Swift smoke executable was not created" >&2
  exit 1
fi

printf '%s\n' "$binary_path"
