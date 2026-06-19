#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust http-client real-user smoke failed near line $LINENO" >&2' ERR

cargo package \
  --allow-dirty \
  --no-verify \
  --manifest-path "$repo_root/rust/logbrew/Cargo.toml" \
  --target-dir "$tmp_dir/cargo-package" >/dev/null

crate_archive="$tmp_dir/cargo-package/package/logbrew-0.1.0.crate"
tar -xzf "$crate_archive" -C "$tmp_dir"
crate_dir="$tmp_dir/logbrew-0.1.0"

test -f "$crate_dir/src/http_client.rs"
test -f "$crate_dir/src/metadata_safety.rs"
grep -q 'Outbound HTTP Client Spans' "$crate_dir/README.md"
grep -q 'HttpClientSpan' "$crate_dir/README.md"
grep -q 'rust_http_client' "$crate_dir/README.md"

mkdir -p "$tmp_dir/app/src/bin"
cat > "$tmp_dir/app/Cargo.toml" <<EOF
[package]
name = "rust-http-client-span-smoke"
version = "0.1.0"
edition = "2021"

[dependencies]
logbrew = { path = "$crate_dir" }
EOF

cat > "$tmp_dir/app/src/bin/http_client_span.rs" <<'EOF'
use logbrew::{HttpClientSpan, LogBrewClient, Metadata, MetadataValue, Traceparent};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?;
    let mut metadata = Metadata::new();
    metadata.insert("retryAttempt".to_string(), MetadataValue::from(2));
    metadata.insert(
        "authorizationHeader".to_string(),
        MetadataValue::String("Bearer not-for-telemetry".to_string()),
    );
    metadata.insert(
        "requestBody".to_string(),
        MetadataValue::String("card=sample".to_string()),
    );

    let outbound = HttpClientSpan::new(
        "https://payments.example.invalid/api/payments/:payment_id?card=sample#debug",
        "post",
        "b7ad6b7169203331",
    )
    .with_status_code(503)
    .with_duration_ms(183.4)
    .with_metadata(metadata)
    .from_traceparent_context(&context)?;

    assert_eq!(
        outbound.outgoing_traceparent,
        "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"
    );

    let mut client = LogBrewClient::builder("http-client-smoke", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    client.span("evt_http_client_span", "2026-06-02T10:00:20Z", outbound.span)?;
    let preview = client.preview_json()?;
    assert!(preview.contains("\"name\": \"http.client:POST /api/payments/:payment_id\""));
    assert!(preview.contains("\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\""));
    assert!(preview.contains("\"parentSpanId\": \"00f067aa0ba902b7\""));
    assert!(preview.contains("\"source\": \"rust_http_client\""));
    assert!(preview.contains("\"statusCode\": 503"));
    assert!(preview.contains("\"statusCodeClass\": \"5xx\""));
    assert!(preview.contains("\"retryAttempt\": 2"));
    assert!(!preview.contains("card=sample"));
    assert!(!preview.contains("#debug"));
    assert!(!preview.contains("authorizationHeader"));
    assert!(!preview.contains("requestBody"));
    println!("{{\"ok\":true,\"httpClientSpans\":1}}");
    Ok(())
}
EOF

(
  cd "$tmp_dir/app"
  cargo generate-lockfile --quiet
  cargo run --quiet --locked --bin http_client_span > http-client-span.stdout.json
)

grep -q '"ok":true' "$tmp_dir/app/http-client-span.stdout.json"
grep -q '"httpClientSpans":1' "$tmp_dir/app/http-client-span.stdout.json"
printf 'rust http-client real-user smoke passed\n'
