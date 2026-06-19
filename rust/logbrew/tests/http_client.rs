use logbrew::{HttpClientSpan, LogBrewClient, Metadata, MetadataValue, Traceparent};
use serde_json::Value;

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
