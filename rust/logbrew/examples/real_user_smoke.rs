use logbrew::{
    ActionEvent, DependencyOperationSpan, EnvironmentEvent, HttpClientSpan, IssueEvent,
    LogBrewClient, LogEvent, Metadata, MetadataValue, MetricEvent, RecordingTransport,
    ReleaseEvent, SpanEvent, Traceparent,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3")
            .with_commit("abc123def456")
            .with_notes("Public release marker"),
    )?;
    client.environment(
        "evt_environment_001",
        "2026-06-02T10:00:01Z",
        EnvironmentEvent::new("production").with_region("global"),
    )?;
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        IssueEvent::new("Checkout timeout", "error")
            .with_message("Request timed out after retry budget"),
    )?;
    client.log(
        "evt_log_001",
        "2026-06-02T10:00:03Z",
        LogEvent::new("worker started", "info").with_logger("job-runner"),
    )?;
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        SpanEvent::new("GET /health", "trace_001", "span_001", "ok").with_duration_ms(12.5),
    )?;
    client.action(
        "evt_action_001",
        "2026-06-02T10:00:05Z",
        ActionEvent::new("deploy", "success"),
    )?;

    let preview = client.preview_json()?;
    println!("{preview}");

    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":6}}",
        response.status_code, response.attempts
    );
    exercise_metric_helper()?;
    exercise_http_client_span_helper()?;
    exercise_dependency_operation_span_helper()?;

    Ok(())
}

fn exercise_metric_helper() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    client.metric(
        "evt_metric_001",
        "2026-06-02T10:00:06Z",
        MetricEvent::new(
            "checkout.request.duration",
            "histogram",
            42.5,
            "ms",
            "delta",
        ),
    )?;
    let preview = client.preview_json()?;
    assert!(preview.contains("\"type\": \"metric\""));
    assert!(preview.contains("\"checkout.request.duration\""));
    assert!(
        client
            .metric(
                "evt_metric_invalid",
                "2026-06-02T10:00:06Z",
                MetricEvent::new("jobs.completed", "counter", -1.0, "1", "delta"),
            )
            .is_err()
    );
    Ok(())
}

fn exercise_http_client_span_helper() -> Result<(), Box<dyn std::error::Error>> {
    let context = Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?;
    let mut metadata = Metadata::new();
    metadata.insert("retryAttempt".to_string(), MetadataValue::from(1));
    metadata.insert(
        "authorizationHeader".to_string(),
        MetadataValue::String("Bearer not-for-telemetry".to_string()),
    );

    let outbound = HttpClientSpan::new(
        "https://payments.example.invalid/api/payments/:payment_id?card=sample#debug",
        "POST",
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

    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    client.span("evt_http_client_001", "2026-06-02T10:00:19Z", outbound.span)?;
    let preview = client.preview_json()?;
    assert!(preview.contains("\"http.client:POST /api/payments/:payment_id\""));
    assert!(preview.contains("\"source\": \"rust_http_client\""));
    assert!(preview.contains("\"statusCode\": 503"));
    assert!(preview.contains("\"retryAttempt\": 1"));
    assert!(!preview.contains("card=sample"));
    assert!(!preview.contains("authorizationHeader"));
    Ok(())
}

fn exercise_dependency_operation_span_helper() -> Result<(), Box<dyn std::error::Error>> {
    let context = Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?;
    let mut metadata = Metadata::new();
    metadata.insert(
        "pool".to_string(),
        MetadataValue::String("primary".to_string()),
    );
    metadata.insert(
        "sql.statement".to_string(),
        MetadataValue::String("select * from users".to_string()),
    );

    let span = DependencyOperationSpan::database("checkout lookup", "abcdef1234567890")
        .with_system("postgres")
        .with_operation("select")
        .with_target("orders")
        .with_duration_ms(8.25)
        .with_metadata(metadata)
        .from_traceparent_context(&context)?;

    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    client.span("evt_dependency_001", "2026-06-02T10:00:20Z", span)?;
    let preview = client.preview_json()?;
    assert!(preview.contains("\"database.operation:checkout lookup\""));
    assert!(preview.contains("\"db.system\": \"postgres\""));
    assert!(!preview.contains("sql.statement"));
    Ok(())
}
