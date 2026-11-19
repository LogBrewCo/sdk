#!/usr/bin/env bash
#
# check-suppressions.sh
# Keep this file identical in every public LogBrew repository.
# Fails when a tracked source file turns off a lint or type check inline, for
# example with an allow or expect attribute, a noqa comment, or a ts-expect-error
# comment. Fix the finding instead. When a rule is wrong for a whole kind of
# file, change the linter configuration and give the reason there. There is no
# allowlist.
# Usage: bash scripts/check-suppressions.sh [ROOT]

set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
# Each alternative is written so that this line does not match itself.
pattern='#!?\[(allow|expect)\(|eslint-[d]isable|oxlint-[d]isable|biome-[i]gnore|deno-lint-[i]gnore|@ts-(ignore|expect-error|nocheck)|#[[:space:]]*type:[[:space:]]*ignore|#[[:space:]]*noqa|ruff:[[:space:]]*noq[a]|pyright:[[:space:]]*ignore|pylint:[[:space:]]*[d]isable|mypy:[[:space:]]*(ignore-error[s]|disable-error-cod[e])|swiftlint:[d]isable|//[[:space:]]*nolint|NOLIN[T]|#nose[c]|@Suppress[W]arnings|@SuppressF[B]Warnings|@SuppressLin[t]|@(file:)?Suppress\(|ktlint-[d]isable|NOPM[D]|CHECKSTYLE:OF[F]|//[[:space:]]*noinspectio[n]|SuppressMessag[e]|#pragma warning[[:space:](]*[d]isable|#pragma (GCC|clang) diagnostic ignore[d]|rubocop:([d]isable|tod[o])|phpstan-[i]gnore|psalm-[s]uppress|phpcs:([i]gnore|[d]isable)|shellcheck[[:space:]]+[d]isable'
files=('*.rs' '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.py' '*.pyi' '*.swift' '*.go' '*.rb' '*.rake' '*.java' '*.kt' '*.kts' '*.php' '*.cs' '*.sh' '*.c' '*.h' '*.cc' '*.cpp' '*.hpp' '*.m' '*.mm')

status=0
found="$(git -C "$root" grep -n -I -E "$pattern" -- "${files[@]}")" || status=$?
case "$status" in
    0 | 1) ;;
    *)
        printf 'suppressions: cannot search %s (git grep exit %s)\n' "$root" "$status" >&2
        exit 2
        ;;
esac

if [[ -n "$found" ]]; then
    printf '%s\n' "$found" >&2
    printf 'suppressions: %s inline suppressions found; fix each finding instead\n' "$(grep -c . <<<"$found")" >&2
    exit 1
fi
echo "suppressions: none in tracked source files"
