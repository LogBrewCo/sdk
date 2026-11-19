#!/usr/bin/env bash
#
# test-check-suppressions.sh
# Keep this file identical in every public LogBrew repository.
# Proves that scripts/check-suppressions.sh passes on this repository and on a
# clean repository, fails on each seeded inline suppression with its path and
# line, and fails when it cannot search the repository.
# The seeded lines are built at run time, so this file holds no suppression
# itself.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
check="$root/scripts/check-suppressions.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

seed() {
    rm -rf "$work/repo"
    git init -q "$work/repo"
    mkdir -p "$(dirname "$work/repo/$1")"
    printf 'let clean = 1;\n%s\n' "$2" >"$work/repo/$1"
    git -C "$work/repo" add -A
}


expect_pass() {
    local name="$1"
    bash "$check" "$work/repo" >/dev/null || {
        printf 'FAIL: %s failed\n' "$name" >&2
        exit 1
    }
    printf 'ok: %s passes\n' "$name"
}

expect_report() {
    local name="$1" text="$2" output
    if output="$(bash "$check" "$work/repo" 2>&1)"; then
        printf 'FAIL: %s passed\n' "$name" >&2
        exit 1
    fi
    grep -qF -- "$text" <<<"$output" || {
        printf 'FAIL: %s did not report %s:\n%s\n' "$name" "$text" "$output" >&2
        exit 1
    }
    printf 'ok: %s fails\n' "$name"
}

expect_failure() {
    local name="$1" file="$2"
    seed "$file" "$3"
    expect_report "$name" "$file:2:"
}

bash "$check" "$root" >/dev/null
printf 'ok: this repository passes\n'

seed src/lib.rs 'let other = 2;'
bash "$check" "$work/repo" >/dev/null
printf 'ok: a clean repository passes\n'

expect_failure "a Rust allow attribute" src/lib.rs "$(printf '#[%s(dead_code)]' allow)"
expect_failure "a Rust inner expect attribute" src/main.rs "$(printf '#![%s(clippy::unwrap_used)]' expect)"
expect_failure "a Python noqa comment" scripts/tool.py "$(printf 'import os  # %s: E402' noqa)"
expect_failure "a Ruff file noqa comment" scripts/tool.py "$(printf '# ruff: %s' noqa)"
expect_failure "a Python type ignore comment" scripts/tool.py "$(printf 'value = 1  # type: %s' ignore)"
expect_failure "a Pyright ignore comment" scripts/tool.py "$(printf 'value = 1  # pyright: %s' ignore)"
expect_failure "a Pylint disable comment" scripts/tool.py "$(printf '# pylint: %s=invalid-name' disable)"
expect_failure "a mypy file comment" scripts/tool.py "$(printf '# mypy: %s' ignore-errors)"
expect_failure "a TypeScript expect-error comment" src/index.ts "$(printf '// @ts-%s' expect-error)"
expect_failure "a TypeScript nocheck comment" src/index.cts "$(printf '// @ts-%s' nocheck)"
expect_failure "an ESLint disable comment" src/index.js "$(printf '// eslint-%s-next-line' disable)"
expect_failure "a Biome ignore comment" src/index.mjs "$(printf '// biome-%s lint: reason' ignore)"
expect_failure "a ShellCheck disable comment" scripts/run.sh "$(printf '# shellcheck %s=SC2034' disable)"
expect_failure "a Go nolint comment" main.go "$(printf 'x := 1 //%s:gosec' nolint)"
expect_failure "a gosec nosec comment" main.go "$(printf 'x := 1 // #%s G104' nosec)"
expect_failure "a Java SuppressWarnings annotation" src/Main.java "$(printf '@Suppress%s("unchecked")' Warnings)"
expect_failure "a SpotBugs SuppressFBWarnings annotation" src/Main.java "$(printf '@SuppressFB%s("EI_EXPOSE_REP")' Warnings)"
expect_failure "a PMD comment" src/Main.java "$(printf 'int x = 1; // NO%s' PMD)"
expect_failure "a Kotlin Suppress annotation" src/Main.kt "$(printf '@%s("UNCHECKED_CAST")' Suppress)"
expect_failure "a Kotlin file Suppress annotation" build.gradle.kts "$(printf '@file:%s("UNUSED")' Suppress)"
expect_failure "a ktlint disable comment" src/Main.kt "$(printf '// ktlint-%s' disable)"
expect_failure "a C# suppress-message attribute" src/Client.cs "$(printf '[Suppress%s("Design", "CA1031")]' Message)"
expect_failure "a C# pragma warning" src/Client.cs "$(printf '#pragma warning %s CS8618' disable)"
expect_failure "a Ruby RuboCop disable comment" lib/client.rb "$(printf 'x = 1 # rubocop:%s Style/Foo' disable)"
expect_failure "a PHPStan ignore comment" src/Client.php "$(printf '// @phpstan-%s-next-line' ignore)"
expect_failure "a SwiftLint disable comment" Sources/App.swift "$(printf '// swiftlint:%s force_cast' disable)"
expect_failure "a clang-tidy no-lint comment" src/client.c "$(printf 'int x = 1; // NO%s' LINT)"
expect_failure "a GCC diagnostic pragma" src/client.h "$(printf '#pragma GCC diagnostic %s "-Wformat"' ignored)"
expect_failure "a clang diagnostic pragma" src/Client.m "$(printf '#pragma clang diagnostic %s "-Wunused"' ignored)"
expect_failure "an MSVC warning pragma" src/client.cpp "$(printf '#pragma warning(%s: 4996)' disable)"

seed src/Main.java "$(printf '    @Suppress%s("unchecked")' Warnings)"
printf '    %s\n' "$(printf '@Suppress%s("unchecked")' Warnings)" >>"$work/repo/src/Main.java"
git -C "$work/repo" add -A
expect_report "the second of 2 suppressions" "src/Main.java:3:"

mkdir -p "$work/plain"
if bash "$check" "$work/plain" >/dev/null 2>&1; then
    printf 'FAIL: a directory outside Git passed\n' >&2
    exit 1
fi
printf 'ok: a directory outside Git fails\n'
