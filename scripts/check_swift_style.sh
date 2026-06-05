#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/swift/logbrew-swift"

require_tool() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required for Swift style checks. Install it with: brew install swiftlint swiftformat" >&2
    exit 1
  fi
}

require_tool swiftformat
require_tool swiftlint

swiftformat --lint --config "$package_dir/.swiftformat" "$package_dir"
(cd "$package_dir" && swiftlint lint --config .swiftlint.yml --strict)

echo "swift style checks passed"
