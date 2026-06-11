use logbrew::{
    ActionEvent, EnvironmentEvent, IssueEvent, LogBrewClient, LogEvent, MetricEvent,
    RecordingTransport, ReleaseEvent, SdkError, SpanEvent, TransportError,
};
#[cfg(feature = "http")]
use logbrew::{HttpTransport, HttpTransportConfig, Transport};
use serde_json::Value;
#[cfg(feature = "http")]
use std::io::{Read, Write};
#[cfg(feature = "http")]
use std::net::TcpListener;
#[cfg(feature = "http")]
use std::thread;
#[cfg(feature = "http")]
use std::time::Duration;

fn sample_client() -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .max_retries(2)
        .build()
        .expect("client should build")
}

fn enqueue_all(client: &mut LogBrewClient) {
    client
        .release(
            "evt_release_001",
            "2026-06-02T10:00:00Z",
            ReleaseEvent::new("1.2.3").with_commit("abc123def456"),
        )
        .unwrap();
    client
        .environment(
            "evt_environment_001",
            "2026-06-02T10:00:01Z",
            EnvironmentEvent::new("production").with_region("global"),
        )
        .unwrap();
    client
        .issue(
            "evt_issue_001",
            "2026-06-02T10:00:02Z",
            IssueEvent::new("Checkout timeout", "error")
                .with_message("Request timed out after retry budget"),
        )
        .unwrap();
    client
        .log(
            "evt_log_001",
            "2026-06-02T10:00:03Z",
            LogEvent::new("worker started", "info").with_logger("job-runner"),
        )
        .unwrap();
    client
        .span(
            "evt_span_001",
            "2026-06-02T10:00:04Z",
            SpanEvent::new("GET /health", "trace_001", "span_001", "ok").with_duration_ms(12.5),
        )
        .unwrap();
    client
        .action(
            "evt_action_001",
            "2026-06-02T10:00:05Z",
            ActionEvent::new("deploy", "success"),
        )
        .unwrap();
}

#[cfg(feature = "http")]
#[derive(Debug)]
struct RecordedHttpRequest {
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[cfg(feature = "http")]
impl RecordedHttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header_name, _)| header_name == name)
            .map(|(_, value)| value.as_str())
    }
}

#[cfg(feature = "http")]
struct LocalHttpIntake {
    endpoint: String,
    handle: thread::JoinHandle<Vec<RecordedHttpRequest>>,
}

#[cfg(feature = "http")]
impl LocalHttpIntake {
    fn start(statuses: Vec<u16>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local intake should bind");
        let endpoint = format!(
            "http://{}/v1/events",
            listener.local_addr().expect("local intake address")
        );
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for status in statuses {
                let (mut stream, _) = listener.accept().expect("local intake should accept");
                let mut bytes = Vec::new();
                let mut chunk = [0; 1024];
                while header_end_index(&bytes).is_none() {
                    let read = stream.read(&mut chunk).expect("local intake should read");
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }

                let header_end = header_end_index(&bytes).expect("request headers should finish");
                let head = String::from_utf8_lossy(&bytes[..header_end]);
                let mut lines = head.split("\r\n");
                let path = lines
                    .next()
                    .and_then(|request_line| request_line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                let mut headers = Vec::new();
                let mut content_length = 0usize;
                for line in lines {
                    if line.is_empty() {
                        continue;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        let name = name.trim().to_ascii_lowercase();
                        let value = value.trim().to_string();
                        if name == "content-length" {
                            content_length =
                                value.parse().expect("content-length should be numeric");
                        }
                        headers.push((name, value));
                    }
                }

                let mut body = bytes[header_end..].to_vec();
                while body.len() < content_length {
                    let read = stream.read(&mut chunk).expect("local intake body read");
                    if read == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..read]);
                }
                body.truncate(content_length);
                requests.push(RecordedHttpRequest {
                    path,
                    headers,
                    body,
                });

                let response = format!(
                    "HTTP/1.1 {} {}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    status,
                    status_reason(status)
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("local intake should respond");
            }
            requests
        });
        Self { endpoint, handle }
    }

    fn requests(self) -> Vec<RecordedHttpRequest> {
        self.handle.join().expect("local intake should finish")
    }
}

#[cfg(feature = "http")]
fn header_end_index(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

#[cfg(feature = "http")]
fn status_reason(status: u16) -> &'static str {
    match status {
        202 => "Accepted",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

#[test]
fn preview_json_contains_all_supported_event_types() {
    let mut client = sample_client();
    enqueue_all(&mut client);

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    let event_types: Vec<_> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect();

    assert_eq!(
        event_types,
        vec!["release", "environment", "issue", "log", "span", "action"]
    );
}

#[test]
fn flush_success_clears_queue() {
    let mut client = sample_client();
    enqueue_all(&mut client);

    let mut transport = RecordingTransport::always_accept();
    let response = client.flush(&mut transport).unwrap();

    assert_eq!(response.status_code, 202);
    assert_eq!(response.attempts, 1);
    assert_eq!(client.pending_events(), 0);
    assert!(
        String::from_utf8(transport.last_body().unwrap().to_vec())
            .unwrap()
            .contains("\"events\"")
    );
}

#[test]
fn invalid_timestamp_fails_validation() {
    let mut client = sample_client();
    let error = client
        .log(
            "evt_log_001",
            "2026-06-02T10:00:03",
            LogEvent::new("worker started", "info"),
        )
        .unwrap_err();

    assert_eq!(
        error,
        SdkError {
            code: "validation_error",
            message: "timestamp must include a timezone offset: 2026-06-02T10:00:03".to_string()
        }
    );
}

#[test]
fn invalid_issue_level_fails_validation() {
    let mut client = sample_client();
    let error = client
        .issue(
            "evt_issue_001",
            "2026-06-02T10:00:02Z",
            IssueEvent::new("Checkout timeout", "verbose"),
        )
        .unwrap_err();

    assert_eq!(error.code, "validation_error");
    assert_eq!(
        error.message,
        "issue level must be one of: trace, debug, info, warn, warning, error, fatal, critical"
    );
}

#[test]
fn invalid_log_level_fails_validation() {
    let mut client = sample_client();
    let error = client
        .log(
            "evt_log_001",
            "2026-06-02T10:00:03Z",
            LogEvent::new("worker started", "verbose"),
        )
        .unwrap_err();

    assert_eq!(error.code, "validation_error");
    assert_eq!(
        error.message,
        "log level must be one of: trace, debug, info, warn, warning, error, fatal, critical"
    );
}

#[test]
fn severity_aliases_normalize_before_preview() {
    let mut client = sample_client();
    client
        .issue(
            "evt_issue_alias",
            "2026-06-02T10:00:02Z",
            IssueEvent::new("Checkout timeout", "fatal"),
        )
        .unwrap();
    client
        .log(
            "evt_log_debug",
            "2026-06-02T10:00:03Z",
            LogEvent::new("verbose runtime detail", "debug"),
        )
        .unwrap();
    client
        .log(
            "evt_log_warn",
            "2026-06-02T10:00:04Z",
            LogEvent::new("legacy warning alias", "warn"),
        )
        .unwrap();

    let payload = client.preview_json().unwrap();
    assert!(payload.contains("\"level\": \"critical\""));
    assert!(payload.contains("\"level\": \"info\""));
    assert!(payload.contains("\"level\": \"warning\""));
}

#[test]
fn negative_span_duration_fails_validation() {
    let mut client = sample_client();
    let error = client
        .span(
            "evt_span_001",
            "2026-06-02T10:00:04Z",
            SpanEvent::new("GET /health", "trace_001", "span_001", "ok").with_duration_ms(-1.0),
        )
        .unwrap_err();

    assert_eq!(error.code, "validation_error");
    assert_eq!(error.message, "span duration_ms must be non-negative");
}

#[test]
fn invalid_action_status_fails_validation() {
    let mut client = sample_client();
    let error = client
        .action(
            "evt_action_001",
            "2026-06-02T10:00:05Z",
            ActionEvent::new("deploy", "done"),
        )
        .unwrap_err();

    assert_eq!(error.code, "validation_error");
    assert_eq!(
        error.message,
        "action status must be one of: queued, running, success, failure"
    );
}

#[test]
fn metric_event_preview_and_validation() {
    let mut client = sample_client();
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "routeTemplate".to_string(),
        Value::String("/checkout".to_string()),
    );
    metadata.insert("tier".to_string(), Value::String("api".to_string()));

    client
        .metric(
            "evt_metric_001",
            "2026-06-02T10:00:06Z",
            MetricEvent::new(
                "checkout.request.duration",
                "histogram",
                42.5,
                "ms",
                "delta",
            )
            .with_metadata(metadata),
        )
        .unwrap();

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let event = &payload["events"][0];
    assert_eq!(event["type"], "metric");
    assert_eq!(event["attributes"]["kind"], "histogram");
    assert_eq!(event["attributes"]["value"], 42.5);
    assert_eq!(event["attributes"]["temporality"], "delta");
    assert_eq!(
        event["attributes"]["metadata"]["routeTemplate"],
        "/checkout"
    );

    let error = sample_client()
        .metric(
            "evt_metric_invalid",
            "2026-06-02T10:00:06Z",
            MetricEvent::new("jobs.completed", "counter", -1.0, "1", "delta"),
        )
        .unwrap_err();
    assert_eq!(
        error.message,
        "counter and histogram metric values must be non-negative"
    );

    let error = sample_client()
        .metric(
            "evt_metric_invalid",
            "2026-06-02T10:00:06Z",
            MetricEvent::new("queue.depth", "gauge", 3.0, "1", "delta"),
        )
        .unwrap_err();
    assert_eq!(error.message, "metric temporality must be one of: instant");

    let error = sample_client()
        .metric(
            "evt_metric_invalid",
            "2026-06-02T10:00:06Z",
            MetricEvent::new("queue.depth", "gauge", f64::INFINITY, "1", "instant"),
        )
        .unwrap_err();
    assert_eq!(error.message, "metric value must be finite");

    let mut nested_metadata = serde_json::Map::new();
    nested_metadata.insert("user".to_string(), serde_json::json!({"id": "u_123"}));
    let error = sample_client()
        .metric(
            "evt_metric_invalid",
            "2026-06-02T10:00:06Z",
            MetricEvent::new("queue.depth", "gauge", 3.0, "1", "instant")
                .with_metadata(nested_metadata),
        )
        .unwrap_err();
    assert_eq!(error.message, "metric metadata values must be primitive");
}

#[test]
fn unauthenticated_response_surfaces_clean_error() {
    let mut client = sample_client();
    enqueue_all(&mut client);

    let mut transport = RecordingTransport::scripted(vec![Ok(401)]);
    let error = client.flush(&mut transport).unwrap_err();

    assert_eq!(error.code, "unauthenticated");
    assert_eq!(client.pending_events(), 6);
}

#[test]
fn network_failure_retries_before_succeeding() {
    let mut client = sample_client();
    enqueue_all(&mut client);

    let mut transport = RecordingTransport::scripted(vec![
        Err(TransportError::network("temporary outage")),
        Ok(202),
    ]);
    let response = client.flush(&mut transport).unwrap();

    assert_eq!(response.attempts, 2);
    assert_eq!(transport.sent_bodies().len(), 2);
}

#[test]
fn network_failure_returns_error_after_retry_budget() {
    let mut client = sample_client();
    enqueue_all(&mut client);

    let mut transport = RecordingTransport::scripted(vec![
        Err(TransportError::network("temporary outage")),
        Err(TransportError::network("temporary outage")),
        Err(TransportError::network("temporary outage")),
    ]);
    let error = client.flush(&mut transport).unwrap_err();

    assert_eq!(error.code, "network_failure");
    assert_eq!(client.pending_events(), 6);
}

#[test]
fn shutdown_flushes_and_prevents_future_events() {
    let mut client = sample_client();
    enqueue_all(&mut client);
    let mut transport = RecordingTransport::always_accept();

    let response = client.shutdown(&mut transport).unwrap();
    assert_eq!(response.status_code, 202);

    let error = client
        .action(
            "evt_action_002",
            "2026-06-02T10:00:06Z",
            ActionEvent::new("deploy", "success"),
        )
        .unwrap_err();
    assert_eq!(error.code, "shutdown_error");
}

#[cfg(feature = "http")]
#[test]
fn http_transport_sends_batch_with_expected_headers() {
    let intake = LocalHttpIntake::start(vec![202]);
    let mut transport = HttpTransport::new(HttpTransportConfig {
        endpoint: intake.endpoint.clone(),
        headers: vec![("x-logbrew-test".to_string(), "rust".to_string())],
        timeout: Some(Duration::from_secs(2)),
        agent: None,
    })
    .unwrap();

    let response = transport
        .send("LOGBREW_API_KEY", br#"{"events":[]}"#)
        .unwrap();
    assert_eq!(response.status_code, 202);
    assert_eq!(response.attempts, 1);
    assert_eq!(transport.endpoint(), intake.endpoint);
    assert_eq!(
        transport.headers(),
        &[("x-logbrew-test".to_string(), "rust".to_string())]
    );

    let requests = intake.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/v1/events");
    assert_eq!(
        requests[0].header("authorization"),
        Some("Bearer LOGBREW_API_KEY")
    );
    assert_eq!(requests[0].header("content-type"), Some("application/json"));
    assert_eq!(requests[0].header("x-logbrew-test"), Some("rust"));
    assert_eq!(requests[0].body, br#"{"events":[]}"#);
}

#[cfg(feature = "http")]
#[test]
fn http_transport_returns_statuses_to_client_retry_logic() {
    let intake = LocalHttpIntake::start(vec![503, 202]);
    let mut transport = HttpTransport::new(HttpTransportConfig {
        endpoint: intake.endpoint.clone(),
        timeout: Some(Duration::from_secs(2)),
        ..Default::default()
    })
    .unwrap();
    let mut client = sample_client();
    client
        .release(
            "evt_release_http_retry",
            "2026-06-02T10:00:00Z",
            ReleaseEvent::new("1.2.3"),
        )
        .unwrap();

    let response = client.flush(&mut transport).unwrap();
    assert_eq!(response.status_code, 202);
    assert_eq!(response.attempts, 2);
    assert_eq!(client.pending_events(), 0);

    let requests = intake.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].body, requests[1].body);
}

#[cfg(feature = "http")]
#[test]
fn http_transport_maps_network_failures_to_retryable_transport_error() {
    let mut transport = HttpTransport::new(HttpTransportConfig {
        endpoint: "http://127.0.0.1:1/v1/events".to_string(),
        timeout: Some(Duration::from_millis(200)),
        ..Default::default()
    })
    .unwrap();

    let error = transport.send("LOGBREW_API_KEY", b"{}").unwrap_err();
    assert_eq!(error.code, "network_failure");
    assert!(error.retryable);
    assert!(error.message.starts_with("http transport failed:"));
}

#[cfg(feature = "http")]
#[test]
fn http_transport_rejects_invalid_config() {
    let error = HttpTransport::new(HttpTransportConfig {
        endpoint: "/v1/events".to_string(),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(error.code, "config_error");
    assert_eq!(
        error.message,
        "endpoint must start with http:// or https://"
    );

    let error = HttpTransport::new(HttpTransportConfig {
        endpoint: "http://127.0.0.1/v1/events".to_string(),
        headers: vec![("".to_string(), "rust".to_string())],
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(error.code, "config_error");
    assert_eq!(error.message, "header name must be non-empty");

    let error = HttpTransport::new(HttpTransportConfig {
        endpoint: "http://127.0.0.1/v1/events".to_string(),
        timeout: Some(Duration::ZERO),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(error.code, "config_error");
    assert_eq!(error.message, "timeout must be positive");
}
