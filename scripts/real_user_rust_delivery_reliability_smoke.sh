#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
trap 'printf "%s\n" "rust delivery reliability installed smoke failed" >&2' ERR

crate_version="$(python3 "$repo_root/scripts/read_rust_crate_version.py" "$repo_root/rust/logbrew/Cargo.toml")"
crate_name="logbrew-$crate_version"

CARGO_NET_OFFLINE=true cargo package \
  --allow-dirty \
  --offline \
  --manifest-path "$repo_root/rust/logbrew/Cargo.toml" \
  --target-dir "$tmp_dir/cargo-package" \
  >"$tmp_dir/package.stdout" 2>"$tmp_dir/package.stderr"

crate_archive="$tmp_dir/cargo-package/package/$crate_name.crate"
test -f "$crate_archive"
crate_digest="$(python3 - "$crate_archive" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"

mkdir -p "$tmp_dir/crate" "$tmp_dir/app/src"
tar -xzf "$crate_archive" -C "$tmp_dir/crate"
crate_dir="$tmp_dir/crate/$crate_name"
test -f "$crate_dir/src/delivery.rs"
grep -q 'Bounded Delivery' "$crate_dir/README.md"

cat >"$tmp_dir/app/Cargo.toml" <<EOF
[package]
name = "rust-delivery-reliability-smoke"
version = "0.1.0"
edition = "2024"

[dependencies]
logbrew = { path = "$crate_dir", features = ["http"] }
serde_json = "=1.0.151"
EOF

cat >"$tmp_dir/app/src/main.rs" <<'EOF'
use logbrew::{
    DeliveryCodeCategory, DeliveryOutcome, HttpTransport, HttpTransportConfig, LogBrewClient,
    LogEvent,
};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const TIMESTAMP: &str = "2026-06-02T10:00:00Z";

fn read_request(stream: &mut TcpStream) -> Vec<u8> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("read timeout should configure");
    let mut reader = BufReader::new(stream);
    let mut content_length = None;
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("request headers should read");
        assert!(read > 0, "request headers ended early");
        header_bytes = header_bytes.checked_add(read).expect("header size should fit");
        assert!(header_bytes <= 16 * 1024, "request headers exceeded fixture limit");
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .expect("content length should be numeric"),
            );
        }
    }
    let content_length = content_length.expect("content length should be present");
    assert!(content_length <= 256 * 1024, "request body exceeded fixture limit");
    let mut body = vec![0; content_length];
    reader
        .read_exact(&mut body)
        .expect("request body should be complete");
    body
}

fn event_ids(body: &[u8]) -> Vec<String> {
    let value: Value = serde_json::from_slice(body).expect("request body should be JSON");
    value["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .map(|event| {
            event["id"]
                .as_str()
                .expect("event id should be a string")
                .to_string()
        })
        .collect()
}

fn queue(client: &mut LogBrewClient, id: &str) {
    client
        .log(id, TIMESTAMP, LogEvent::new("fixture event", "info"))
        .expect("event should be admitted");
}

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback should bind");
    let endpoint = format!("http://{}", listener.local_addr().expect("address should exist"));
    let (requests_sender, requests_receiver) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for status in [503, 202, 202, 202] {
            let (mut stream, _) = listener.accept().expect("request should connect");
            requests.push(read_request(&mut stream));
            let reason = if status == 202 {
                "Accepted"
            } else {
                "Service Unavailable"
            };
            write!(
                stream,
                "HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            )
            .expect("response should write");
        }
        requests_sender
            .send(requests)
            .expect("requests should return");
    });

    let mut transport = HttpTransport::new(HttpTransportConfig {
        endpoint,
        timeout: Some(Duration::from_secs(5)),
        ..HttpTransportConfig::default()
    })
    .expect("transport should build");
    let mut client = LogBrewClient::builder("installed-delivery-smoke", env!("CARGO_PKG_VERSION"))
        .api_key("LOGBREW_TEST_KEY_MATERIAL")
        .max_retries(0)
        .max_queue_events(3)
        .max_batch_events(2)
        .build()
        .expect("client should build");

    queue(&mut client, "evt_first");
    queue(&mut client, "evt_second");
    let first_error = client
        .flush(&mut transport)
        .expect_err("first batch should remain queued");
    assert_eq!(first_error.code, "transport_error");
    queue(&mut client, "evt_later");
    let drop_error = client
        .log(
            "evt_dropped",
            TIMESTAMP,
            LogEvent::new("fixture drop", "info"),
        )
        .expect_err("full queue should reject admission");
    assert_eq!(drop_error.code, "queue_full");

    let recovered = client
        .flush(&mut transport)
        .expect("retained prefix should recover");
    assert_eq!(recovered.attempts, 2);
    assert_eq!(recovered.batches, 2);
    assert_eq!(recovered.accepted_events, 3);

    queue(&mut client, "evt_shutdown");
    let shutdown = client
        .shutdown(&mut transport)
        .expect("shutdown snapshot should be accepted");
    assert_eq!(shutdown.attempts, 1);
    assert_eq!(shutdown.batches, 1);
    assert_eq!(shutdown.accepted_events, 1);

    let requests = requests_receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("request records should return");
    server.join().expect("server should stop");
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(event_ids(&requests[0]), ["evt_first", "evt_second"]);
    assert_eq!(event_ids(&requests[2]), ["evt_later"]);
    assert_eq!(event_ids(&requests[3]), ["evt_shutdown"]);

    let health = client.delivery_health();
    assert_eq!(health.pending_events, 0);
    assert_eq!(health.pending_event_bytes, 0);
    assert_eq!(health.dropped_events, 1);
    assert_eq!(health.attempts, 4);
    assert_eq!(health.batches, 3);
    assert_eq!(health.accepted_events, 4);
    assert!(health.closed);
    assert_eq!(health.last_outcome, DeliveryOutcome::Closed);
    assert_eq!(health.last_code, DeliveryCodeCategory::None);

    println!(
        "{{\"ok\":true,\"requests\":4,\"batches\":3,\"accepted\":4,\"drops\":1,\"closed\":true}}"
    );
}
EOF

(
  cd "$tmp_dir/app"
  CARGO_NET_OFFLINE=true cargo generate-lockfile --offline \
    >"$tmp_dir/lock.stdout" 2>"$tmp_dir/lock.stderr"
  CARGO_NET_OFFLINE=true cargo build --offline --locked --quiet --target-dir "$tmp_dir/consumer-target" \
    >"$tmp_dir/build.stdout" 2>"$tmp_dir/build.stderr"
)

python3 - "$tmp_dir/consumer-target/debug/rust-delivery-reliability-smoke" "$tmp_dir/consumer.stdout" "$tmp_dir/consumer.stderr" <<'PY'
import pathlib
import subprocess
import sys

completed = subprocess.run(
    [sys.argv[1]],
    capture_output=True,
    check=False,
    timeout=30,
)
pathlib.Path(sys.argv[2]).write_bytes(completed.stdout)
pathlib.Path(sys.argv[3]).write_bytes(completed.stderr)
if completed.returncode != 0:
    raise SystemExit("installed consumer failed")
PY

expected_output='{"ok":true,"requests":4,"batches":3,"accepted":4,"drops":1,"closed":true}'
test "$(tr -d '\r\n' <"$tmp_dir/consumer.stdout")" = "$expected_output"
test ! -s "$tmp_dir/consumer.stderr"
if grep -Eqi 'LOGBREW_TEST_KEY_MATERIAL|evt_first|evt_second|evt_later|evt_shutdown|https?://|/Users/|/home/' \
  "$tmp_dir/consumer.stdout" "$tmp_dir/consumer.stderr"; then
  printf '%s\n' 'installed consumer output was not content-free' >&2
  exit 1
fi

printf 'rust delivery reliability installed smoke passed version=%s sha256=%s requests=4 batches=3 accepted=4 drops=1\n' \
  "$crate_version" "$crate_digest"
