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
grep -q 'capture_ureq_call' "$crate_dir/README.md"
grep -q 'capture_http_request_send' "$crate_dir/README.md"
grep -q 'capture_reqwest_send' "$crate_dir/README.md"
grep -q 'rust_http_client' "$crate_dir/README.md"

mkdir -p "$tmp_dir/app/src/bin"
cat > "$tmp_dir/app/Cargo.toml" <<EOF
[package]
name = "rust-http-client-span-smoke"
version = "0.1.0"
edition = "2021"

[dependencies]
logbrew = { path = "$crate_dir", features = ["http", "hyper", "reqwest"] }
hyper = "1"
reqwest = "0.12"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
ureq = "3.3"
EOF

cat > "$tmp_dir/app/src/intake.rs" <<'EOF'
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Debug)]
pub struct RequestRecord {
    headers: BTreeMap<String, String>,
}

impl RequestRecord {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(String::as_str)
    }
}

pub struct Intake {
    pub endpoint: String,
    requests: Arc<Mutex<Vec<RequestRecord>>>,
}

impl Intake {
    pub fn start(status_code: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                captured.lock().unwrap().push(read_request(&mut stream));
                let response = format!(
                    "HTTP/1.1 {status_code} OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        Self { endpoint, requests }
    }

    pub fn requests(&self) -> Vec<RequestRecord> {
        self.requests.lock().unwrap().clone()
    }
}

fn read_request(stream: &mut TcpStream) -> RequestRecord {
    let mut buffer = [0_u8; 4096];
    let bytes = stream.read(&mut buffer).unwrap();
    let request = String::from_utf8_lossy(&buffer[..bytes]);
    let header_end = request.find("\r\n\r\n").unwrap_or(request.len());
    let mut headers = BTreeMap::new();
    for line in request[..header_end].lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    RequestRecord { headers }
}
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

cat > "$tmp_dir/app/src/bin/hyper_http_client_span.rs" <<'EOF'
use hyper::{Request, Response};
use logbrew::{HttpClientSpan, LogBrewClient, Traceparent};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?;
    let mut client = LogBrewClient::builder("hyper-http-client-smoke", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let request = Request::builder()
        .method("post")
        .uri("https://payments.example.invalid/api/payments/123?coupon=sample#debug")
        .header("x-caller-owned", "kept")
        .body("safe app-owned body")?;

    let response = HttpClientSpan::new(
        "https://payments.example.invalid/api/payments/:payment_id?coupon=sample#debug",
        "post",
        "3333333333333333",
    )
    .capture_http_request_send(
        &mut client,
        "evt_hyper_http_client_span",
        "2026-06-02T10:00:23Z",
        &context,
        request,
        |request| async move {
            assert_eq!(
                request
                    .headers()
                    .get("traceparent")
                    .and_then(|value| value.to_str().ok()),
                Some("00-4bf92f3577b34da6a3ce929d0e0e4736-3333333333333333-01")
            );
            assert_eq!(
                request
                    .headers()
                    .get("x-caller-owned")
                    .and_then(|value| value.to_str().ok()),
                Some("kept")
            );
            Ok::<_, &'static str>(Response::builder().status(202).body("accepted").unwrap())
        },
    )
    .await
    .unwrap();
    assert_eq!(response.status().as_u16(), 202);

    let preview = client.preview_json()?;
    assert!(preview.contains("\"id\": \"evt_hyper_http_client_span\""));
    assert!(preview.contains("\"name\": \"http.client:POST /api/payments/:payment_id\""));
    assert!(preview.contains("\"source\": \"rust_http_client\""));
    assert!(preview.contains("\"statusCode\": 202"));
    assert!(preview.contains("\"statusCodeClass\": \"2xx\""));
    assert!(!preview.contains("coupon=sample"));
    assert!(!preview.contains("#debug"));
    assert!(!preview.contains("x-caller-owned"));
    assert!(!preview.contains("safe app-owned body"));
    println!("{{\"ok\":true,\"hyperHttpClientSpans\":1}}");
    Ok(())
}

EOF

cat > "$tmp_dir/app/src/bin/ureq_http_client_span.rs" <<'EOF'
#[path = "../intake.rs"]
mod intake;

use intake::Intake;
use logbrew::{HttpClientSpan, LogBrewClient, Traceparent};
use std::time::Duration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let intake = Intake::start(503);
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(2)))
            .build(),
    );
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?;
    let mut client = LogBrewClient::builder("ureq-http-client-smoke", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    let result = HttpClientSpan::new(
        format!("{}/api/payments/:payment_id?card=sample#debug", intake.endpoint),
        "get",
        "1111111111111111",
    )
    .capture_ureq_call(
        &mut client,
        "evt_ureq_http_client_span",
        "2026-06-02T10:00:21Z",
        &context,
        |traceparent| {
            agent
                .get(&format!("{}/api/payments/123?card=sample#debug", intake.endpoint))
                .header("traceparent", traceparent)
                .call()
        },
    );

    assert!(matches!(result, Err(ureq::Error::StatusCode(503))));
    let requests = intake.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].header("traceparent"),
        Some("00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01")
    );

    let preview = client.preview_json()?;
    assert!(preview.contains("\"id\": \"evt_ureq_http_client_span\""));
    assert!(preview.contains("\"name\": \"http.client:GET /api/payments/:payment_id\""));
    assert!(preview.contains("\"source\": \"rust_http_client\""));
    assert!(preview.contains("\"statusCode\": 503"));
    assert!(preview.contains("\"statusCodeClass\": \"5xx\""));
    assert!(preview.contains("\"status\": \"error\""));
    assert!(!preview.contains("card=sample"));
    assert!(!preview.contains("#debug"));
    println!("{{\"ok\":true,\"ureqHttpClientSpans\":1}}");
    Ok(())
}

EOF

cat > "$tmp_dir/app/src/bin/reqwest_http_client_span.rs" <<'EOF'
#[path = "../intake.rs"]
mod intake;

use intake::Intake;
use logbrew::{HttpClientSpan, LogBrewClient, Traceparent};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let intake = Intake::start(502);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?;
    let mut client = LogBrewClient::builder("reqwest-http-client-smoke", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    let response = HttpClientSpan::new(
        format!("{}/api/orders/:order_id?coupon=sample#debug", intake.endpoint),
        "post",
        "2222222222222222",
    )
    .capture_reqwest_send(
        &mut client,
        "evt_reqwest_http_client_span",
        "2026-06-02T10:00:22Z",
        &context,
        http.post(format!("{}/api/orders/123?coupon=sample#debug", intake.endpoint)),
    )
    .await?;
    let error = response.error_for_status().unwrap_err();
    assert_eq!(error.status().map(|status| status.as_u16()), Some(502));

    let requests = intake.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].header("traceparent"),
        Some("00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-01")
    );

    let preview = client.preview_json()?;
    assert!(preview.contains("\"id\": \"evt_reqwest_http_client_span\""));
    assert!(preview.contains("\"name\": \"http.client:POST /api/orders/:order_id\""));
    assert!(preview.contains("\"source\": \"rust_http_client\""));
    assert!(preview.contains("\"statusCode\": 502"));
    assert!(preview.contains("\"statusCodeClass\": \"5xx\""));
    assert!(preview.contains("\"status\": \"error\""));
    assert!(!preview.contains("coupon=sample"));
    assert!(!preview.contains("#debug"));
    println!("{{\"ok\":true,\"reqwestHttpClientSpans\":1}}");
    Ok(())
}

EOF

(
  cd "$tmp_dir/app"
  cargo generate-lockfile --quiet
  cargo run --quiet --locked --bin http_client_span > http-client-span.stdout.json
  cargo run --quiet --locked --bin hyper_http_client_span > hyper-http-client-span.stdout.json
  cargo run --quiet --locked --bin ureq_http_client_span > ureq-http-client-span.stdout.json
  cargo run --quiet --locked --bin reqwest_http_client_span > reqwest-http-client-span.stdout.json
)

grep -q '"ok":true' "$tmp_dir/app/http-client-span.stdout.json"
grep -q '"httpClientSpans":1' "$tmp_dir/app/http-client-span.stdout.json"
grep -q '"ok":true' "$tmp_dir/app/hyper-http-client-span.stdout.json"
grep -q '"hyperHttpClientSpans":1' "$tmp_dir/app/hyper-http-client-span.stdout.json"
grep -q '"ok":true' "$tmp_dir/app/ureq-http-client-span.stdout.json"
grep -q '"ureqHttpClientSpans":1' "$tmp_dir/app/ureq-http-client-span.stdout.json"
grep -q '"ok":true' "$tmp_dir/app/reqwest-http-client-span.stdout.json"
grep -q '"reqwestHttpClientSpans":1' "$tmp_dir/app/reqwest-http-client-span.stdout.json"
printf 'rust http-client real-user smoke passed\n'
