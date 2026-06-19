#[cfg(feature = "hyper")]
use logbrew::HttpRequestCaptureError;
use logbrew::{HttpClientSpan, LogBrewClient, Metadata, MetadataValue, Traceparent};
use serde_json::Value;
#[cfg(feature = "hyper")]
use std::convert::Infallible;
#[cfg(any(feature = "http", feature = "reqwest"))]
use std::time::Duration;
#[cfg(any(feature = "http", feature = "reqwest"))]
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

#[test]
fn http_client_span_builds_sanitized_outbound_span_and_traceparent() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    let mut metadata = Metadata::new();
    metadata.insert("retryAttempt".to_string(), MetadataValue::Number(1.into()));
    metadata.insert(
        "authorizationHeader".to_string(),
        MetadataValue::String("Bearer not-for-telemetry".to_string()),
    );
    metadata.insert(
        "requestBody".to_string(),
        MetadataValue::String("card=sample".to_string()),
    );

    let events = HttpClientSpan::new(
        "https://payments.example.invalid/api/payments/:payment_id?card=sample#debug",
        "post",
        "b7ad6b7169203331",
    )
    .with_status_code(503)
    .with_duration_ms(183.4)
    .with_metadata(metadata)
    .from_traceparent_context(&context)
    .unwrap();

    assert_eq!(events.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(events.span_id, "b7ad6b7169203331");
    assert_eq!(events.parent_span_id.as_deref(), Some("00f067aa0ba902b7"));
    assert_eq!(
        events.outgoing_traceparent,
        "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"
    );

    let mut client = LogBrewClient::builder("rust-http-client-test", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .unwrap();
    client
        .span("evt_http_client_span", "2026-06-02T10:00:06Z", events.span)
        .unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let span = &payload["events"][0]["attributes"];

    assert_eq!(span["name"], "http.client:POST /api/payments/:payment_id");
    assert_eq!(span["status"], "error");
    assert_eq!(span["durationMs"], 183.4);
    assert_eq!(span["metadata"]["source"], "rust_http_client");
    assert_eq!(
        span["metadata"]["routeTemplate"],
        "/api/payments/:payment_id"
    );
    assert_eq!(span["metadata"]["method"], "POST");
    assert_eq!(span["metadata"]["statusCode"], 503);
    assert_eq!(span["metadata"]["statusCodeClass"], "5xx");
    assert_eq!(span["metadata"]["retryAttempt"], 1);

    let preview = client.preview_json().unwrap();
    assert!(!preview.contains("card=sample"));
    assert!(!preview.contains("#debug"));
    assert!(!preview.contains("authorizationHeader"));
    assert!(!preview.contains("requestBody"));
}

#[test]
fn http_client_span_rejects_invalid_status_method_and_duration() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00").unwrap();

    let method_error = HttpClientSpan::new("/checkout", "bad method", "b7ad6b7169203331")
        .from_traceparent_context(&context)
        .unwrap_err();
    assert_eq!(
        method_error.message,
        "http client method must be a valid HTTP method"
    );

    let status_error = HttpClientSpan::new("/checkout", "GET", "b7ad6b7169203331")
        .with_status_code(700)
        .from_traceparent_context(&context)
        .unwrap_err();
    assert_eq!(
        status_error.message,
        "http client status_code must be between 100 and 599"
    );

    let duration_error = HttpClientSpan::new("/checkout", "GET", "b7ad6b7169203331")
        .with_duration_ms(-1.0)
        .from_traceparent_context(&context)
        .unwrap_err();
    assert_eq!(
        duration_error.message,
        "http client duration_ms must be non-negative"
    );
}

#[cfg(feature = "http")]
#[test]
fn http_client_span_captures_ureq_call_result_and_preserves_error() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(2)))
            .build(),
    );
    let mut client = LogBrewClient::builder("rust-ureq-test", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .unwrap();

    let ok_intake = UreqIntake::start(202);
    let ok_response = HttpClientSpan::new(
        format!(
            "{}/api/payments/:payment_id?card=sample#debug",
            ok_intake.endpoint
        ),
        "get",
        "b7ad6b7169203331",
    )
    .capture_ureq_call(
        &mut client,
        "evt_ureq_success",
        "2026-06-02T10:00:07Z",
        &context,
        |traceparent| {
            agent
                .get(&format!(
                    "{}/api/payments/123?card=sample#debug",
                    ok_intake.endpoint
                ))
                .header("traceparent", traceparent)
                .call()
        },
    )
    .unwrap();
    assert_eq!(ok_response.status().as_u16(), 202);
    let ok_requests = ok_intake.requests();
    assert_eq!(ok_requests.len(), 1);
    assert_eq!(
        ok_requests[0].header("traceparent"),
        Some("00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01")
    );

    let failing_intake = UreqIntake::start(503);
    let error = HttpClientSpan::new(
        format!("{}/api/payments/:payment_id", failing_intake.endpoint),
        "get",
        "1111111111111111",
    )
    .capture_ureq_call(
        &mut client,
        "evt_ureq_failure",
        "2026-06-02T10:00:08Z",
        &context,
        |traceparent| {
            agent
                .get(&format!("{}/api/payments/456", failing_intake.endpoint))
                .header("traceparent", traceparent)
                .call()
        },
    )
    .unwrap_err();
    assert!(matches!(error, ureq::Error::StatusCode(503)));

    let preview = client.preview_json().unwrap();
    assert!(preview.contains("\"id\": \"evt_ureq_success\""));
    assert!(preview.contains("\"name\": \"http.client:GET /api/payments/:payment_id\""));
    assert!(preview.contains("\"statusCode\": 202"));
    assert!(preview.contains("\"statusCodeClass\": \"2xx\""));
    assert!(preview.contains("\"id\": \"evt_ureq_failure\""));
    assert!(preview.contains("\"statusCode\": 503"));
    assert!(preview.contains("\"statusCodeClass\": \"5xx\""));
    assert!(preview.contains("\"status\": \"error\""));
    assert!(!preview.contains("card=sample"));
    assert!(!preview.contains("#debug"));
}

#[cfg(feature = "reqwest")]
#[tokio::test]
async fn http_client_span_captures_reqwest_send_result_and_preserves_error() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let mut client = LogBrewClient::builder("rust-reqwest-test", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .unwrap();

    let ok_intake = UreqIntake::start(204);
    let ok_response = HttpClientSpan::new(
        format!(
            "{}/api/orders/:order_id?coupon=sample#debug",
            ok_intake.endpoint
        ),
        "post",
        "2222222222222222",
    )
    .capture_reqwest_send(
        &mut client,
        "evt_reqwest_success",
        "2026-06-02T10:00:09Z",
        &context,
        http.post(format!(
            "{}/api/orders/123?coupon=sample#debug",
            ok_intake.endpoint
        )),
    )
    .await
    .unwrap();
    assert_eq!(ok_response.status().as_u16(), 204);
    let ok_requests = ok_intake.requests();
    assert_eq!(ok_requests.len(), 1);
    assert_eq!(
        ok_requests[0].header("traceparent"),
        Some("00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-01")
    );

    let failing_intake = UreqIntake::start(502);
    let error = HttpClientSpan::new(
        format!("{}/api/orders/:order_id", failing_intake.endpoint),
        "post",
        "3333333333333333",
    )
    .capture_reqwest_send(
        &mut client,
        "evt_reqwest_failure",
        "2026-06-02T10:00:10Z",
        &context,
        http.post(format!("{}/api/orders/456", failing_intake.endpoint)),
    )
    .await
    .unwrap()
    .error_for_status()
    .unwrap_err();
    assert_eq!(error.status().map(|status| status.as_u16()), Some(502));

    let preview = client.preview_json().unwrap();
    assert!(preview.contains("\"id\": \"evt_reqwest_success\""));
    assert!(preview.contains("\"name\": \"http.client:POST /api/orders/:order_id\""));
    assert!(preview.contains("\"statusCode\": 204"));
    assert!(preview.contains("\"statusCodeClass\": \"2xx\""));
    assert!(preview.contains("\"id\": \"evt_reqwest_failure\""));
    assert!(preview.contains("\"statusCode\": 502"));
    assert!(preview.contains("\"statusCodeClass\": \"5xx\""));
    assert!(preview.contains("\"status\": \"error\""));
    assert!(!preview.contains("coupon=sample"));
    assert!(!preview.contains("#debug"));
}

#[cfg(feature = "hyper")]
#[tokio::test]
async fn http_client_span_captures_http_request_result_for_hyper_compatible_clients() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    let mut client = LogBrewClient::builder("rust-hyper-test", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .unwrap();
    let request = http_types::Request::builder()
        .method("post")
        .uri("https://payments.example.invalid/api/payments/123?coupon=sample#debug")
        .header("x-caller-owned", "kept")
        .body("safe app-owned body")
        .unwrap();

    let response = HttpClientSpan::new(
        "https://payments.example.invalid/api/payments/:payment_id?coupon=sample#debug",
        "post",
        "4444444444444444",
    )
    .capture_http_request_send(
        &mut client,
        "evt_hyper_success",
        "2026-06-02T10:00:12Z",
        &context,
        request,
        |request| async move {
            assert_eq!(
                request
                    .headers()
                    .get("traceparent")
                    .and_then(|value| value.to_str().ok()),
                Some("00-4bf92f3577b34da6a3ce929d0e0e4736-4444444444444444-01")
            );
            assert_eq!(
                request
                    .headers()
                    .get("x-caller-owned")
                    .and_then(|value| value.to_str().ok()),
                Some("kept")
            );
            Ok::<_, Infallible>(
                http_types::Response::builder()
                    .status(202)
                    .body("accepted")
                    .unwrap(),
            )
        },
    )
    .await
    .unwrap();
    assert_eq!(response.status().as_u16(), 202);

    let failing_request = http_types::Request::builder()
        .method("get")
        .uri("https://payments.example.invalid/api/payments/456?coupon=sample#debug")
        .body("")
        .unwrap();
    let error = HttpClientSpan::new(
        "https://payments.example.invalid/api/payments/:payment_id",
        "get",
        "5555555555555555",
    )
    .capture_http_request_send(
        &mut client,
        "evt_hyper_failure",
        "2026-06-02T10:00:13Z",
        &context,
        failing_request,
        |_request| async move { Err::<http_types::Response<&'static str>, _>("hyper failure") },
    )
    .await
    .unwrap_err();
    assert_eq!(error, HttpRequestCaptureError::Request("hyper failure"));

    let preview = client.preview_json().unwrap();
    assert!(preview.contains("\"id\": \"evt_hyper_success\""));
    assert!(preview.contains("\"name\": \"http.client:POST /api/payments/:payment_id\""));
    assert!(preview.contains("\"statusCode\": 202"));
    assert!(preview.contains("\"statusCodeClass\": \"2xx\""));
    assert!(preview.contains("\"id\": \"evt_hyper_failure\""));
    assert!(preview.contains("\"name\": \"http.client:GET /api/payments/:payment_id\""));
    assert!(preview.contains("\"status\": \"error\""));
    assert!(preview.contains("str"));
    assert!(!preview.contains("coupon=sample"));
    assert!(!preview.contains("#debug"));
    assert!(!preview.contains("x-caller-owned"));
    assert!(!preview.contains("safe app-owned body"));
}

#[cfg(any(feature = "http", feature = "reqwest"))]
#[derive(Clone, Debug)]
struct UreqRecordedRequest {
    headers: BTreeMap<String, String>,
}

#[cfg(any(feature = "http", feature = "reqwest"))]
impl UreqRecordedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

#[cfg(any(feature = "http", feature = "reqwest"))]
struct UreqIntake {
    endpoint: String,
    requests: Arc<Mutex<Vec<UreqRecordedRequest>>>,
}

#[cfg(any(feature = "http", feature = "reqwest"))]
impl UreqIntake {
    fn start(status_code: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let request = read_request(&mut stream);
                captured.lock().unwrap().push(request);
                let response = format!(
                    "HTTP/1.1 {status_code} OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        Self { endpoint, requests }
    }

    fn requests(&self) -> Vec<UreqRecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[cfg(any(feature = "http", feature = "reqwest"))]
fn read_request(stream: &mut TcpStream) -> UreqRecordedRequest {
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
    UreqRecordedRequest { headers }
}
