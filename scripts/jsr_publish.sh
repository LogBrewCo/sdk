#!/usr/bin/env bash
#
# jsr_publish.sh
# Publishes each JavaScript package that has a jsr.json to JSR, with the
# version its package.json gives npm.
#
#   jsr_publish.sh check                  dry-run every JSR package
#   jsr_publish.sh publish-all            publish every JSR package version
#   jsr_publish.sh publish NAME=VERSION...
#                                         publish each listed npm version whose
#                                         package has a jsr.json
#
# The publish modes run in GitHub Actions: the job signs in through GitHub OIDC,
# and JSR adds provenance and skips a version it already has. JSR accepts the
# sign-in only when a scope member started the workflow run, so a run that
# github-actions[bot] started cannot publish.
set -euo pipefail

cd "$(dirname "$0")/.."

jsr_cli=tools/jsr-publish/node_modules/.bin/jsr
[[ -x "$jsr_cli" ]] || bun install --cwd tools/jsr-publish --frozen-lockfile --ignore-scripts >/dev/null

# A jsr.json import such as "npm:@logbrew/sdk@^0.1.48" resolves through
# node_modules, so link each package in this repository there while JSR reads it.
linked=()
unlink_local_packages() { ((${#linked[@]})) && rm "${linked[@]}"; return 0; }
trap unlink_local_packages EXIT
link_local_packages() {
    local manifest link
    mkdir -p js/node_modules/@logbrew
    for manifest in js/logbrew-*/package.json; do
        link="js/node_modules/$(jq -r .name "$manifest")"
        [[ -e "$link" ]] && continue
        ln -s "../../$(basename "$(dirname "$manifest")")" "$link"
        linked+=("$link")
    done
}

run_jsr() { # $1: package dir; the rest go to jsr publish
    local dir="$1" name
    shift
    name="$(jq -r .name "$dir/package.json")"
    if [[ "$(jq -r .name "$dir/jsr.json")" != "$name" ]]; then
        echo "$dir/jsr.json must name $name, as package.json does" >&2
        return 1
    fi
    (cd "$dir" && bun "../../$jsr_cli" publish --set-version "$(jq -r .version package.json)" "$@")
}

publish_all() { # arguments go to jsr publish
    local manifest
    for manifest in js/*/jsr.json; do
        run_jsr "$(dirname "$manifest")" "$@"
    done
}

publish() {
    local manifest dir release
    for release in "$@"; do
        for manifest in js/*/jsr.json; do
            dir="$(dirname "$manifest")"
            [[ "$release" == "$(jq -r '.name + "=" + .version' "$dir/package.json")" ]] || continue
            run_jsr "$dir"
        done
    done
}

case "${1:-}" in
    check) link_local_packages; publish_all --dry-run --allow-dirty ;;
    publish-all) link_local_packages; publish_all ;;
    publish) shift; link_local_packages; publish "$@" ;;
    *) echo "usage: jsr_publish.sh check | publish-all | publish NAME=VERSION..." >&2; exit 2 ;;
esac
