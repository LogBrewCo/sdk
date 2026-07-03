#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust rocket real-user smoke failed near line $LINENO" >&2' ERR
export CARGO_HOME="$tmp_dir/cargo-home"
mkdir -p "$CARGO_HOME"
crate_version="$(python3 "$repo_root/scripts/read_rust_crate_version.py" "$repo_root/rust/logbrew/Cargo.toml")"
crate_name="logbrew-$crate_version"
export LOGBREW_RUST_CRATE_VERSION="$crate_version"

assert_logbrew_path_dependency() {
	local manifest_path="$1"
	local package_name="$2"
	local path_suffix="$3"
	python3 - "$manifest_path" "$package_name" "$path_suffix" <<'PY'
import sys
import tomllib
import os
from pathlib import Path

manifest_path, package_name, path_suffix = sys.argv[1:]
expected_version = os.environ["LOGBREW_RUST_CRATE_VERSION"]
manifest = tomllib.loads(Path(manifest_path).read_text())
package = manifest.get("package", {})
if package.get("name") != package_name:
    raise SystemExit(f"unexpected Cargo package name: {package.get('name')!r}")
dependency = manifest.get("dependencies", {}).get("logbrew")
if not isinstance(dependency, dict):
    raise SystemExit(f"expected table dependency for logbrew, found: {dependency!r}")
if dependency.get("version") not in (None, expected_version):
    raise SystemExit(f"unexpected logbrew version requirement: {dependency.get('version')!r}")
if dependency.get("features"):
    raise SystemExit(f"Rocket example should not require logbrew features: {dependency.get('features')!r}")
dependency_path = str(dependency.get("path", ""))
if not dependency_path.endswith(path_suffix):
    raise SystemExit(f"unexpected logbrew path: {dependency_path!r}")
PY
}

cargo package --allow-dirty --no-verify --manifest-path "$repo_root/rust/logbrew/Cargo.toml" --target-dir "$tmp_dir/cargo-package" >/dev/null
crate_path="$tmp_dir/cargo-package/package/$crate_name.crate"
test -f "$crate_path"
tar -tf "$crate_path" > "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/examples/rocket_request_fairing.rs" "$tmp_dir/crate-contents.txt"

crate_src_root="$tmp_dir/extracted-crate"
mkdir -p "$crate_src_root"
tar -xf "$crate_path" -C "$crate_src_root"
crate_dir="$crate_src_root/$crate_name"
test -f "$crate_dir/examples/rocket_request_fairing.rs"

cd "$tmp_dir"
cargo new --quiet rocket-app
cd rocket-app
cargo add logbrew --path "$crate_dir" >/dev/null
cargo add rocket@0.5 >/dev/null
cargo add time@=0.3.51 >/dev/null
assert_logbrew_path_dependency Cargo.toml rocket-app "/extracted-crate/$crate_name"
cp "$crate_dir/examples/rocket_request_fairing.rs" src/main.rs

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "rocket"$' Cargo.lock
grep -q '^name = "time"$' Cargo.lock
cargo metadata --locked --format-version 1 > rocket-cargo-metadata.json
python3 - <<'PY'
import json
import os
from pathlib import Path

crate_version = os.environ["LOGBREW_RUST_CRATE_VERSION"]
crate_name = f"logbrew-{crate_version}"
payload = json.loads(Path("rocket-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "rocket-app"), None)
if root is None:
    raise SystemExit("expected resolved rocket-app package")
direct = {dep.get("name"): dep for dep in root.get("dependencies", [])}
for name in ["logbrew", "rocket", "time"]:
    if name not in direct:
        raise SystemExit(f"missing rocket-app direct dependency: {name}")
logbrew = direct["logbrew"]
if logbrew.get("req") not in (f"^{crate_version}", "*"):
    raise SystemExit(f"unexpected logbrew requirement: {logbrew.get('req')}")
if not str(logbrew.get("path", "")).endswith(f"/extracted-crate/{crate_name}"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
if logbrew.get("features"):
    raise SystemExit(f"unexpected logbrew features: {logbrew.get('features')}")
time = direct["time"]
if time.get("req") != "=0.3.51":
    raise SystemExit(f"unexpected Rocket compatibility time requirement: {time.get('req')}")
PY
cargo tree --locked --depth 1 --charset ascii > rocket-cargo-tree.txt
grep -q '^rocket-app v0.1.0 (' rocket-cargo-tree.txt
grep -F -q "logbrew v$crate_version" rocket-cargo-tree.txt
grep -F -q "extracted-crate/$crate_name" rocket-cargo-tree.txt
grep -q 'rocket v0\.5\.' rocket-cargo-tree.txt
grep -q 'time v0\.3\.51' rocket-cargo-tree.txt
cargo run --quiet --locked > rocket.stdout.json 2> rocket.stderr.json
python3 "$repo_root/scripts/check_rust_rocket_payload.py" rocket.stdout.json rocket.stderr.json >/dev/null
