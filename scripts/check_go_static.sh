#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
	chmod -R u+w "$tmp_dir" 2>/dev/null || true
	rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

export GOBIN="$tmp_dir/bin"
export GOCACHE="$tmp_dir/go-build-cache"
export GOMODCACHE="$tmp_dir/pkg/mod"
export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}"
mkdir -p "$GOBIN" "$GOCACHE" "$GOMODCACHE"

go install honnef.co/go/tools/cmd/staticcheck@v0.6.1

while IFS= read -r dir; do
	(cd "$dir" && "$GOBIN/staticcheck" ./...)
done < <(find "$repo_root/go/logbrew" -name go.mod -exec dirname {} \; | sort -u)

"$GOBIN/staticcheck" -version
printf '%s\n' "go static analysis ok"
