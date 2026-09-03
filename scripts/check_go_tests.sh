#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
go_roots=("$repo_root/go/logbrew" "$repo_root/tools/toolchain-probe")

if [[ -n "$(gofmt -l "${go_roots[@]}")" ]]; then
	gofmt -l "${go_roots[@]}"
	exit 1
fi

while IFS= read -r dir; do
	(
		cd "$dir"
		go vet ./...
		go test ./...
	)
done < <(find "${go_roots[@]}" -name go.mod -exec dirname {} \; | sort -u)

printf '%s\n' "go tests ok"
