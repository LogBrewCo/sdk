//! Integration tests for dependency operation spans.
#![cfg(test)]
use core::panic::AssertUnwindSafe;
use logbrew::{
    DependencyOperationSpan, LogBrewClient, MetadataValue, OpenTelemetrySpanContext, Traceparent,
};
use serde_json::Value;
use std::panic;

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
    drop(metadata.insert(
        "pool".to_owned(),
        MetadataValue::String("primary".to_owned()),
    ));
    drop(metadata.insert("row_count".to_owned(), MetadataValue::from(3_i32)));
    drop(metadata.insert(
        "sql.statement".to_owned(),
        MetadataValue::String("select * from users".to_owned()),
    ));
    drop(metadata.insert(
        "pass.word".to_owned(),
        MetadataValue::String("not-for-telemetry".to_owned()),
    ));
    drop(metadata.insert(
        "connection-string".to_owned(),
        MetadataValue::String("postgres://example".to_owned()),
    ));
    drop(metadata.insert("nested".to_owned(), serde_json::json!({"drop": true})));

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
    assert_fields(
        attributes,
        &[
            ("/name", Value::from("database.operation:checkout lookup")),
            ("/traceId", Value::from("4bf92f3577b34da6a3ce929d0e0e4736")),
            ("/spanId", Value::from("abcdef1234567890")),
            ("/parentSpanId", Value::from("00f067aa0ba902b7")),
            ("/durationMs", Value::from(8.25_f64)),
            ("/metadata/source", Value::from("database.operation")),
            ("/metadata/db.system", Value::from("postgres")),
            ("/metadata/db.operation", Value::from("select")),
            ("/metadata/db.target", Value::from("orders")),
            ("/metadata/pool", Value::from("primary")),
            ("/metadata/row_count", Value::from(3_i32)),
        ],
    );
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

#[test]
fn dependency_operation_capture_panic_records_success_span_and_returns_value() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    let mut client = sample_client();

    let order_count = DependencyOperationSpan::database("checkout lookup", "abcdef1234567890")
        .with_system("postgres")
        .with_operation("select")
        .with_target("orders")
        .capture_panic(
            &mut client,
            "evt_dependency_success_001",
            "2026-06-02T10:00:23Z",
            &context,
            || 3_i32,
        );

    assert_eq!(order_count, 3_i32);
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    assert_eq!(attributes["name"], "database.operation:checkout lookup");
    assert_eq!(attributes["status"], "ok");
    assert_eq!(attributes["metadata"]["source"], "database.operation");
    assert_eq!(attributes["metadata"]["db.system"], "postgres");
    assert!(attributes["metadata"].get("panic").is_none());
    assert!(attributes["metadata"].get("panicType").is_none());
}

#[test]
fn dependency_operation_capture_panic_records_failed_span_and_resumes_unwind() {
    let context =
        Traceparent::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    let mut metadata = serde_json::Map::new();
    drop(metadata.insert(
        "pool".to_owned(),
        MetadataValue::String("primary".to_owned()),
    ));
    drop(metadata.insert(
        "sql.statement".to_owned(),
        MetadataValue::String("select * from users".to_owned()),
    ));
    let mut client = sample_client();

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        DependencyOperationSpan::database("checkout lookup", "abcdef1234567890")
            .with_system("postgres")
            .with_operation("select")
            .with_target("orders")
            .with_metadata(metadata)
            .capture_panic(
                &mut client,
                "evt_dependency_panic_001",
                "2026-06-02T10:00:24Z",
                &context,
                || panic::panic_any(String::from("do not capture this panic message")),
            );
    }));

    assert!(result.is_err());
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    assert_eq!(attributes["name"], "database.operation:checkout lookup");
    assert_eq!(attributes["status"], "error");
    assert_eq!(attributes["metadata"]["source"], "database.operation");
    assert_eq!(attributes["metadata"]["db.system"], "postgres");
    assert_eq!(attributes["metadata"]["exception.type"], "panic");
    assert_eq!(attributes["metadata"]["panic"], true);
    assert_eq!(attributes["metadata"]["panicType"], "String");
    assert_eq!(attributes["metadata"]["pool"], "primary");

    let preview = client.preview_json().unwrap();
    assert!(!preview.contains("do not capture this panic message"));
    assert!(!preview.contains("sql.statement"));
    assert!(!preview.contains("select * from users"));
}

fn assert_fields(object: &Value, expected: &[(&str, Value)]) {
    for field in expected {
        assert_eq!(object.pointer(field.0), Some(&field.1), "field {}", field.0);
    }
}
