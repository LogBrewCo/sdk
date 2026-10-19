#!/usr/bin/env bash
#
# test-check-tool-matrix.sh
# Keep this file identical in every public LogBrew repository.
# Proves that scripts/check-tool-matrix.sh passes on this repository and fails
# on each seeded mistake: an unlisted gate command, a changed pin, an action
# pinned to a tag, an unlisted action, one action pinned two ways, an entry not
# checked for 30 days, and a missing field. An action update across every
# workflow passes without a matrix edit.

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

# The first remote action pin in the workflows, for the action cases below.
first_pin() {
    grep -h -m 1 -E '^[ -]*uses: [^.][^@]*@[0-9a-f]{40} # ' "$work/repo"/.github/workflows/*.y*ml |
        head -n 1 | sed -E 's/^[ -]*uses: *//; s/ +$//'
}
append_step() {
    local workflows=("$work/repo"/.github/workflows/*.y*ml)
    printf '\n      - uses: %s\n' "$1" >>"${workflows[0]}"
}

copy
pin="$(first_pin)"
action="${pin%%@*}"
for workflow in "$work/repo"/.github/workflows/*.y*ml; do
    awk -v pin="$pin" -v action="$action" '{ i = index($0, pin); if (i) $0 = substr($0, 1, i - 1) action "@v1" } { print }' \
        "$workflow" >"$work/edited"
    cp "$work/edited" "$workflow"
done
expect_failure "an action pinned to a tag" "is not pinned to a commit"

copy
append_step "example/unlisted-action@1111111111111111111111111111111111111111 # v1.0.0"
expect_failure "an unlisted action" "action \`example/unlisted-action\` is not in any tool's \`uses\`"

copy
append_step "$action@2222222222222222222222222222222222222222 # v0.0.1"
expect_failure "one action pinned differently in two places" "action \`$action\` is pinned to more than one commit"

copy
# An update that moves every use of an action to a new commit and version needs no matrix edit.
for workflow in "$work/repo"/.github/workflows/*.y*ml; do
    awk -v pin="$pin" -v action="$action" '{ i = index($0, pin); if (i) $0 = substr($0, 1, i - 1) action "@3333333333333333333333333333333333333333 # v99.0.0" } { print }' \
        "$workflow" >"$work/edited"
    cp "$work/edited" "$workflow"
done
bash "$check" "$work/repo" >/dev/null
printf 'ok: an action update in every workflow passes without a matrix edit\n'

copy
expect_failure "an entry not checked for 30 days" "more than 30 days ago" "2099-01-01"
expect_failure "an entry checked in the future" "is in the future" "2000-01-01"

copy
sed 's/^findings = /unreviewed = /' "$root/quality/tool-matrix.toml" >"$work/repo/quality/tool-matrix.toml"
expect_failure "a missing field" "\`findings\` must be a non-empty string"
