#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
# tools/staticcheck/go.mod pins the release; Dependabot keeps it current.
version="$(awk '{ for (i = 1; i < NF; i++) if ($i == "honnef.co/go/tools") v = $(i + 1) } END { sub(/^v/, "", v); print v }' "$repo_root/tools/staticcheck/go.mod")"
trap 'find "$tmp_dir" -depth -delete' EXIT

staticcheck_bin="$(command -v staticcheck || true)"
if [[ -z "$staticcheck_bin" ]] || \
	[[ "$("$staticcheck_bin" -version)" != *" ($version)" ]]; then
	printf '%s\n' "Staticcheck $version is required on PATH. Run: go -C tools/staticcheck install tool" >&2
	exit 1
fi

go_roots=("$repo_root/go/logbrew" "$repo_root/go/logbrew/asynq" "$repo_root/go/logbrew/gin" "$repo_root/go/logbrew/otel" "$repo_root/tools/toolchain-probe")
(cd "$tmp_dir" && GOTOOLCHAIN=local go work init "${go_roots[@]}")
(cd "$repo_root" && GOTOOLCHAIN=local GOWORK="$tmp_dir/go.work" "$staticcheck_bin" \
	./go/logbrew/... ./go/logbrew/asynq/... ./go/logbrew/gin/... ./go/logbrew/otel/... ./tools/toolchain-probe/...)

printf 'go static analysis ok (Staticcheck %s)\n' "$version"
