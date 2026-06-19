use logbrew::{
    DependencyOperationSpan, LogBrewClient, MetadataValue, OpenTelemetrySpanContext, Traceparent,
};
use serde_json::Value;

fn sample_client() -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .expect("client should build")
}

#[test]
fn dependency_operation_span_uses_parent_context_and_sanitizes_metadata() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "pool".to_string(),
        MetadataValue::String("primary".to_string()),
    );
    metadata.insert("row_count".to_string(), MetadataValue::from(3));
    metadata.insert(
        "sql.statement".to_string(),
        MetadataValue::String("select * from users".to_string()),
    );
    metadata.insert(
        "pass.word".to_string(),
        MetadataValue::String("not-for-telemetry".to_string()),
    );
    metadata.insert(
        "connection-string".to_string(),
        MetadataValue::String("postgres://example".to_string()),
    );
    metadata.insert("nested".to_string(), serde_json::json!({"drop": true}));

    let mut client = sample_client();
    client
        .span(
            "evt_dependency_001",
            "2026-06-02T10:00:20Z",
            DependencyOperationSpan::database("checkout lookup", "abcdef1234567890")
                .with_system("postgres")
                .with_operation("select")
                .with_target("orders")
                .with_duration_ms(8.25)
                .with_metadata(metadata)
                .from_traceparent_context(&context)
                .unwrap(),
        )
        .unwrap();

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    assert_eq!(attributes["name"], "database.operation:checkout lookup");
    assert_eq!(attributes["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(attributes["spanId"], "abcdef1234567890");
    assert_eq!(attributes["parentSpanId"], "00f067aa0ba902b7");
    assert_eq!(attributes["durationMs"], 8.25);
    assert_eq!(attributes["metadata"]["source"], "database.operation");
    assert_eq!(attributes["metadata"]["db.system"], "postgres");
    assert_eq!(attributes["metadata"]["db.operation"], "select");
    assert_eq!(attributes["metadata"]["db.target"], "orders");
    assert_eq!(attributes["metadata"]["pool"], "primary");
    assert_eq!(attributes["metadata"]["row_count"], 3);
    assert!(attributes["metadata"].get("sql.statement").is_none());
    assert!(attributes["metadata"].get("pass.word").is_none());
    assert!(attributes["metadata"].get("connection-string").is_none());
    assert!(attributes["metadata"].get("nested").is_none());
}

#[test]
fn dependency_operation_span_accepts_opentelemetry_parent_and_error_type() {
    let context = OpenTelemetrySpanContext::from_sampled(
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "00f067aa0ba902b7",
        true,
    )
    .unwrap();

    let mut client = sample_client();
    client
        .span(
            "evt_dependency_error_001",
            "2026-06-02T10:00:21Z",
            DependencyOperationSpan::queue("invoice publish", "abcdef1234567890")
                .with_system("sqs")
                .with_operation("publish")
                .with_target("billing-events")
                .with_error_type("PublishError")
                .from_opentelemetry_context(&context)
                .unwrap(),
        )
        .unwrap();
    client
        .span(
            "evt_cache_dependency_001",
            "2026-06-02T10:00:22Z",
            DependencyOperationSpan::cache("session get", "cdef1234567890ab")
                .with_system("redis")
                .with_operation("get")
                .with_target("sessions")
                .from_opentelemetry_context(&context)
                .unwrap(),
        )
        .unwrap();

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    assert_eq!(attributes["name"], "queue.operation:invoice publish");
    assert_eq!(attributes["status"], "error");
    assert_eq!(attributes["metadata"]["source"], "queue.operation");
    assert_eq!(attributes["metadata"]["messaging.system"], "sqs");
    assert_eq!(attributes["metadata"]["messaging.operation"], "publish");
    assert_eq!(attributes["metadata"]["messaging.target"], "billing-events");
    assert_eq!(attributes["metadata"]["exception.type"], "PublishError");

    let cache_attributes = &payload["events"][1]["attributes"];
    assert_eq!(cache_attributes["name"], "cache.operation:session get");
    assert_eq!(cache_attributes["metadata"]["source"], "cache.operation");
    assert_eq!(cache_attributes["metadata"]["cache.system"], "redis");
    assert_eq!(cache_attributes["metadata"]["cache.operation"], "get");
    assert_eq!(cache_attributes["metadata"]["cache.target"], "sessions");
}
