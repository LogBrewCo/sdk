#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
go_roots=("$repo_root/go/logbrew" "$repo_root/tools/toolchain-probe")

if [[ -n "$(gofmt -l "${go_roots[@]}")" ]]; then
	gofmt -l "${go_roots[@]}"
	exit 1
fi

# The native verifier is tested by its own pinned-compiler, race-enabled CI step.
while IFS= read -r dir; do
	(
		cd "$dir"
		go vet ./...
		go test ./...
	)
done < <(find "$repo_root/go/logbrew" -name go.mod -exec dirname {} \; | sort -u)

printf '%s\n' "go tests ok"
