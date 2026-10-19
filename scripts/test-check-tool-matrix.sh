#!/usr/bin/env bash
#
# test-check-tool-matrix.sh
# Keep this file identical in every public LogBrew repository.
# Proves that scripts/check-tool-matrix.sh passes on this repository and fails
# on each seeded mistake: an unlisted gate command, a changed pin, a changed
# action pin, an entry not checked for 30 days, and a missing field.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
check="$root/scripts/check-tool-matrix.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

copy() {
    rm -rf "$work/repo"
    mkdir -p "$work/repo"
    git -C "$root" ls-files -z --cached --others --exclude-standard |
        (cd "$root" && xargs -0 tar -cf -) | tar -xf - -C "$work/repo"
}

expect_failure() {
    local name="$1" needle="$2" output
    if output="$(bash "$check" "$work/repo" "${3:-$(date -u +%F)}" 2>&1)"; then
        printf 'FAIL: %s passed\n' "$name" >&2
        exit 1
    fi
    grep -qF -- "$needle" <<<"$output" || {
        printf 'FAIL: %s did not report "%s":\n%s\n' "$name" "$needle" "$output" >&2
        exit 1
    }
    printf 'ok: %s\n' "$name"
}

copy
bash "$check" "$work/repo" >/dev/null
printf 'ok: the current matrix passes\n'

gate="$(sed -n 's/^gates = \["\([^"]*\)".*/\1/p' "$work/repo/quality/tool-matrix.toml")"
if [[ -n "$gate" ]]; then
    printf '\nshellharden --check scripts/*.sh\n' >>"$work/repo/$gate"
else
    printf '\n      - name: Harden shell scripts\n        run: shellharden --check scripts/*.sh\n' \
        >>"$work/repo/.github/workflows/tool-matrix.yml"
fi
expect_failure "an unlisted gate command" "\`shellharden\` has no tool-matrix entry"

copy
# The first pinned entry claims another version than its pin files hold.
matrix="$work/repo/quality/tool-matrix.toml"
block="$(awk '/^\[\[tool\]\]$/ { n++ } /^pins = / { print n; exit }' "$matrix")"
awk -v block="$block" '/^\[\[tool\]\]$/ { n++ } n == block && /^version = "/ { sub(/"$/, ".9\"") } { print }' "$matrix" >"$work/edited"
cp "$work/edited" "$matrix"
expect_failure "a changed pin" "no longer pins"

copy
workflow="$(grep -l -m 1 'uses: ' "$work/repo"/.github/workflows/*.y*ml | head -n 1)"
sed -E 's/(uses: [^@]+@)[0-9a-f]{40}/\10000000000000000000000000000000000000000/' "$workflow" >"$work/edited"
cp "$work/edited" "$workflow"
expect_failure "a changed action pin" "is not a tool's \`uses\` pin"

copy
expect_failure "an entry not checked for 30 days" "more than 30 days ago" "2099-01-01"
expect_failure "an entry checked in the future" "is in the future" "2000-01-01"

copy
sed 's/^findings = /unreviewed = /' "$root/quality/tool-matrix.toml" >"$work/repo/quality/tool-matrix.toml"
expect_failure "a missing field" "\`findings\` must be a non-empty string"
