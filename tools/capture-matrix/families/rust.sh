#!/usr/bin/env bash
# Prepare the shared Cargo target directory $1/target. The Rust probe adds the package from this
# checkout as a path dependency with `cargo add`, the way an app does, so Cargo reuses one build of
# the package and its framework dependencies across runs.
set -euo pipefail

cargo --version >/dev/null
mkdir -p "$1/target"
