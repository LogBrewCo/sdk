#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust axum real-user smoke failed near line $LINENO" >&2' ERR
export CARGO_HOME="$tmp_dir/cargo-home"
mkdir -p "$CARGO_HOME"

assert_logbrew_path_dependency() {
	local manifest_path="$1"
	local package_name="$2"
	local path_suffix="$3"
	python3 - "$manifest_path" "$package_name" "$path_suffix" <<'PY'
import sys
import tomllib
from pathlib import Path

manifest_path, package_name, path_suffix = sys.argv[1:]
manifest = tomllib.loads(Path(manifest_path).read_text())
package = manifest.get("package", {})
if package.get("name") != package_name:
    raise SystemExit(f"unexpected Cargo package name: {package.get('name')!r}")
dependency = manifest.get("dependencies", {}).get("logbrew")
if not isinstance(dependency, dict):
    raise SystemExit(f"expected table dependency for logbrew, found: {dependency!r}")
if dependency.get("version") not in (None, "0.1.0"):
    raise SystemExit(f"unexpected logbrew version requirement: {dependency.get('version')!r}")
dependency_path = str(dependency.get("path", ""))
if not dependency_path.endswith(path_suffix):
    raise SystemExit(f"unexpected logbrew path: {dependency_path!r}")
PY
}

cargo package --allow-dirty --no-verify --manifest-path "$repo_root/rust/logbrew/Cargo.toml" --target-dir "$tmp_dir/cargo-package" >/dev/null
crate_path="$tmp_dir/cargo-package/package/logbrew-0.1.0.crate"
test -f "$crate_path"
tar -tf "$crate_path" > "$tmp_dir/crate-contents.txt"
grep -q '^logbrew-0.1.0/examples/axum_request_middleware.rs$' "$tmp_dir/crate-contents.txt"

crate_src_root="$tmp_dir/extracted-crate"
mkdir -p "$crate_src_root"
tar -xf "$crate_path" -C "$crate_src_root"
crate_dir="$crate_src_root/logbrew-0.1.0"
test -f "$crate_dir/examples/axum_request_middleware.rs"

cd "$tmp_dir"
cargo new --quiet axum-app
cd axum-app
cargo add logbrew --path "$crate_dir" >/dev/null
cargo add axum@0.8 >/dev/null
cargo add tokio@1 --features macros,rt-multi-thread >/dev/null
cargo add tower@0.5 --features util >/dev/null
assert_logbrew_path_dependency Cargo.toml axum-app "/extracted-crate/logbrew-0.1.0"
cp "$crate_dir/examples/axum_request_middleware.rs" src/main.rs

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "axum"$' Cargo.lock
grep -q '^name = "tokio"$' Cargo.lock
grep -q '^name = "tower"$' Cargo.lock
cargo metadata --locked --format-version 1 > axum-cargo-metadata.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("axum-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "axum-app"), None)
if root is None:
    raise SystemExit("expected resolved axum-app package")
direct = {dep.get("name"): dep for dep in root.get("dependencies", [])}
for name in ["axum", "logbrew", "tokio", "tower"]:
    if name not in direct:
        raise SystemExit(f"missing axum-app direct dependency: {name}")
logbrew = direct["logbrew"]
if logbrew.get("req") not in ("^0.1.0", "*"):
    raise SystemExit(f"unexpected logbrew requirement: {logbrew.get('req')}")
if not str(logbrew.get("path", "")).endswith("/extracted-crate/logbrew-0.1.0"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
PY
cargo tree --locked --depth 1 --charset ascii > axum-cargo-tree.txt
grep -q '^axum-app v0.1.0 (' axum-cargo-tree.txt
grep -q 'logbrew v0\.1\.0 .*extracted-crate/logbrew-0\.1\.0' axum-cargo-tree.txt
grep -q 'axum v0\.8\.' axum-cargo-tree.txt
grep -q 'tokio v1\.' axum-cargo-tree.txt
grep -q 'tower v0\.5\.' axum-cargo-tree.txt
cargo run --quiet --locked > axum.stdout.json 2> axum.stderr.json
python3 "$repo_root/scripts/check_rust_axum_payload.py" axum.stdout.json axum.stderr.json >/dev/null
