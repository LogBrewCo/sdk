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

rust_version="$(awk -F '"' '/^rust-version/ { print $2 }' Cargo.toml)"
rustup toolchain install "$rust_version" --profile minimal --no-self-update
rustup run "$rust_version" cargo check --lib --locked --quiet --config 'build.rustflags=["--cap-lints=allow"]'
rustup run "$rust_version" cargo check --lib --locked --quiet --all-features --config 'build.rustflags=["--cap-lints=allow"]'

printf 'rust static analysis ok (%s)\n' "$(cargo clippy --version)"
