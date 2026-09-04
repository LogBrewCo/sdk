#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust tracing real-user smoke failed near line $LINENO" >&2' ERR
export CARGO_HOME="$tmp_dir/cargo-home"
mkdir -p "$CARGO_HOME"
crate_version="$(python3 "$repo_root/scripts/read_rust_crate_version.py" "$repo_root/rust/logbrew/Cargo.toml")"
crate_name="logbrew-$crate_version"
export LOGBREW_RUST_CRATE_VERSION="$crate_version"

assert_logbrew_path_dependency() {
	local manifest_path="$1"
	local package_name="$2"
	local path_suffix="$3"
	shift 3
	python3 - "$manifest_path" "$package_name" "$path_suffix" "$@" <<'PY'
import sys
import tomllib
import os
from pathlib import Path

manifest_path, package_name, path_suffix, *expected_features = sys.argv[1:]
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
features = dependency.get("features", [])
for feature in expected_features:
    if feature not in features:
        raise SystemExit(f"expected logbrew {feature} feature, found: {features!r}")
dependency_path = str(dependency.get("path", ""))
if not dependency_path.endswith(path_suffix):
    raise SystemExit(f"unexpected logbrew path: {dependency_path!r}")
PY
}

start_app() {
	local app="$1" feature="$2" example="$3"
	cd "$tmp_dir"
	cargo new --quiet "$app"
	cd "$app"
	cargo add logbrew --path "$crate_dir" --features "$feature" >/dev/null
	assert_logbrew_path_dependency Cargo.toml "$app" "/extracted-crate/$crate_name" "$feature"
	cp "$crate_dir/examples/$example" src/main.rs
}

assert_resolved_dependencies() {
	local metadata_path="$1" package_name="$2" feature="$3"
	shift 3
	python3 - "$metadata_path" "$package_name" "$feature" "$crate_name" "$@" <<'PY'
import json
import sys
from pathlib import Path

metadata_path, package_name, feature, crate_name, *expected_dependencies = sys.argv[1:]
crate_version = crate_name.removeprefix("logbrew-")
payload = json.loads(Path(metadata_path).read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == package_name), None)
if root is None:
    raise SystemExit(f"expected resolved {package_name} package")
direct = {dependency.get("name"): dependency for dependency in root.get("dependencies", [])}
for name in ["logbrew", *expected_dependencies]:
    if name not in direct:
        raise SystemExit(f"missing {package_name} direct dependency: {name}")
logbrew = direct["logbrew"]
if logbrew.get("req") not in (f"^{crate_version}", "*"):
    raise SystemExit(f"unexpected logbrew requirement: {logbrew.get('req')}")
if feature not in logbrew.get("features", []):
    raise SystemExit(f"missing logbrew {feature} feature: {logbrew.get('features')}")
if not str(logbrew.get("path", "")).endswith(f"/extracted-crate/{crate_name}"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
PY
}

assert_cargo_tree() {
	local package_name="$1"
	shift
	cargo tree --locked --depth 1 --charset ascii > cargo-tree.txt
	grep -q "^$package_name v0.1.0 (" cargo-tree.txt
	grep -F -q "logbrew v$crate_version" cargo-tree.txt
	grep -F -q "extracted-crate/$crate_name" cargo-tree.txt
	for dependency in "$@"; do grep -q "$dependency" cargo-tree.txt; done
}

cargo package --allow-dirty --no-verify --manifest-path "$repo_root/rust/logbrew/Cargo.toml" --target-dir "$tmp_dir/cargo-package" >/dev/null
crate_path="$tmp_dir/cargo-package/package/$crate_name.crate"
test -f "$crate_path"

crate_src_root="$tmp_dir/extracted-crate"
mkdir -p "$crate_src_root"
tar -xf "$crate_path" -C "$crate_src_root"
crate_dir="$crate_src_root/$crate_name"

start_app tracing-app tracing tracing_bridge.rs
cargo add tracing@0.1 >/dev/null
cargo add tracing-subscriber@0.3 --no-default-features --features registry,std >/dev/null
cargo metadata --locked --format-version 1 > tracing-cargo-metadata.json
assert_resolved_dependencies tracing-cargo-metadata.json tracing-app tracing tracing tracing-subscriber
assert_cargo_tree tracing-app 'tracing v0\.1\.' 'tracing-subscriber v0\.3\.'
cargo run --quiet --locked > tracing.stdout.json 2> tracing.stderr.json
python3 "$repo_root/scripts/check_rust_tracing_payload.py" tracing.stdout.json tracing.stderr.json >/dev/null

start_app tracing-otel-app tracing-opentelemetry tracing_opentelemetry_bridge.rs
cargo add opentelemetry@0.32 --no-default-features --features trace >/dev/null
cargo add tracing@0.1 >/dev/null
cargo add tracing-opentelemetry@0.33 --no-default-features >/dev/null
cargo add tracing-subscriber@0.3 --no-default-features --features registry,std >/dev/null
cargo metadata --locked --format-version 1 > tracing-otel-cargo-metadata.json
assert_resolved_dependencies tracing-otel-cargo-metadata.json tracing-otel-app tracing-opentelemetry opentelemetry tracing tracing-opentelemetry tracing-subscriber
assert_cargo_tree tracing-otel-app 'opentelemetry v0\.32\.' 'tracing-opentelemetry v0\.33\.'
cargo run --quiet --locked > tracing-otel.stdout.json 2> tracing-otel.stderr.json
python3 "$repo_root/scripts/check_rust_tracing_opentelemetry_payload.py" tracing-otel.stdout.json tracing-otel.stderr.json >/dev/null

start_app otel-exporter-app opentelemetry-exporter opentelemetry_exporter.rs
cargo add opentelemetry@0.32 --no-default-features --features trace >/dev/null
cargo add opentelemetry_sdk@0.32 --no-default-features --features trace >/dev/null
cargo metadata --locked --format-version 1 > otel-exporter-cargo-metadata.json
assert_resolved_dependencies otel-exporter-cargo-metadata.json otel-exporter-app opentelemetry-exporter opentelemetry opentelemetry_sdk
assert_cargo_tree otel-exporter-app 'opentelemetry v0\.32\.' 'opentelemetry_sdk v0\.32\.'
cargo run --quiet --locked > otel-exporter.stdout.json 2> otel-exporter.stderr.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("otel-exporter.stdout.json").read_text())
events = payload.get("events", [])
if len(events) != 1:
    raise SystemExit(f"expected 1 event, got {len(events)}")
event = events[0]
if event.get("type") != "span" or event.get("id") != "evt_rust_otel_1":
    raise SystemExit(f"unexpected event identity: {event!r}")
span = event.get("attributes", {})
metadata = span.get("metadata", {})
expected = {
    "source": "opentelemetry.span_exporter",
    "service.name": "checkout-service",
    "service.version": "1.2.3",
    "deployment.environment": "production",
    "otel.span.kind": "server",
    "otel.instrumentation.scope.name": "checkout-instrumentation",
    "http.request.method": "POST",
    "http.route": "/checkout/{cart_id}",
    "http.response.status_code": 202,
}
for key, value in expected.items():
    if metadata.get(key) != value:
        raise SystemExit(f"unexpected metadata {key}: {metadata.get(key)!r}")
if span.get("status") != "ok":
    raise SystemExit(f"unexpected span status: {span.get('status')!r}")
if len(span.get("traceId", "")) != 32 or len(span.get("spanId", "")) != 16:
    raise SystemExit(f"unexpected trace/span ids: {span!r}")
text = json.dumps(payload).lower()
for forbidden in [
    "coupon=sample",
    "bearer",
    "not-for-telemetry",
    "authorization",
    "exception.message",
    "baggage",
    "tracestate",
]:
    if forbidden in text:
        raise SystemExit(f"payload leaked forbidden text: {forbidden}")

stderr = json.loads(Path("otel-exporter.stderr.json").read_text())
if stderr.get("ok") is not True or stderr.get("status") != 202 or stderr.get("events") != 1:
    raise SystemExit(f"unexpected smoke stderr: {stderr!r}")
PY
