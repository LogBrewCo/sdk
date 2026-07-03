#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust actix real-user smoke failed near line $LINENO" >&2' ERR
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
    raise SystemExit(f"Actix example should not require logbrew features: {dependency.get('features')!r}")
dependency_path = str(dependency.get("path", ""))
if not dependency_path.endswith(path_suffix):
    raise SystemExit(f"unexpected logbrew path: {dependency_path!r}")
PY
}

cargo package --allow-dirty --no-verify --manifest-path "$repo_root/rust/logbrew/Cargo.toml" --target-dir "$tmp_dir/cargo-package" >/dev/null
crate_path="$tmp_dir/cargo-package/package/$crate_name.crate"
test -f "$crate_path"
tar -tf "$crate_path" > "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/examples/actix_request_middleware.rs" "$tmp_dir/crate-contents.txt"

crate_src_root="$tmp_dir/extracted-crate"
mkdir -p "$crate_src_root"
tar -xf "$crate_path" -C "$crate_src_root"
crate_dir="$crate_src_root/$crate_name"
test -f "$crate_dir/examples/actix_request_middleware.rs"

cd "$tmp_dir"
cargo new --quiet actix-app
cd actix-app
cargo add logbrew --path "$crate_dir" >/dev/null
cargo add actix-web@4 --no-default-features --features macros >/dev/null
assert_logbrew_path_dependency Cargo.toml actix-app "/extracted-crate/$crate_name"
cp "$crate_dir/examples/actix_request_middleware.rs" src/main.rs

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "actix-web"$' Cargo.lock
if grep -q '^name = "cookie"$' Cargo.lock; then
	echo "Actix smoke should not resolve cookie for the request middleware example" >&2
	exit 1
fi
cargo metadata --locked --format-version 1 > actix-cargo-metadata.json
python3 - <<'PY'
import json
import tomllib
import os
from pathlib import Path

crate_version = os.environ["LOGBREW_RUST_CRATE_VERSION"]
crate_name = f"logbrew-{crate_version}"
manifest = tomllib.loads(Path("Cargo.toml").read_text())
actix = manifest.get("dependencies", {}).get("actix-web")
if not isinstance(actix, dict):
    raise SystemExit(f"expected table dependency for actix-web, found: {actix!r}")
if actix.get("default-features") is not False:
    raise SystemExit("Actix middleware smoke should disable unused default features")
if actix.get("features") != ["macros"]:
    raise SystemExit(f"unexpected actix-web features: {actix.get('features')!r}")

payload = json.loads(Path("actix-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "actix-app"), None)
if root is None:
    raise SystemExit("expected resolved actix-app package")
direct = {dep.get("name"): dep for dep in root.get("dependencies", [])}
for name in ["actix-web", "logbrew"]:
    if name not in direct:
        raise SystemExit(f"missing actix-app direct dependency: {name}")
logbrew = direct["logbrew"]
if logbrew.get("req") not in (f"^{crate_version}", "*"):
    raise SystemExit(f"unexpected logbrew requirement: {logbrew.get('req')}")
if not str(logbrew.get("path", "")).endswith(f"/extracted-crate/{crate_name}"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
if logbrew.get("features"):
    raise SystemExit(f"unexpected logbrew features: {logbrew.get('features')}")
PY
cargo tree --locked --depth 1 --charset ascii > actix-cargo-tree.txt
grep -q '^actix-app v0.1.0 (' actix-cargo-tree.txt
grep -F -q "logbrew v$crate_version" actix-cargo-tree.txt
grep -F -q "extracted-crate/$crate_name" actix-cargo-tree.txt
grep -q 'actix-web v4\.' actix-cargo-tree.txt
cargo run --quiet --locked > actix.stdout.json 2> actix.stderr.json
python3 "$repo_root/scripts/check_rust_actix_payload.py" actix.stdout.json actix.stderr.json >/dev/null
