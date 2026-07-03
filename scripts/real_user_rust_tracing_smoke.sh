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

cargo package --allow-dirty --no-verify --manifest-path "$repo_root/rust/logbrew/Cargo.toml" --target-dir "$tmp_dir/cargo-package" >/dev/null
crate_path="$tmp_dir/cargo-package/package/$crate_name.crate"
test -f "$crate_path"
tar -tf "$crate_path" > "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/src/tracing_layer.rs" "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/src/opentelemetry_exporter.rs" "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/examples/tracing_bridge.rs" "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/examples/tracing_opentelemetry_bridge.rs" "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/examples/opentelemetry_exporter.rs" "$tmp_dir/crate-contents.txt"

crate_src_root="$tmp_dir/extracted-crate"
mkdir -p "$crate_src_root"
tar -xf "$crate_path" -C "$crate_src_root"
crate_dir="$crate_src_root/$crate_name"
test -f "$crate_dir/examples/tracing_bridge.rs"

cd "$tmp_dir"
cargo new --quiet tracing-app
cd tracing-app
cargo add logbrew --path "$crate_dir" --features tracing >/dev/null
cargo add tracing@0.1 >/dev/null
cargo add tracing-subscriber@0.3 --no-default-features --features registry,std >/dev/null
assert_logbrew_path_dependency Cargo.toml tracing-app "/extracted-crate/$crate_name" tracing
cp "$crate_dir/examples/tracing_bridge.rs" src/main.rs

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "tracing"$' Cargo.lock
grep -q '^name = "tracing-subscriber"$' Cargo.lock
cargo metadata --locked --format-version 1 > tracing-cargo-metadata.json
python3 - <<'PY'
import json
import os
from pathlib import Path

crate_version = os.environ["LOGBREW_RUST_CRATE_VERSION"]
crate_name = f"logbrew-{crate_version}"
payload = json.loads(Path("tracing-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "tracing-app"), None)
if root is None:
    raise SystemExit("expected resolved tracing-app package")
direct = {dep.get("name"): dep for dep in root.get("dependencies", [])}
for name in ["logbrew", "tracing", "tracing-subscriber"]:
    if name not in direct:
        raise SystemExit(f"missing tracing-app direct dependency: {name}")
logbrew = direct["logbrew"]
if logbrew.get("req") not in (f"^{crate_version}", "*"):
    raise SystemExit(f"unexpected logbrew requirement: {logbrew.get('req')}")
if not str(logbrew.get("path", "")).endswith(f"/extracted-crate/{crate_name}"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
if "tracing" not in logbrew.get("features", []):
    raise SystemExit(f"missing logbrew tracing feature: {logbrew.get('features')}")
PY
cargo tree --locked --depth 1 --charset ascii > tracing-cargo-tree.txt
grep -q '^tracing-app v0.1.0 (' tracing-cargo-tree.txt
grep -F -q "logbrew v$crate_version" tracing-cargo-tree.txt
grep -F -q "extracted-crate/$crate_name" tracing-cargo-tree.txt
grep -q 'tracing v0\.1\.' tracing-cargo-tree.txt
grep -q 'tracing-subscriber v0\.3\.' tracing-cargo-tree.txt
cargo run --quiet --locked > tracing.stdout.json 2> tracing.stderr.json
python3 "$repo_root/scripts/check_rust_tracing_payload.py" tracing.stdout.json tracing.stderr.json >/dev/null

cd "$tmp_dir"
cargo new --quiet tracing-otel-app
cd tracing-otel-app
cargo add logbrew --path "$crate_dir" --features tracing-opentelemetry >/dev/null
cargo add opentelemetry@0.32 --no-default-features --features trace >/dev/null
cargo add tracing@0.1 >/dev/null
cargo add tracing-opentelemetry@0.33 --no-default-features >/dev/null
cargo add tracing-subscriber@0.3 --no-default-features --features registry,std >/dev/null
assert_logbrew_path_dependency Cargo.toml tracing-otel-app "/extracted-crate/$crate_name" tracing-opentelemetry
cp "$crate_dir/examples/tracing_opentelemetry_bridge.rs" src/main.rs

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "opentelemetry"$' Cargo.lock
grep -q '^name = "tracing-opentelemetry"$' Cargo.lock
cargo metadata --locked --format-version 1 > tracing-otel-cargo-metadata.json
python3 - <<'PY'
import json
import os
from pathlib import Path

crate_name = f"logbrew-{os.environ['LOGBREW_RUST_CRATE_VERSION']}"
payload = json.loads(Path("tracing-otel-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "tracing-otel-app"), None)
if root is None:
    raise SystemExit("expected resolved tracing-otel-app package")
direct = {dep.get("name"): dep for dep in root.get("dependencies", [])}
for name in ["logbrew", "opentelemetry", "tracing", "tracing-opentelemetry", "tracing-subscriber"]:
    if name not in direct:
        raise SystemExit(f"missing tracing-otel-app direct dependency: {name}")
logbrew = direct["logbrew"]
if "tracing-opentelemetry" not in logbrew.get("features", []):
    raise SystemExit(f"missing logbrew tracing-opentelemetry feature: {logbrew.get('features')}")
if not str(logbrew.get("path", "")).endswith(f"/extracted-crate/{crate_name}"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
PY
cargo tree --locked --depth 1 --charset ascii > tracing-otel-cargo-tree.txt
grep -q '^tracing-otel-app v0.1.0 (' tracing-otel-cargo-tree.txt
grep -F -q "logbrew v$crate_version" tracing-otel-cargo-tree.txt
grep -F -q "extracted-crate/$crate_name" tracing-otel-cargo-tree.txt
grep -q 'opentelemetry v0\.32\.' tracing-otel-cargo-tree.txt
grep -q 'tracing-opentelemetry v0\.33\.' tracing-otel-cargo-tree.txt
cargo run --quiet --locked > tracing-otel.stdout.json 2> tracing-otel.stderr.json
python3 "$repo_root/scripts/check_rust_tracing_opentelemetry_payload.py" tracing-otel.stdout.json tracing-otel.stderr.json >/dev/null

cd "$tmp_dir"
cargo new --quiet otel-exporter-app
cd otel-exporter-app
cargo add logbrew --path "$crate_dir" --features opentelemetry-exporter >/dev/null
cargo add opentelemetry@0.32 --no-default-features --features trace >/dev/null
cargo add opentelemetry_sdk@0.32 --no-default-features --features trace >/dev/null
assert_logbrew_path_dependency Cargo.toml otel-exporter-app "/extracted-crate/$crate_name" opentelemetry-exporter
cp "$crate_dir/examples/opentelemetry_exporter.rs" src/main.rs

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "opentelemetry"$' Cargo.lock
grep -q '^name = "opentelemetry_sdk"$' Cargo.lock
cargo metadata --locked --format-version 1 > otel-exporter-cargo-metadata.json
python3 - <<'PY'
import json
import os
from pathlib import Path

crate_name = f"logbrew-{os.environ['LOGBREW_RUST_CRATE_VERSION']}"
payload = json.loads(Path("otel-exporter-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "otel-exporter-app"), None)
if root is None:
    raise SystemExit("expected resolved otel-exporter-app package")
direct = {dep.get("name"): dep for dep in root.get("dependencies", [])}
for name in ["logbrew", "opentelemetry", "opentelemetry_sdk"]:
    if name not in direct:
        raise SystemExit(f"missing otel-exporter-app direct dependency: {name}")
logbrew = direct["logbrew"]
if "opentelemetry-exporter" not in logbrew.get("features", []):
    raise SystemExit(f"missing logbrew opentelemetry-exporter feature: {logbrew.get('features')}")
if not str(logbrew.get("path", "")).endswith(f"/extracted-crate/{crate_name}"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
PY
cargo tree --locked --depth 1 --charset ascii > otel-exporter-cargo-tree.txt
grep -q '^otel-exporter-app v0.1.0 (' otel-exporter-cargo-tree.txt
grep -F -q "logbrew v$crate_version" otel-exporter-cargo-tree.txt
grep -F -q "extracted-crate/$crate_name" otel-exporter-cargo-tree.txt
grep -q 'opentelemetry v0\.32\.' otel-exporter-cargo-tree.txt
grep -q 'opentelemetry_sdk v0\.32\.' otel-exporter-cargo-tree.txt
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
