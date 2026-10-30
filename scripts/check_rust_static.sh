#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/rust/logbrew"

cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --all-features -- -D warnings
for feature in http hyper reqwest tower tracing opentelemetry-exporter tracing-opentelemetry; do
  cargo clippy --all-targets --no-default-features --features "$feature" -- -D warnings
done
cargo clippy --lib --all-features -- -D warnings -D unused_crate_dependencies
cargo doc --no-deps --all-features --quiet

printf 'rust static analysis ok (%s)\n' "$(cargo clippy --version)"
