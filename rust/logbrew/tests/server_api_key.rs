//! Server API key resolution. Each case runs in a child test process that owns its environment.
#![cfg(test)]
use logbrew::{LogBrewClient, LogEvent, Transport, TransportError, TransportResponse};
use std::env;
use std::process::Command;

const CASE_VARIABLE: &str = "LOGBREW_SERVER_API_KEY_TEST_CASE";

#[derive(Default)]
struct KeyRecordingTransport {
    api_keys: Vec<String>,
}

impl Transport for KeyRecordingTransport {
    fn send(&mut self, api_key: &str, _body: &[u8]) -> Result<TransportResponse, TransportError> {
        self.api_keys.push(api_key.to_owned());
        Ok(TransportResponse::new(202))
    }
}

fn sent_api_keys(explicit_key: Option<&str>) -> Vec<String> {
    let default_builder = LogBrewClient::builder("logbrew-rust-test", "1.0.0");
    let builder = match explicit_key {
        Some(key) => default_builder.api_key(key),
        None => default_builder,
    };
    let mut client = builder.build().unwrap();
    client
        .log(
            "evt_server_key_001",
            "2026-11-27T10:00:00Z",
            LogEvent::new("first event", "info"),
        )
        .unwrap();
    let mut transport = KeyRecordingTransport::default();
    assert_eq!(client.flush(&mut transport).unwrap().status_code, 202);
    transport.api_keys
}

fn run_case(case: &str, server_api_key: &str) {
    let output = Command::new(env::current_exe().unwrap())
        .args(["--exact", "child_case", "--include-ignored", "--nocapture"])
        .env(CASE_VARIABLE, case)
        .env("LOGBREW_SERVER_API_KEY", server_api_key)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{case} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "runs inside run_case with its own environment"]
fn child_case() {
    match env::var(CASE_VARIABLE).unwrap().as_str() {
        "env_key" => assert_eq!(sent_api_keys(None), ["env-server-key"]),
        "explicit_key" => assert_eq!(sent_api_keys(Some("explicit-key")), ["explicit-key"]),
        "missing_key" => {
            let error = LogBrewClient::builder("logbrew-rust-test", "1.0.0")
                .build()
                .unwrap_err();
            assert_eq!(error.code, "config_error");
            assert!(
                error.message.contains("LOGBREW_SERVER_API_KEY"),
                "{}",
                error.message
            );
        }
        other => panic!("unknown case {other}"),
    }
}

#[test]
fn client_without_key_sends_with_server_api_key_variable() {
    run_case("env_key", "env-server-key");
}

#[test]
fn explicit_key_wins_over_server_api_key_variable() {
    run_case("explicit_key", "env-server-key");
}

#[test]
fn missing_key_names_the_server_api_key_variable() {
    run_case("missing_key", " ");
}
