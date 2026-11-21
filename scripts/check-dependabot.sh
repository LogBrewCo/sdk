#!/usr/bin/env bash
#
# check-dependabot.sh
# Keep this file identical in every public LogBrew repository.
# Checks .github/dependabot.yml against the tracked dependency manifests, so a
# new stable release of any dependency or tool reaches a pull request. Fails when:
# - a tracked manifest sits in a directory that no entry of its ecosystem lists
#   (a Cargo workspace member counts as listed when an ancestor directory is);
# - an entry lists a directory that holds no tracked manifest of its ecosystem;
# - an ecosystem has more than one entry, or an entry lists a glob;
# - an entry does not check daily, wait 2 days after a release
#   (`cooldown: default-days: 2`), or group all updates into one pull request
#   (a group with `patterns: ["*"]`).
# The config uses a YAML subset: block style, one key per line, `directories`
# as a block list, and group patterns on one line.
# Usage: bash scripts/check-dependabot.sh [ROOT]

set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
config="$root/.github/dependabot.yml"
[[ -f "$config" ]] || {
    echo "dependabot: $config is missing" >&2
    exit 1
}
files="$(git -C "$root" ls-files)" || {
    echo "dependabot: cannot list the files of $root" >&2
    exit 2
}

printf '%s\n' "$files" | awk '
    function value(line) {
        sub(/^[^:]*:[ \t]*/, "", line); sub(/[ \t]+#.*$/, "", line)
        gsub(/^["'\'']|["'\'']$/, "", line); return line
    }
    function directory(path) {
        sub(/\/+$/, "", path); sub(/^\/*/, "/", path); return path
    }
    function parent(path) {
        sub(/\/[^\/]*$/, "", path); return path == "" ? "/" : path
    }
    function list(entry, dir) {
        if (dir ~ /[*?\[]/) problem[++problems] = ecosystem[entry] ": " dir " is a glob; list each directory"
        dir = directory(dir); listed[ecosystem[entry], dir] = 1; dirs[entry] = dirs[entry] " " dir
    }
    # The ecosystems that can update a manifest, and its directory in `dir`.
    function ecosystems(path,    base) {
        base = path; sub(/.*\//, "", base); dir = parent("/" path)
        if (path ~ /^\.github\/workflows\/[^\/]+\.ya?ml$/) { dir = "/"; return "github-actions" }
        if (base ~ /^action\.ya?ml$/) return "github-actions"
        if (base == "package.json") return "bun npm"
        if (base == "go.mod") return "gomod"
        if (base == "pyproject.toml" || base == "setup.py" || base == "Pipfile" || base ~ /^requirements.*\.txt$/) return "pip uv"
        if (base == "uv.lock") return "uv"
        if (base == "Cargo.toml") return "cargo"
        if (base == "rust-toolchain" || base == "rust-toolchain.toml") return "rust-toolchain"
        if (base == "Package.swift") return "swift"
        if (base ~ /^(build|settings)\.gradle(\.kts)?$/) return "gradle"
        if (path ~ /(^|\/)gradle\/libs\.versions\.toml$/) { dir = parent(dir); return "gradle" }
        if (base == "pom.xml") return "maven"
        if (base == "composer.json") return "composer"
        if (base ~ /\.(cs|fs|vb)proj$/ || base == "packages.config" || base == "Directory.Packages.props") return "nuget"
        if (base == "global.json") return "dotnet-sdk"
        if (base == "Gemfile" || base == "gems.rb" || base ~ /\.gemspec$/) return "bundler"
        if (base ~ /^(Dockerfile|Containerfile)(\..+)?$/ || base ~ /\.Dockerfile$/) return "docker"
        if (base ~ /^(docker-)?compose(\..+)?\.ya?ml$/) return "docker-compose"
        if (base ~ /\.tf$/) return "terraform"
        if (path ~ /^\.devcontainer(\.json|\/(.+\/)?devcontainer\.json)$/) { dir = "/"; return "devcontainers" }
        if (path == ".pre-commit-config.yaml") { dir = "/"; return "pre-commit" }
        return ""
    }

    # The config comes first on the command line, the tracked files on stdin.
    FNR == NR {
        if ($0 ~ /^[ \t]*(#|$)/) next
        if (inlist && $0 ~ /^[ \t]+- /) { item = $0; sub(/^[ \t]+- /, "", item); list(n, value("x:" item)); next }
        inlist = 0
        if ($0 ~ /^[ \t]*- package-ecosystem:/) {
            ecosystem[++n] = value($0)
            if (++entries[ecosystem[n]] == 2) problem[++problems] = ecosystem[n] ": more than one entry; list every directory in one entry"
        } else if (n && $0 ~ /^[ \t]+directory:/) list(n, value($0))
        else if (n && $0 ~ /^[ \t]+directories:[ \t]*$/) inlist = 1
        else if (n && $0 ~ /^[ \t]+interval:/) interval[n] = value($0)
        else if (n && $0 ~ /^[ \t]+default-days:/) days[n] = value($0)
        else if (n && $0 ~ /^[ \t]+patterns:[ \t]*\[[ \t]*["'\'']\*["'\''][ \t]*\][ \t]*$/) grouped[n] = 1
        next
    }

    {
        split(ecosystems($0), kinds, " ")
        if (!(1 in kinds)) next
        covered = 0
        for (k in kinds) {
            found[kinds[k], dir] = 1
            if ((kinds[k], dir) in listed) covered = 1
            if (kinds[k] == "cargo") for (up = dir; up != "/" && !covered; ) { up = parent(up); if (("cargo", up) in listed) covered = 1 }
        }
        manifests++
        if (!covered) problem[++problems] = $0 ": no " kinds[1] (2 in kinds ? " or " kinds[2] : "") " entry lists " dir
    }

    END {
        for (i = 1; i <= n; i++) {
            name = ecosystem[i]
            if (dirs[i] == "") problem[++problems] = name ": lists no directory"
            split(dirs[i], each, " ")
            for (d in each) if (!((name, each[d]) in found)) problem[++problems] = name ": " each[d] " holds no tracked " name " manifest"
            if (interval[i] != "daily") problem[++problems] = name ": schedule interval is \"" interval[i] "\"; use daily"
            if (days[i] != "2") problem[++problems] = name ": cooldown default-days is \"" days[i] "\"; use 2"
            if (!grouped[i]) problem[++problems] = name ": needs a group with patterns: [\"*\"] so one pull request carries its updates"
        }
        for (i = 1; i <= problems; i++) print "dependabot: " problem[i] > "/dev/stderr"
        if (problems) exit 1
        printf "dependabot: %d entries cover %d tracked manifests\n", n, manifests
    }
' "$config" -
