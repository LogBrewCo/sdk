#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
trap 'printf "%s\n" "rust automatic delivery installed smoke failed" >&2' ERR

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
test -f "$crate_dir/src/delivery/automatic.rs"
grep -q 'Automatic Delivery' "$crate_dir/README.md"

cat >"$tmp_dir/app/Cargo.toml" <<EOF
[package]
name = "rust-automatic-delivery-smoke"
version = "0.1.0"
edition = "2024"

[dependencies]
logbrew = { path = "$crate_dir", features = ["http"] }
serde_json = "=1.0.151"
EOF

cat >"$tmp_dir/app/src/main.rs" <<'EOF'
use logbrew::{
    AutomaticDeliveryConfig, DeliveryOutcome, DeliveryPauseReason, HttpTransport,
    HttpTransportConfig, LogBrewClient, LogEvent,
};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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
            content_length = Some(value.trim().parse::<usize>().expect("length should be numeric"));
        }
    }
    let content_length = content_length.expect("content length should be present");
    assert!(content_length <= 256 * 1024, "request body exceeded fixture limit");
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body).expect("request body should be complete");
    body
}

fn event_ids(body: &[u8]) -> Vec<String> {
    let value: Value = serde_json::from_slice(body).expect("request body should be JSON");
    value["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .map(|event| event["id"].as_str().expect("event id should exist").to_string())
        .collect()
}

fn queue(client: &mut LogBrewClient, id: &str) {
    client
        .log(id, TIMESTAMP, LogEvent::new("fixture event", "info"))
        .expect("event should be admitted");
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !condition() {
        assert!(Instant::now() < deadline, "condition timed out");
        thread::sleep(Duration::from_millis(2));
    }
}

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback should bind");
    let endpoint = format!("http://{}", listener.local_addr().expect("address should exist"));
    let (requests_sender, requests_receiver) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for status in [503, 202, 202, 401, 202, 202, 202] {
            let (mut stream, _) = listener.accept().expect("request should connect");
            requests.push(read_request(&mut stream));
            let reason = if status == 202 { "Accepted" } else { "Rejected" };
            write!(
                stream,
                "HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            )
            .expect("response should write");
        }
        requests_sender.send(requests).expect("requests should return");
    });

    let transport = HttpTransport::new(HttpTransportConfig {
        endpoint,
        timeout: Some(Duration::from_secs(5)),
        ..HttpTransportConfig::default()
    })
    .expect("transport should build");
    let mut client = LogBrewClient::builder("installed-automatic-smoke", env!("CARGO_PKG_VERSION"))
        .api_key("LOGBREW_TEST_KEY_MATERIAL")
        .max_retries(0)
        .max_batch_events(2)
        .build_with_owned_transport(
            transport,
            AutomaticDeliveryConfig {
                enabled: true,
                interval: Duration::from_millis(30),
                threshold: 2,
                retry_base_delay: Duration::from_millis(10),
                retry_max_delay: Duration::from_millis(20),
            },
        )
        .expect("automatic client should build");

    queue(&mut client, "evt_threshold_1");
    queue(&mut client, "evt_threshold_2");
    wait_until(Duration::from_secs(5), || client.pending_events() == 0);

    queue(&mut client, "evt_interval");
    wait_until(Duration::from_secs(5), || client.pending_events() == 0);

    queue(&mut client, "evt_paused");
    wait_until(Duration::from_secs(5), || {
        client.delivery_health().pause_reason == DeliveryPauseReason::Authentication
    });
    queue(&mut client, "evt_later");
    let recovered = client.flush_owned().expect("manual recovery should succeed");
    assert_eq!(recovered.accepted_events, 2);

    queue(&mut client, "evt_shutdown");
    let shutdown = client.shutdown_owned().expect("shutdown should succeed");
    assert_eq!(shutdown.accepted_events, 1);

    let requests = requests_receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("request records should return");
    server.join().expect("server should stop");
    assert_eq!(requests.len(), 7);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(event_ids(&requests[0]), ["evt_threshold_1", "evt_threshold_2"]);
    assert_eq!(event_ids(&requests[2]), ["evt_interval"]);
    assert_eq!(event_ids(&requests[3]), ["evt_paused"]);
    assert_eq!(event_ids(&requests[4]), ["evt_paused"]);
    assert_eq!(event_ids(&requests[5]), ["evt_later"]);
    assert_eq!(event_ids(&requests[6]), ["evt_shutdown"]);

    let health = client.delivery_health();
    assert!(health.closed);
    assert!(!health.automatic_enabled);
    assert!(!health.automatic_running);
    assert_eq!(health.pending_events, 0);
    assert_eq!(health.pause_reason, DeliveryPauseReason::None);
    assert_eq!(health.last_outcome, DeliveryOutcome::Closed);
    assert_eq!(health.attempts, 7);
    assert_eq!(health.batches, 5);
    assert_eq!(health.accepted_events, 6);

    println!("{{\"ok\":true,\"requests\":7,\"batches\":5,\"accepted\":6,\"closed\":true}}");
}
EOF

(
  cd "$tmp_dir/app"
  CARGO_NET_OFFLINE=true cargo generate-lockfile --offline \
    >"$tmp_dir/lock.stdout" 2>"$tmp_dir/lock.stderr"
  CARGO_NET_OFFLINE=true cargo build --offline --locked --quiet --target-dir "$tmp_dir/consumer-target" \
    >"$tmp_dir/build.stdout" 2>"$tmp_dir/build.stderr"
)

python3 - "$tmp_dir/consumer-target/debug/rust-automatic-delivery-smoke" "$tmp_dir/consumer.stdout" "$tmp_dir/consumer.stderr" <<'PY'
import pathlib
import subprocess
import sys

completed = subprocess.run([sys.argv[1]], capture_output=True, check=False, timeout=30)
pathlib.Path(sys.argv[2]).write_bytes(completed.stdout)
pathlib.Path(sys.argv[3]).write_bytes(completed.stderr)
if completed.returncode != 0:
    raise SystemExit("installed consumer failed")
PY

expected_output='{"ok":true,"requests":7,"batches":5,"accepted":6,"closed":true}'
test "$(tr -d '\r\n' <"$tmp_dir/consumer.stdout")" = "$expected_output"
test ! -s "$tmp_dir/consumer.stderr"
if grep -Eqi 'LOGBREW_TEST_KEY_MATERIAL|evt_threshold|evt_interval|evt_paused|evt_later|evt_shutdown|https?://|/Users/|/home/' \
  "$tmp_dir/consumer.stdout" "$tmp_dir/consumer.stderr"; then
  printf '%s\n' 'installed consumer output was not content-free' >&2
  exit 1
fi

printf 'rust automatic delivery installed smoke passed version=%s sha256=%s requests=7 batches=5 accepted=6 closed=true\n' \
  "$crate_version" "$crate_digest"
