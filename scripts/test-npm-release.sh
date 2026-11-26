#!/usr/bin/env bash
#
# test-npm-release.sh
# Proves that scripts/npm_release.sh check fails when a package changes a
# published file or a published manifest field without a new version, and
# passes for README, example, tsconfig, and scripts changes. Proves that a
# package that publishes a built dist needs a new version for a source change
# but not for a README or test change. Proves that
# waves publishes a package after the workspace peers it needs.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

manifest() { # $1: name, $2: version, $3: peer dependencies JSON
    jq -n --arg n "$1" --arg v "$2" --argjson p "$3" \
        '{name: $n, version: $v, files: ["index.cjs", "README.md", "examples"], peerDependencies: $p, scripts: {test: "true"}}'
}

repo="$work/repo"
mkdir -p "$repo/scripts" "$repo/js/logbrew-core/examples" "$repo/js/logbrew-adapter" "$repo/apps/n8n/nodes" \
    "$repo/apps/n8n/test"
cp "$root/scripts/npm_release.sh" "$repo/scripts/"
manifest @logbrew/core 1.0.0 '{}' >"$repo/js/logbrew-core/package.json"
manifest @logbrew/adapter 1.0.0 '{"@logbrew/core": "^1.0.0", "express": ">=4"}' >"$repo/js/logbrew-adapter/package.json"
for dir in "$repo"/js/logbrew-*; do
    printf 'module.exports = {};\n' >"$dir/index.cjs"
    printf '# Package\n' >"$dir/README.md"
    printf '{}\n' >"$dir/tsconfig.json"
done
printf 'console.log(1);\n' >"$repo/js/logbrew-core/examples/demo.mjs"
jq -n '{name: "n8n-nodes-logbrew", version: "0.1.0", files: ["dist"], scripts: {build: "tsc"}}' \
    >"$repo/apps/n8n/package.json"
printf 'export {};\n' >"$repo/apps/n8n/nodes/node.ts"
printf 'export {};\n' >"$repo/apps/n8n/test/node.test.ts"
printf '# Node\n' >"$repo/apps/n8n/README.md"
git -C "$repo" init -q
git -C "$repo" -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m base
git -C "$repo" add -A
git -C "$repo" -c user.name=test -c user.email=test@example.com commit -q -m packages
base="$(git -C "$repo" rev-parse HEAD)"

change() { # $1: case name, $2: expected pass|fail, $3: edit run in the repository, $4: failing package
    local output status=0
    git -C "$repo" reset -q --hard "$base"
    (cd "$repo" && eval "$3")
    git -C "$repo" -c user.name=test -c user.email=test@example.com commit -q -am "$1"
    output="$(bash "$repo/scripts/npm_release.sh" check "$base" 2>&1)" || status=$?
    if [[ "$2" == pass && "$status" -ne 0 ]] || [[ "$2" == fail && "$status" -eq 0 ]]; then
        printf 'FAIL: %s should %s\n%s\n' "$1" "$2" "$output" >&2
        exit 1
    fi
    [[ "$2" == pass ]] || grep -qF "${4:-@logbrew/core changed its published files but keeps version 1.0.0}" <<<"$output" ||
        { printf 'FAIL: %s printed %s\n' "$1" "$output" >&2; exit 1; }
}

change "README only" pass 'echo more >>js/logbrew-core/README.md'
change "example only" pass 'echo more >>js/logbrew-core/examples/demo.mjs'
change "tsconfig only" pass 'echo "{ }" >js/logbrew-core/tsconfig.json'
change "scripts only" pass 'jq ".scripts.lint = \"true\"" js/logbrew-core/package.json >m && mv m js/logbrew-core/package.json'
change "code without a version" fail 'echo "// fix" >>js/logbrew-core/index.cjs'
change "peer range without a version" fail 'jq ".peerDependencies.express = \">=5\"" js/logbrew-core/package.json >m && mv m js/logbrew-core/package.json'
change "code with a version" pass 'echo "// fix" >>js/logbrew-core/index.cjs && jq ".version = \"1.0.1\"" js/logbrew-core/package.json >m && mv m js/logbrew-core/package.json'
change "built package README only" pass 'echo more >>apps/n8n/README.md'
change "built package test only" pass 'echo "// more" >>apps/n8n/test/node.test.ts'
change "built package scripts only" pass 'jq ".scripts.lint = \"true\"" apps/n8n/package.json >m && mv m apps/n8n/package.json'
change "built package source without a version" fail 'echo "// fix" >>apps/n8n/nodes/node.ts' \
    'n8n-nodes-logbrew changed its published files but keeps version 0.1.0'
change "built package source with a version" pass \
    'echo "// fix" >>apps/n8n/nodes/node.ts && jq ".version = \"0.1.1\"" apps/n8n/package.json >m && mv m apps/n8n/package.json'

waves="$(bash "$repo/scripts/npm_release.sh" waves "$repo/js/logbrew-adapter" "$repo/js/logbrew-core" | sed "s|$repo/||g")"
[[ "$waves" == $'js/logbrew-core\njs/logbrew-adapter' ]] || { printf 'FAIL: waves printed %s\n' "$waves" >&2; exit 1; }
[[ "$(bash "$repo/scripts/npm_release.sh" waves "$repo/js/logbrew-adapter" | sed "s|$repo/||g")" == js/logbrew-adapter ]] ||
    { echo 'FAIL: a published peer delays its dependent' >&2; exit 1; }

echo "npm release checks ok"
