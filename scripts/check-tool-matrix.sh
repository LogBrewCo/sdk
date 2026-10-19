#!/usr/bin/env bash
#
# check-tool-matrix.sh
# Keep this file identical in every public LogBrew repository.
# Checks quality/tool-matrix.toml against the repository's gates. Fails when:
# - a command a gate runs is neither a tool's `commands` entry nor in `utilities`;
# - a workflow action is not in any tool's `uses` (by name), is not pinned to a full
#   commit with a version comment, or has different pins in different workflows;
# - a tool's `pins` text (with @VERSION@ replaced by its version) is missing from its file;
# - a tool was last checked more than 30 days ago, or in the future;
# - a tool lacks a required field, or names a command no gate runs.
# A `commands` entry ending in * covers every command that starts with it.
#
# The gates are every workflow plus the scripts the matrix lists in `gates`.
# The matrix uses a line-oriented TOML subset: one `key = value` per line,
# arrays on one line. Usage: scripts/check-tool-matrix.sh [REPOSITORY_ROOT [TODAY]]

set -euo pipefail
shopt -s nullglob

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
today="${2:-$(date -u +%F)}"
matrix="$root/quality/tool-matrix.toml"
[[ -f "$matrix" ]] || { echo "tool matrix: $matrix is missing" >&2; exit 1; }

# Prints the values of a one-line string array or a string, one per line.
values() { sed -n "s/^$1 = //p" | { grep -oE '"([^"\\]|\\.)*"' || true; } | sed 's/^"//; s/"$//; s/\\"/"/g'; }

days() { # days since 1970-01-01 for YYYY-MM-DD, without GNU date
    local y=$((10#${1:0:4})) m=$((10#${1:5:2})) d=$((10#${1:8:2}))
    ((m <= 2)) && { y=$((y - 1)); m=$((m + 12)); }
    echo $((365 * y + y / 4 - y / 100 + y / 400 + (153 * (m - 3) + 2) / 5 + d - 719469))
}

errors=()
fail() { errors+=("$*"); }

# Split the matrix into tool blocks (the header is block 0).
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
awk -v dir="$work" '/^\[\[tool\]\]$/ { n++ } { print > (dir "/" n+0) }' "$matrix"
values gates <"$work/0" >"$work/gates"
values utilities <"$work/0" >"$work/known"
: >"$work/uses"
for block in "$work"/[1-9]*; do
    id="$(values id <"$block")"
    [[ -n "$id" ]] || { fail "a [[tool]] entry has no id"; continue; }
    for key in risk tool version config conflicts exceptions runtime findings replaces runs_in; do
        grep -q "^$key = \"..*\"" "$block" || fail "$id: \`$key\` must be a non-empty string"
    done
    grep -qE '^(commands|uses) = ' "$block" || fail "$id: needs \`commands\` or \`uses\`"
    version="$(values version <"$block")"
    checked="$(sed -n 's/^checked = \([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)$/\1/p' "$block")"
    if [[ -z "$checked" ]]; then
        fail "$id: \`checked\` must be a date (YYYY-MM-DD)"
    elif (($(days "$checked") > $(days "$today"))); then
        fail "$id: checked $checked is in the future"
    elif (($(days "$today") - $(days "$checked") > 30)); then
        fail "$id: last checked $checked, more than 30 days ago; check its releases, advisories, and rules, then update the entry"
    fi
    if ! grep -q '^pins = ' "$block" && ! grep -q '^unpinned = "..*"' "$block"; then
        fail "$id: needs \`pins\` or \`unpinned\` (the reason)"
    fi
    while IFS= read -r pin; do
        file="${pin%%::*}" text="${pin#*::}"
        text="${text//@VERSION@/$version}"
        [[ -f "$root/$file" ]] || { fail "$id: pin file $file is missing"; continue; }
        grep -qF -- "$text" "$root/$file" || fail "$id: $file no longer pins \`$text\`; the gate's version differs from the matrix"
    done < <(values pins <"$block")
    values commands <"$block" | sed "s|^|$id	|" >>"$work/commands"
    values uses <"$block" >>"$work/uses"
done
[[ -s "$work/commands" ]] || : >"$work/commands"

# Commands the gates run: `run:` steps in workflows, every line of gate scripts.
{
    for workflow in "$root"/.github/workflows/*.y*ml; do
        name=".github/workflows/${workflow##*/}"
        awk -v name="$name" '
            function indent(s) { match(s, /^ */); return RLENGTH }
            block && (NF == 0 || indent($0) > depth) { print name "\t" $0; next }
            { block = 0 }
            /^[ -]*run: *[|>]/ { block = 1; depth = indent($0); next }
            /^[ -]*run: / { sub(/^[ -]*run: /, ""); print name "\t" $0 }
        ' "$workflow"
    done
    while IFS= read -r gate; do
        [[ -f "$root/$gate" ]] || { fail "gate $gate is missing"; continue; }
        sed "s|^|$gate	|" "$root/$gate"
    done <"$work/gates"
} | awk -F '\t' -v q="'" '
    # Heredoc bodies are data.
    BEGIN { quoted = "<<-?[ ]*[" q "\"][A-Za-z_]+[" q "\"]"; bare = "<<-?[ ]*[A-Za-z_]+" }
    $1 != file { if (joined != "") print file "\t" joined; file = $1; stop = ""; joined = ""; array = 0 }
    stop != "" { if ($2 ~ "^[ \t]*" stop "$") stop = ""; next }
    # Multi-line array assignments are data.
    array { if ($2 ~ /\)[ \t]*$/) array = 0; next }
    $2 ~ /^[ \t]*(local |declare |readonly )?[A-Za-z_][A-Za-z0-9_]*\+?=\([^)]*$/ { array = 1; next }
    # Join lines continued with a backslash.
    $2 ~ /\\$/ { joined = joined substr($2, 1, length($2) - 1) " "; next }
    joined != "" { $2 = joined $2; joined = "" }
    {
        # A quoted terminator counts; a << inside a quoted string does not.
        unquoted = $2; gsub(/"[^"]*"/, "", unquoted); gsub(q "[^" q "]*" q, "", unquoted)
        if (match($2, quoted)) stop = substr($2, RSTART, RLENGTH)
        else if (match(unquoted, bare)) stop = substr(unquoted, RSTART, RLENGTH)
        gsub("[<" q "\" -]", "", stop)
    }
    { print }
' | awk -F '\t' -v q="'" '
    BEGIN {
        split("! { } if then else elif while until do time exec env", w, " "); for (i in w) prefix[w[i]] = 1
        split("for case select in fi done esac function return", w, " "); for (i in w) skip[w[i]] = 1
    }
    function emit(file, words, n,    i, word, name, next1) {
        i = 1
        while (i <= n && (words[i] in prefix || words[i] ~ /^[A-Za-z_][A-Za-z0-9_]*\+?=/)) i++
        if (i > n || words[i] in skip) return
        word = words[i]
        if (word ~ /^\$[A-Za-z_{]/) { if (word !~ /\//) return; sub(/^[^\/]*\//, "", word) }
        sub(/^(\.\.?\/)+/, "", word)
        if (word !~ /^[A-Za-z0-9_][A-Za-z0-9_.\/:+-]*$/ && word != "[[" && word != "[") return
        if (word ~ /\)$/ || word == "S" || word == "A" || word ~ /^[0-9]+$/) return
        name = word
        if (word == "cargo" || word == "go" || word == "npm" || word == "bun" || word == "swift" || word == "dotnet" || word == "gradle" || word == "./gradlew") {
            for (i++; i <= n; i++) {
                if (words[i] == "-C") { i++; continue }
                if (words[i] !~ /^[-+]/) { if (words[i] != "S") name = word " " words[i]; break }
            }
        } else if (word == "bash" || word == "sh" || word == "python3" || word == "python" || word == "source" || word == ".") {
            for (i++; i <= n; i++) if (words[i] !~ /^-/) { next1 = words[i]; break }
            gsub("[\"" q "]", "", next1); sub(/^\$[A-Za-z_{}]*\//, "", next1); sub(/^(\.\.?\/)+/, "", next1)
            if (next1 ~ /\.(sh|py)$/) name = next1
        }
        print file "\t" name
    }
    {
        line = $2
        if (line ~ /^[ \t]*#/) next
        while ((p = index(line, "${{")) && (e = index(substr(line, p), "}}")))  # workflow expressions
            line = substr(line, 1, p - 1) "S" substr(line, p + e + 1)
        # Single-quoted strings, which may span lines, are data.
        if ($1 != file) { file = $1; open = 0 }
        if (open) { if (!(p = index(line, q))) next; line = substr(line, p + 1); open = 0 }
        gsub(q "[^" q "]*" q, "S", line)
        if ((p = index(line, q))) { line = substr(line, 1, p - 1); open = 1 }
        gsub(/\$?\(\([^)]*\)\)/, "0", line)              # arithmetic
        gsub(/[A-Za-z_][A-Za-z0-9_]*\+?=\([^)]*\)/, "A", line)  # one-line arrays
        sub(/^[ \t]*[^()$=]+\)[ \t]*/, "", line)             # a case pattern
        # Double-quoted strings are data unless they hold a command substitution
        # or name a program by path ("$tools/name").
        rest = line; line = ""
        while (match(rest, /"[^"]*"/)) {
            quoted = substr(rest, RSTART, RLENGTH)
            if (quoted ~ /^"\$[A-Za-z_{}]+\/[A-Za-z0-9_.\/-]+"$/) quoted = substr(quoted, 2, length(quoted) - 2)
            else if (!index(quoted, "$(")) quoted = (substr(rest, 1, RSTART - 1) ~ /=$/ ? "S" : " S ")
            line = line substr(rest, 1, RSTART - 1) quoted
            rest = substr(rest, RSTART + RLENGTH)
        }
        line = line rest
        gsub(/[0-9]?>&[0-9]|&>/, " ", line)            # redirections
        gsub(/"/, "", line)
        gsub(/\$\(|`|&&|\|\||[;|&()]/, "\n", line)
        n = split(line, parts, "\n")
        for (p = 1; p <= n; p++) {
            m = split(parts[p], words, /[ \t]+/)
            j = 0; for (k = 1; k <= m; k++) if (words[k] != "") clean[++j] = words[k]
            if (j > 0) emit($1, clean, j)
            delete clean
        }
    }
' | sort -u >"$work/found"

# Shell functions the gates define are not tools.
while IFS= read -r gate; do
    [[ ! -f "$gate" ]] || sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_-]*\)[[:space:]]*()[[:space:]]*[{(].*/\1/p' "$gate"
done < <(sed "s|^|$root/|" "$work/gates"; printf '%s\n' "$root"/.github/workflows/*.y*ml) >>"$work/known"
cut -f 2 "$work/commands" >>"$work/known"

# A `commands` entry may end in * to cover every command with that prefix.
prefixes=()
while IFS= read -r prefix; do prefixes+=("$prefix"); done < <(sed -n 's/\*$//p' "$work/known")
listed() {
    grep -qxF -- "$1" "$work/known" && return 0
    local prefix
    for prefix in ${prefixes[@]+"${prefixes[@]}"}; do [[ "$1" == "$prefix"* ]] && return 0; done
    return 1
}
while IFS=$'\t' read -r file command; do
    listed "$command" || fail "$file: \`$command\` has no tool-matrix entry; add it to quality/tool-matrix.toml"
done <"$work/found"
while IFS=$'\t' read -r id command; do
    if [[ "$command" == *"*" ]]; then
        cut -f 2 "$work/found" | grep -qF -- "${command%"*"}" && continue
    else
        cut -f 2 "$work/found" | grep -qxF -- "$command" && continue
    fi
    fail "$id: command \`$command\` matches no gate command; remove it"
done <"$work/commands"

# Actions: the matrix lists each action by name; the workflows hold its pin.
# Every remote action is pinned to a full commit with a version comment, and
# one action has one pin across all workflows, so an update changes only the
# workflows. A local action (./path) needs no pin.
for workflow in "$root"/.github/workflows/*.y*ml; do
    awk -v file="${workflow##*/}" '/^[ -]*uses: / { sub(/^[ -]*uses: */, ""); sub(/ +$/, ""); print file "\t" $0 }' "$workflow"
done >"$work/actions"
while IFS=$'\t' read -r file uses; do
    name="${uses%%@*}"
    grep -qxF -- "$name" "$work/uses" || fail "$file: action \`$name\` is not in any tool's \`uses\`; add it to quality/tool-matrix.toml"
    [[ "$name" == ./* ]] && continue
    [[ "${uses#*@}" =~ ^[0-9a-f]{40}\ \#\ [^\ ]+$ ]] ||
        fail "$file: \`uses: $uses\` is not pinned to a commit; use $name@<40-hex commit> # <version>"
done <"$work/actions"
cut -f 2 "$work/actions" | grep -v '^\./' | sort -u | awk -F '@' '{ n[$1]++ } n[$1] == 2 { print $1 }' |
    while IFS= read -r name; do
        echo "action \`$name\` is pinned to more than one commit or version across workflows; use one pin"
    done >"$work/pin-errors"
while IFS= read -r line; do fail "$line"; done <"$work/pin-errors"
while IFS= read -r name; do
    awk -F '\t' -v name="$name" '{ split($2, part, "@") } part[1] == name { found = 1 } END { exit !found }' "$work/actions" ||
        fail "action \`$name\` is in a tool's \`uses\` but no workflow uses it; remove it"
done <"$work/uses"

if ((${#errors[@]} > 0)); then
    printf 'tool matrix: %s\n' "${errors[@]}" >&2
    exit 1
fi
echo "tool matrix: $(grep -c '^\[\[tool\]\]$' "$matrix") tools, every gate command listed, every pin current"
