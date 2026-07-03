#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "$(gofmt -l "$repo_root/go/logbrew")" ]]; then
	gofmt -l "$repo_root/go/logbrew"
	exit 1
fi

while IFS= read -r dir; do
	(
		cd "$dir"
		go vet ./...
		go test ./...
	)
done < <(find "$repo_root/go/logbrew" -name go.mod -exec dirname {} \; | sort -u)

printf '%s\n' "go tests ok"
