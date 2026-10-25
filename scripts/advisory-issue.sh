#!/usr/bin/env bash
#
# advisory-issue.sh
# Keeps one open issue, "Dependency advisories", in step with the scheduled
# advisory scan (.github/workflows/advisories.yml). A failed scan opens the
# issue, or updates it and comments when its advisory IDs change; a clean scan
# closes it. Needs GH_TOKEN with issues: write and the GitHub Actions run
# environment. Usage: advisory-issue.sh SCAN_RESULT REPORT_FILE

set -euo pipefail

result="$1" report="$2"
title="Dependency advisories"
issues="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/issues"
run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

api() { # METHOD URL [JSON]
    printf 'Authorization: Bearer %s\n' "$GH_TOKEN" |
        curl -fsS --retry 3 --max-time 30 -X "$1" -H @- -H 'Accept: application/vnd.github+json' ${3:+--data "$3"} "$2"
}
comment() { api POST "$issues/$1/comments" "$(jq -n --arg body "$2" '{body: $body}')" >/dev/null; }

open="$(api GET "$issues?state=open&creator=github-actions%5Bbot%5D&per_page=100" |
    jq --arg title "$title" 'map(select(.title == $title and .pull_request == null)) | first // empty')"
number="$(jq -r '.number // empty' <<<"$open")"

if [[ "$result" == success ]]; then
    if [[ -n "$number" ]]; then
        comment "$number" "A clean scan of $GITHUB_SHA closed this issue: $run"
        api PATCH "$issues/$number" '{"state":"closed","state_reason":"completed"}' >/dev/null
    fi
    exit 0
fi

ids="$(jq -Rrs '[scan("\\b(?:RUSTSEC|GHSA|GO|CVE|PYSEC)-[0-9A-Za-z-]+")] | unique | join(" ")' "$report")"
body="$(jq -rn --rawfile output "$report" --arg ids "$ids" --arg run "$run" --arg ref "$GITHUB_REF_NAME" --arg sha "$GITHUB_SHA" \
    '"The advisory scan of `\($ref)` at \($sha) failed: \($run)\n\n" +
    "Update the affected dependencies or record a reviewed exception, then rerun the Advisories workflow. " +
    "A clean scan closes this issue.\n\nAdvisories: \(if $ids == "" then "none found in the output; the scan itself failed" else $ids end)\n\n" +
    "````text\n\($output | .[-60000:])\n````\n<!-- advisory-ids: \($ids) -->"')"

if [[ -z "$number" ]]; then
    api POST "$issues" "$(jq -n --arg title "$title" --arg body "$body" '{title: $title, body: $body}')" >/dev/null
else
    previous="$(jq -r '.body // "" | capture("<!-- advisory-ids: (?<ids>[^>]*) -->").ids' <<<"$open")"
    api PATCH "$issues/$number" "$(jq -n --arg body "$body" '{body: $body}')" >/dev/null
    [[ "$previous" == "$ids" ]] || comment "$number" "The advisories changed to: ${ids:-none (the scan itself failed)}. $run"
fi
