#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust dependency real-user smoke failed near line $LINENO" >&2' ERR
crate_version="$(python3 "$repo_root/scripts/read_rust_crate_version.py" "$repo_root/rust/logbrew/Cargo.toml")"
crate_name="logbrew-$crate_version"

cargo package \
  --allow-dirty \
  --no-verify \
  --manifest-path "$repo_root/rust/logbrew/Cargo.toml" \
  --target-dir "$tmp_dir/cargo-package" >/dev/null

crate_archive="$tmp_dir/cargo-package/package/$crate_name.crate"
tar -xzf "$crate_archive" -C "$tmp_dir"
crate_dir="$tmp_dir/$crate_name"

test -f "$crate_dir/src/operation_tracing.rs"
grep -q 'Dependency Operation Spans' "$crate_dir/README.md"
grep -q 'DependencyOperationSpan' "$crate_dir/README.md"
grep -q 'database.operation' "$crate_dir/README.md"
grep -q 'capture_panic' "$crate_dir/README.md"

mkdir -p "$tmp_dir/app/src/bin"
cat > "$tmp_dir/app/Cargo.toml" <<EOF
[package]
name = "rust-dependency-operation-smoke"
version = "0.1.0"
edition = "2021"

[dependencies]
logbrew = { path = "$crate_dir" }
EOF

cat > "$tmp_dir/app/src/bin/dependency_operation.rs" <<'EOF'
use logbrew::{DependencyOperationSpan, LogBrewClient, Metadata, MetadataValue, Traceparent};
use std::panic::{self, AssertUnwindSafe};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?;
    let mut metadata = Metadata::new();
    metadata.insert("pool".to_string(), MetadataValue::String("primary".to_string()));
    metadata.insert(
        "sql.statement".to_string(),
        MetadataValue::String("select * from users".to_string()),
    );
    metadata.insert(
        "pass.word".to_string(),
        MetadataValue::String("not-for-telemetry".to_string()),
    );

    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let span = DependencyOperationSpan::database("checkout lookup", "abcdef1234567890")
        .with_system("postgres")
        .with_operation("select")
        .with_target("orders")
        .with_duration_ms(8.25)
        .with_metadata(metadata)
        .from_traceparent_context(&context)?;
    client.span("evt_dependency_001", "2026-06-02T10:00:20Z", span)?;

    let previous_hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        DependencyOperationSpan::cache("session refresh", "feedfacecafebeef")
            .with_system("redis")
            .with_operation("get")
            .with_target("sessions")
            .capture_panic(
                &mut client,
                "evt_dependency_panic_001",
                "2026-06-02T10:00:21Z",
                &context,
                || panic::panic_any(String::from("do not capture this panic message")),
            );
    }));
    panic::set_hook(previous_hook);
    assert!(result.is_err());

    let preview = client.preview_json()?;
    assert!(preview.contains("\"name\": \"database.operation:checkout lookup\""));
    assert!(preview.contains("\"name\": \"cache.operation:session refresh\""));
    assert!(preview.contains("\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\""));
    assert!(preview.contains("\"parentSpanId\": \"00f067aa0ba902b7\""));
    assert!(preview.contains("\"db.system\": \"postgres\""));
    assert!(preview.contains("\"db.operation\": \"select\""));
    assert!(preview.contains("\"db.target\": \"orders\""));
    assert!(preview.contains("\"cache.system\": \"redis\""));
    assert!(preview.contains("\"exception.type\": \"panic\""));
    assert!(preview.contains("\"panic\": true"));
    assert!(preview.contains("\"panicType\": \"String\""));
    assert!(preview.contains("\"pool\": \"primary\""));
    assert!(!preview.contains("sql.statement"));
    assert!(!preview.contains("pass.word"));
    assert!(!preview.contains("do not capture this panic message"));
    println!("{{\"ok\":true,\"dependencySpans\":2}}");
    Ok(())
}
EOF

(
  cd "$tmp_dir/app"
  cargo generate-lockfile --quiet
  cargo run --quiet --locked --bin dependency_operation > dependency-operation.stdout.json
)

grep -q '"ok":true' "$tmp_dir/app/dependency-operation.stdout.json"
grep -q '"dependencySpans":2' "$tmp_dir/app/dependency-operation.stdout.json"
printf 'rust dependency real-user smoke passed\n'
