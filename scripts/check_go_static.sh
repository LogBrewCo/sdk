#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
version="2026.2.1"
trap 'find "$tmp_dir" -depth -delete' EXIT

staticcheck_bin="$(command -v staticcheck || true)"
if [[ -z "$staticcheck_bin" ]] || \
	[[ "$("$staticcheck_bin" -version)" != "staticcheck $version (0.8.1)" ]]; then
	printf '%s\n' "Staticcheck $version is required on PATH" >&2
	exit 1
fi

go_roots=("$repo_root/go/logbrew" "$repo_root/go/logbrew/asynq" "$repo_root/go/logbrew/gin" "$repo_root/go/logbrew/otel" "$repo_root/tools/toolchain-probe")
(cd "$tmp_dir" && GOTOOLCHAIN=local go work init "${go_roots[@]}")
(cd "$repo_root" && GOTOOLCHAIN=local GOWORK="$tmp_dir/go.work" "$staticcheck_bin" \
	./go/logbrew/... ./go/logbrew/asynq/... ./go/logbrew/gin/... ./go/logbrew/otel/... ./tools/toolchain-probe/...)

printf 'go static analysis ok (Staticcheck %s)\n' "$version"
