#!/usr/bin/env bash
#
# check-suppressions.sh
# Keep this file identical in every public LogBrew repository.
# Fails when a tracked source file turns off a lint or type check inline, for
# example with an allow or expect attribute, a noqa comment, or a ts-expect-error
# comment. Fix the finding instead. When a rule is wrong for a whole kind of
# file, change the linter configuration and give the reason there.
#
# A suppression that the language makes necessary goes in
# quality/suppressions-allowlist.tsv, one per line: the path, the line without
# its indentation, and the reason, separated by tabs. Lines that start with #
# are comments. Each entry covers one matching line, and an entry that matches
# no line fails the check, so a stale entry cannot hide a new suppression.
# Usage: bash scripts/check-suppressions.sh [ROOT]

set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
allowlist_name="quality/suppressions-allowlist.tsv"
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

allowlist="$root/$allowlist_name"
[[ -f "$allowlist" ]] || allowlist=/dev/null

# Each allowlist entry removes one finding with the same path and text. The
# script prints the remaining findings and the entries that matched nothing.
report="$(
    awk -v list="$allowlist" -v name="$allowlist_name" '
        function trim(text) {
            sub(/^[ \t]+/, "", text)
            sub(/[ \t\r]+$/, "", text)
            return text
        }
        BEGIN {
            while ((getline entry < list) > 0) {
                number++
                if (entry ~ /^[ \t]*(#|$)/) continue
                if (split(entry, field, "\t") != 3 || field[1] == "" || field[2] == "" || field[3] == "") {
                    printf "bad\t%s:%d: needs path, line, and reason separated by tabs\n", name, number
                    continue
                }
                key = field[1] SUBSEP trim(field[2])
                allowed[key]++
                where[key] = where[key] (where[key] == "" ? " " : ", ") number
            }
        }
        $0 != "" {
            first = index($0, ":")
            rest = substr($0, first + 1)
            second = index(rest, ":")
            key = substr($0, 1, first - 1) SUBSEP trim(substr(rest, second + 1))
            if (allowed[key] > 0) {
                allowed[key]--
                printf "listed\t%s\n", $0
            } else {
                printf "found\t%s\n", $0
            }
        }
        END {
            for (key in allowed) {
                if (allowed[key] > 0) {
                    split(key, part, SUBSEP)
                    printf "stale\t%s line%s: no line left in %s matches: %s\n", name, where[key], part[1], part[2]
                }
            }
        }
    ' <<<"$found"
)"

count() { grep -c "^$1	" <<<"$report" || true; }
listed="$(count listed)"
unlisted="$(count found)"
problems="$(grep -E '^(bad|stale)	' <<<"$report" | cut -f2- || true)"

if ((unlisted > 0)); then
    grep '^found	' <<<"$report" | cut -f2- >&2
fi
if [[ -n "$problems" ]]; then
    printf '%s\n' "$problems" >&2
fi
if ((unlisted > 0)); then
    printf 'suppressions: %s inline suppressions found; fix each finding instead\n' "$unlisted" >&2
fi
if [[ -n "$problems" ]]; then
    printf 'suppressions: fix or remove each %s entry above\n' "$allowlist_name" >&2
fi
if ((unlisted > 0)) || [[ -n "$problems" ]]; then
    exit 1
fi
if ((listed > 0)); then
    printf 'suppressions: none in tracked source files outside %s (%s listed)\n' "$allowlist_name" "$listed"
else
    echo "suppressions: none in tracked source files"
fi
