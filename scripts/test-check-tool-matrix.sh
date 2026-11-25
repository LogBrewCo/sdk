#!/usr/bin/env bash
#
# test-check-tool-matrix.sh
# Keep this file identical in every public LogBrew repository.
# Proves that scripts/check-tool-matrix.sh passes on this repository and fails
# on each seeded mistake: an unlisted gate command, a changed pin, an action
# pinned to a tag, an unlisted action, one action pinned two ways, an entry not
# checked for 30 days, and a missing field. An action update across every
# workflow and a listed self-repository action ($/path) pass without a pin.
# An entry whose 30 days end within 7 days passes with a warning, and one with
# 8 days left passes without one.

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
# A self-repository action ($/path) runs at the caller's commit, so it needs no pin.
append_step '$/.github/actions/example'
awk '!done && /^uses = \[/ { sub(/^uses = \[/, "uses = [\"$/.github/actions/example\", "); done = 1 } { print }' \
    "$root/quality/tool-matrix.toml" >"$work/repo/quality/tool-matrix.toml"
bash "$check" "$work/repo" >/dev/null
printf 'ok: a listed self-repository action needs no pin\n'

copy
expect_failure "an entry not checked for 30 days" "more than 30 days ago" "2099-01-01"
expect_failure "an entry checked in the future" "is in the future" "2000-01-01"

# Every entry last checked on 2026-01-01: the check fails on them from 2026-02-01.
sed 's/^checked = .*/checked = 2026-01-01/' "$root/quality/tool-matrix.toml" >"$work/repo/quality/tool-matrix.toml"
expect_pass() {
    local name="$1" today="$2" needle="$3" output
    output="$(GITHUB_ACTIONS="${4:-}" bash "$check" "$work/repo" "$today" 2>&1)" || {
        printf 'FAIL: %s failed:\n%s\n' "$name" "$output" >&2
        exit 1
    }
    if [[ -n "$needle" ]]; then
        grep -qF -- "$needle" <<<"$output"
    else
        ! grep -qiF -- "warning" <<<"$output"
    fi || {
        printf 'FAIL: %s did not report "%s":\n%s\n' "$name" "${needle:-no warning}" "$output" >&2
        exit 1
    }
    printf 'ok: %s\n' "$name"
}
expect_pass "an entry with 8 days left" "2026-01-24" ""
expect_pass "an entry with 7 days left" "2026-01-25" "this check fails on it in 7 days;"
expect_pass "an entry on its last day" "2026-01-31" "this check fails on it in 1 day;"
expect_pass "a warning in GitHub Actions" "2026-01-31" "::warning title=Tool matrix::" true
expect_failure "an entry one day after its last day" "more than 30 days ago" "2026-02-01"

copy
sed 's/^findings = /unreviewed = /' "$root/quality/tool-matrix.toml" >"$work/repo/quality/tool-matrix.toml"
expect_failure "a missing field" "\`findings\` must be a non-empty string"
