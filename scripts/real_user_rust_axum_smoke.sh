#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust axum real-user smoke failed near line $LINENO" >&2' ERR
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
if "tower" not in dependency.get("features", []):
    raise SystemExit(f"expected logbrew tower feature, found: {dependency.get('features')!r}")
dependency_path = str(dependency.get("path", ""))
if not dependency_path.endswith(path_suffix):
    raise SystemExit(f"unexpected logbrew path: {dependency_path!r}")
PY
}

cargo package --allow-dirty --no-verify --manifest-path "$repo_root/rust/logbrew/Cargo.toml" --target-dir "$tmp_dir/cargo-package" >/dev/null
crate_path="$tmp_dir/cargo-package/package/$crate_name.crate"
test -f "$crate_path"
tar -tf "$crate_path" > "$tmp_dir/crate-contents.txt"
grep -F -q "$crate_name/examples/axum_request_middleware.rs" "$tmp_dir/crate-contents.txt"

crate_src_root="$tmp_dir/extracted-crate"
mkdir -p "$crate_src_root"
tar -xf "$crate_path" -C "$crate_src_root"
crate_dir="$crate_src_root/$crate_name"
test -f "$crate_dir/examples/axum_request_middleware.rs"
grep -q 'TowerHttpClientSpanLayer' "$crate_dir/README.md"

cd "$tmp_dir"
cargo new --quiet axum-app
cd axum-app
cargo add logbrew --path "$crate_dir" --features tower >/dev/null
cargo add axum@0.8 >/dev/null
cargo add serde_json@1 >/dev/null
cargo add tokio@1 --features macros,rt-multi-thread >/dev/null
cargo add tower@0.5 --features util >/dev/null
assert_logbrew_path_dependency Cargo.toml axum-app "/extracted-crate/$crate_name"
cp "$crate_dir/examples/axum_request_middleware.rs" src/main.rs
mkdir -p src/bin
cat > src/bin/tower_http_client_span.rs <<'EOF'
use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use logbrew::{LogBrewClient, TowerHttpClientSpanLayer, TowerRequestIds};
use serde_json::Value;
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
};
use tower::{Layer, ServiceExt, service_fn};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("tower-http-client-smoke", "0.1.0")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));
    let layer = TowerHttpClientSpanLayer::new(
        Arc::clone(&client),
        |request: &Request<Body>| request.uri().path().replace("/123", "/:payment_id"),
        || {
            TowerRequestIds::new("4bf92f3577b34da6a3ce929d0e0e4736", "2222222222222222")
                .with_parent_span_id("00f067aa0ba902b7")
        },
        || "2026-06-02T10:00:11Z".to_string(),
    );
    let service = service_fn(|request: Request<Body>| async move {
        assert_eq!(
            request
                .headers()
                .get("traceparent")
                .and_then(|value| value.to_str().ok()),
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-01")
        );
        Ok::<_, Infallible>(
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::empty())
                .unwrap(),
        )
    });
    let response = layer
        .layer(service)
        .oneshot(
            Request::builder()
                .method("post")
                .uri("/payments/123?coupon=sample#debug")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let payload: Value = serde_json::from_str(&client.lock().unwrap().preview_json()?)?;
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let span = &events[0]["attributes"];
    assert_eq!(span["name"], "http.client:POST /payments/:payment_id");
    assert_eq!(span["metadata"]["source"], "rust_http_client");
    assert_eq!(span["metadata"]["statusCode"], 502);
    assert_eq!(span["metadata"]["statusCodeClass"], "5xx");
    assert_eq!(span["status"], "error");
    let text = payload.to_string();
    assert!(!text.contains("coupon=sample"));
    assert!(!text.contains("#debug"));
    println!("{{\"ok\":true,\"towerHttpClientSpans\":1}}");
    Ok(())
}
EOF

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "axum"$' Cargo.lock
grep -q '^name = "tokio"$' Cargo.lock
grep -q '^name = "tower"$' Cargo.lock
cargo metadata --locked --format-version 1 > axum-cargo-metadata.json
python3 - <<'PY'
import json
import os
from pathlib import Path

crate_version = os.environ["LOGBREW_RUST_CRATE_VERSION"]
crate_name = f"logbrew-{crate_version}"
payload = json.loads(Path("axum-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "axum-app"), None)
if root is None:
    raise SystemExit("expected resolved axum-app package")
direct = {dep.get("name"): dep for dep in root.get("dependencies", [])}
for name in ["axum", "logbrew", "tokio", "tower"]:
    if name not in direct:
        raise SystemExit(f"missing axum-app direct dependency: {name}")
logbrew = direct["logbrew"]
if logbrew.get("req") not in (f"^{crate_version}", "*"):
    raise SystemExit(f"unexpected logbrew requirement: {logbrew.get('req')}")
if not str(logbrew.get("path", "")).endswith(f"/extracted-crate/{crate_name}"):
    raise SystemExit(f"unexpected logbrew path: {logbrew.get('path')}")
if "tower" not in logbrew.get("features", []):
    raise SystemExit(f"missing logbrew tower feature: {logbrew.get('features')}")
PY
cargo tree --locked --depth 1 --charset ascii > axum-cargo-tree.txt
grep -q '^axum-app v0.1.0 (' axum-cargo-tree.txt
grep -F -q "logbrew v$crate_version" axum-cargo-tree.txt
grep -F -q "extracted-crate/$crate_name" axum-cargo-tree.txt
grep -q 'axum v0\.8\.' axum-cargo-tree.txt
grep -q 'tokio v1\.' axum-cargo-tree.txt
grep -q 'tower v0\.5\.' axum-cargo-tree.txt
cargo run --quiet --locked --bin axum-app > axum.stdout.json 2> axum.stderr.json
python3 "$repo_root/scripts/check_rust_axum_payload.py" axum.stdout.json axum.stderr.json >/dev/null
cargo run --quiet --locked --bin tower_http_client_span > tower-http-client-span.stdout.json
grep -q '"ok":true' tower-http-client-span.stdout.json
grep -q '"towerHttpClientSpans":1' tower-http-client-span.stdout.json
