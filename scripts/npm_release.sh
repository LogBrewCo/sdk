#!/usr/bin/env bash
#
# npm_release.sh
# Keeps every change to a published npm file released.
#
#   npm_release.sh check BASE   fail when a package changed its published files
#                               since BASE but kept the version BASE has
#   npm_release.sh waves DIR... print the package directories one publish wave
#                               per line, each wave after the peers it needs
#   npm_release.sh publish      run Publish Packages for every package version
#                               the npm registry does not have, wave by wave
#
# Published files are the manifest `files` entries other than README.md and
# examples, and the manifest fields other than version and scripts. A change
# to only a README, an example, a test, or a tsconfig needs no release.
set -euo pipefail

cd "$(dirname "$0")/.."

package_dirs() {
    local manifest
    for manifest in js/logbrew-*/package.json; do
        [[ "$(jq -r '.private // false' "$manifest")" == true ]] || dirname "$manifest"
    done
}

published_manifest() { # $1: package.json text; prints the fields a consumer reads
    jq -S 'del(.version, .scripts)' <<<"$1"
}

check() {
    local base dir old path paths status=0
    base="$(git merge-base "$1" HEAD)"
    while read -r dir; do
        old="$(git show "$base:$dir/package.json" 2>/dev/null)" || continue
        [[ "$(jq -r .version <<<"$old")" == "$(jq -r .version "$dir/package.json")" ]] || continue
        paths=()
        while read -r path; do paths+=("$dir/$path"); done < <(
            jq -r '.files[] | select(. != "README.md" and . != "examples")' "$dir/package.json")
        if git diff --quiet "$base" HEAD -- "${paths[@]}" &&
            [[ "$(published_manifest "$old")" == "$(published_manifest "$(cat "$dir/package.json")")" ]]; then
            continue
        fi
        printf '%s changed its published files but keeps version %s. Advance the version in %s/package.json.\n' \
            "$(jq -r .name "$dir/package.json")" "$(jq -r .version "$dir/package.json")" "$dir" >&2
        status=1
    done < <(package_dirs)
    return "$status"
}

waves() {
    local pending=" " dir peer wave rest
    for dir in "$@"; do pending+="$(jq -r .name "$dir/package.json") "; done
    while (($#)); do
        wave="" rest=()
        for dir in "$@"; do
            while read -r peer; do
                if [[ "$pending" == *" $peer "* ]]; then rest+=("$dir"); continue 2; fi
            done < <(jq -r '.peerDependencies // {} | keys[] | select(startswith("@logbrew/"))' "$dir/package.json")
            wave+="$dir "
        done
        [[ -n "$wave" ]] || { echo "npm peers form a cycle: $*" >&2; return 1; }
        echo "${wave% }"
        for dir in $wave; do
            peer="$(jq -r .name "$dir/package.json")"
            pending="${pending/ $peer / }"
        done
        set -- ${rest[@]+"${rest[@]}"}
    done
}

publish_run() { # $1: package name; prints the Publish Packages run it dispatches
    local title="Publish $1 from $GITHUB_SHA" since id
    since="$(date -u +%s)"
    gh workflow run publish-packages.yml --ref main -f ref="$GITHUB_SHA" -f target=npm -f dry_run=false \
        -f npm_packages="$1" >/dev/null
    for _ in $(seq 30); do
        id="$(gh run list --workflow publish-packages.yml --event workflow_dispatch --limit 30 \
            --json databaseId,displayTitle,createdAt |
            jq -r --arg t "$title" --argjson s "$((since - 5))" \
                'map(select(.displayTitle == $t and (.createdAt | fromdateiso8601) >= $s)) | .[0].databaseId // empty')"
        [[ -z "$id" ]] || { echo "$id"; return; }
        sleep 4
    done
    echo "no Publish Packages run started for $1" >&2
    return 1
}

publish() {
    local dir name version pending=() wave runs id failed=0
    while read -r dir; do
        name="$(jq -r .name "$dir/package.json")" version="$(jq -r .version "$dir/package.json")"
        curl -fsS -o /dev/null "https://registry.npmjs.org/$name/$version" 2>/dev/null || pending+=("$dir")
    done < <(package_dirs)
    ((${#pending[@]})) || { echo "npm has every package version"; return; }
    while read -r wave; do
        runs=()
        for dir in $wave; do
            name="$(jq -r .name "$dir/package.json")"
            if id="$(publish_run "$name")"; then runs+=("$name=$id"); else failed=1; fi
        done
        for id in ${runs[@]+"${runs[@]}"}; do
            if gh run watch "${id#*=}" --exit-status --interval 20 >/dev/null; then
                echo "${id%%=*} published (run ${id#*=})"
            else
                echo "${id%%=*} did not publish (run ${id#*=})" >&2
                failed=1
            fi
        done
    done < <(waves "${pending[@]}")
    return "$failed"
}

case "${1:-}" in
    check) check "${2:?usage: npm_release.sh check BASE}" ;;
    waves) shift; waves "$@" ;;
    publish) publish ;;
    *) echo "usage: npm_release.sh check BASE | waves DIR... | publish" >&2; exit 2 ;;
esac
