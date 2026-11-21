#!/usr/bin/env bash
#
# test-check-dependabot.sh
# Keep this file identical in every public LogBrew repository.
# Proves that scripts/check-dependabot.sh passes on this repository and on a
# seeded repository whose config covers every manifest, and fails with the
# right message for each seeded gap.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
check="$root/scripts/check-dependabot.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"

# entry ECOSYSTEM DIRECTORY...: prints one compliant entry.
entry() {
    local ecosystem="$1" directory
    shift
    printf '  - package-ecosystem: %s\n    directories:\n' "$ecosystem"
    for directory in "$@"; do printf '      - %s\n' "$directory"; done
    printf '    schedule:\n      interval: daily\n    cooldown:\n      default-days: 2\n'
    printf '    groups:\n      %s:\n        patterns: ["*"]\n' "$ecosystem"
}

# seed CONFIG FILE...: a repository with these tracked files and this config.
seed() {
    local file
    rm -rf "$repo"
    git init -q "$repo"
    mkdir -p "$repo/.github"
    printf 'version: 2\nupdates:\n%s\n' "$1" >"$repo/.github/dependabot.yml"
    shift
    for file in "$@"; do
        mkdir -p "$(dirname "$repo/$file")"
        printf '{}\n' >"$repo/$file"
    done
    git -C "$repo" add -A
}

expect_pass() {
    bash "$check" "$repo" >/dev/null || {
        printf 'FAIL: %s failed\n' "$1" >&2
        exit 1
    }
    printf 'ok: %s passes\n' "$1"
}

expect_report() {
    local name="$1" text="$2" output
    if output="$(bash "$check" "$repo" 2>&1)"; then
        printf 'FAIL: %s passed\n' "$name" >&2
        exit 1
    fi
    grep -qF -- "$text" <<<"$output" || {
        printf 'FAIL: %s did not report %s:\n%s\n' "$name" "$text" "$output" >&2
        exit 1
    }
    printf 'ok: %s fails\n' "$name"
}

bash "$check" "$root" >/dev/null
printf 'ok: this repository passes\n'

# A config with one compliant entry per ecosystem of the seeded files.
base() {
    entry github-actions /
    entry bun / /web
    entry cargo /
    entry gomod /go
}

files=(.github/workflows/ci.yml package.json web/package.json Cargo.toml crates/core/Cargo.toml go/go.mod)
seed "$(base)" "${files[@]}"
expect_pass "a config that lists every manifest directory"

seed "$(base)" "${files[@]}" web/examples/package.json
expect_report "a package.json in an unlisted directory" "web/examples/package.json: no bun or npm entry lists /web/examples"

seed "$(base | sed '/ecosystem: cargo/,/patterns/ s#- /$#- /crates/core#')" "${files[@]}"
expect_report "a Cargo workspace root that no entry lists" "Cargo.toml: no cargo entry lists /"

seed "$(base)" "${files[@]}" requirements.txt
expect_report "a Python manifest without an entry" "requirements.txt: no pip or uv entry lists /"

seed "$(base)" "${files[@]}" tools/action.yml
expect_report "a composite action in an unlisted directory" "tools/action.yml: no github-actions entry lists /tools"

seed "$(base | sed 's#- /web$#- /old#')" "${files[@]}"
expect_report "a listed directory without a manifest" "bun: /old holds no tracked bun manifest"

seed "$(base | sed 's#- /web$#- /web*#')" "${files[@]}"
expect_report "a glob directory" "bun: /web* is a glob; list each directory"

seed "$(base && entry bun /web)" "${files[@]}"
expect_report "two entries for one ecosystem" "bun: more than one entry"

seed "$(base | sed '/ecosystem: gomod/,$ s/daily/weekly/')" "${files[@]}"
expect_report "a weekly schedule" 'gomod: schedule interval is "weekly"; use daily'

seed "$(base | sed '/ecosystem: gomod/,$ {/cooldown/d;/default-days/d;}')" "${files[@]}"
expect_report "a missing cooldown" 'gomod: cooldown default-days is ""; use 2'

seed "$(base | sed '/ecosystem: gomod/,$ {/groups/d;/gomod:$/d;/patterns/d;}')" "${files[@]}"
expect_report "ungrouped updates" 'gomod: needs a group with patterns: ["*"]'

rm -rf "$repo/.git"
expect_report "a directory outside Git" "dependabot: cannot list the files of $repo"
