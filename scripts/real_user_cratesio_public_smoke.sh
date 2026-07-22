#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
receipt_failure() {
  if [[ "$receipt_mode" == "1" ]]; then
    echo "crates release receipt failed" >&2
  else
    echo "rust public crates.io install smoke failed near line $LINENO" >&2
  fi
}
trap receipt_failure ERR

version="${1:-${LOGBREW_CRATESIO_VERSION:-0.1.2}}"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"
export CARGO_HOME="$tmp_dir/cargo-home"
mkdir -p "$CARGO_HOME"

run_receipt_smoke() {
  local bound="$tmp_dir/receipt-artifacts"
  local metadata="$tmp_dir/receipt-metadata.json"
  local extracted="$tmp_dir/receipt-source"
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "crates" --output-dir "$bound" --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" extract \
    --family "crates" --metadata "$metadata" --index 0 --output-dir "$extracted" \
    >"$tmp_dir/receipt-extract.out" 2>"$tmp_dir/receipt-extract.err"
  local package_root
  package_root="$(find "$extracted" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -n "$package_root" && -f "$package_root/Cargo.toml" ]]
  python3 - "$package_root/Cargo.toml" "$version" >"$tmp_dir/receipt-identity.out" <<'PY'
import sys
import tomllib
from pathlib import Path

package = tomllib.loads(Path(sys.argv[1]).read_text(encoding="utf-8")).get("package", {})
if package.get("name") != "logbrew" or package.get("version") != sys.argv[2]:
    raise SystemExit(1)
PY

  local app="$tmp_dir/receipt-app"
  cargo new --quiet --bin "$app"
  cat >> "$app/Cargo.toml" <<EOF
logbrew = { path = "$package_root" }
EOF
  cat > "$app/src/main.rs" <<'RS'
use logbrew::{LogBrewClient, LogEvent, RecordingTransport};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("receipt", "0.1.0").api_key("key").build()?;
    client.log("event", "2026-01-01T00:00:00Z", LogEvent::new("ok", "info"))?;
    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    assert_eq!(response.status_code, 202);
    Ok(())
}
RS
  cargo run --quiet --manifest-path "$app/Cargo.toml" \
    >"$tmp_dir/receipt-run.out" 2>"$tmp_dir/receipt-run.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "crates" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  run_receipt_smoke
  exit 0
fi

app_dir="$tmp_dir/logbrew-cratesio-user"
cargo new --quiet --bin "$app_dir"
cd "$app_dir"

cargo add logbrew@"$version" --registry crates-io --quiet
cargo tree > "$tmp_dir/cargo-tree.txt"
grep -q "logbrew v$version" "$tmp_dir/cargo-tree.txt"

python3 - "$app_dir/Cargo.toml" "$version" <<'PY'
import sys
import tomllib
from pathlib import Path

manifest_path = Path(sys.argv[1])
expected_version = sys.argv[2]
manifest = tomllib.loads(manifest_path.read_text())
dependency = manifest.get("dependencies", {}).get("logbrew")
if dependency != expected_version:
    raise SystemExit(f"expected logbrew dependency {expected_version!r}, found {dependency!r}")
PY

cat > src/main.rs <<'RS'
use logbrew::{
    ActionEvent, EnvironmentEvent, LogBrewClient, LogEvent, RecordingTransport, ReleaseEvent,
    SpanEvent,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("cratesio-smoke", "0.1.0")
        .api_key("public-cratesio-smoke-key")
        .build()?;

    client.release(
        "evt_release_public_crate",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;
    client.environment(
        "evt_environment_public_crate",
        "2026-06-02T10:00:01Z",
        EnvironmentEvent::new("production"),
    )?;
    client.log(
        "evt_log_public_crate",
        "2026-06-02T10:00:02Z",
        LogEvent::new("public crate smoke", "info"),
    )?;
    client.span(
        "evt_span_public_crate",
        "2026-06-02T10:00:03Z",
        SpanEvent::new("GET /health", "trace_public_crate", "span_public_crate", "ok")
            .with_duration_ms(12.5),
    )?;
    client.action(
        "evt_action_public_crate",
        "2026-06-02T10:00:04Z",
        ActionEvent::new("install.cratesio", "success"),
    )?;

    let preview = client.preview_json()?;
    assert!(preview.contains("\"type\": \"release\""));
    assert!(preview.contains("\"type\": \"environment\""));
    assert!(preview.contains("\"type\": \"log\""));
    assert!(preview.contains("\"type\": \"span\""));
    assert!(preview.contains("\"type\": \"action\""));

    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    println!(
        "rust public crates.io install smoke passed status={status}",
        status = response.status_code
    );
    assert_eq!(response.status_code, 202);
    assert_eq!(response.attempts, 1);
    Ok(())
}
RS

cargo run --quiet > "$tmp_dir/run.stdout" 2> "$tmp_dir/run.stderr"
grep -q "rust public crates.io install smoke passed" "$tmp_dir/run.stdout"
grep -q "status=202" "$tmp_dir/run.stdout"

cargo doc --no-deps -p logbrew --quiet
test -f target/doc/logbrew/index.html

printf 'rust public crates.io install smoke passed for logbrew %s\n' "$version"
