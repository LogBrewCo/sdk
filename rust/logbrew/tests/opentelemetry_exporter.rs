//! Integration tests for the OpenTelemetry exporter.
#![cfg(test)]
#![cfg(feature = "opentelemetry-exporter")]

extern crate alloc;
use alloc::sync::Arc;
use logbrew::{
    LogBrewClient, LogBrewOpenTelemetrySpanExporter, LogBrewOpenTelemetrySpanExporterConfig,
};
use opentelemetry::{
    KeyValue,
    trace::{Span as _, SpanKind, Status, Tracer as _, TracerProvider as _},
};
use opentelemetry_sdk::{
    Resource,
    trace::{SdkTracerProvider, SimpleSpanProcessor},
};
use serde_json::Value;
use std::sync::Mutex;

fn sample_client() -> Arc<Mutex<LogBrewClient>> {
    Arc::new(Mutex::new(
        LogBrewClient::builder("rust-otel-exporter-test", "0.1.0")
            .api_key("LOGBREW_API_KEY")
            .build()
            .expect("client should build"),
    ))
}

fn export_checkout_root_span() -> Value {
    let client = sample_client();
    let exporter = LogBrewOpenTelemetrySpanExporter::new(
        Arc::clone(&client),
        LogBrewOpenTelemetrySpanExporterConfig::new("2026-06-02T10:00:30Z")
            .with_event_id_prefix("evt_rust_otel")
            .with_service_name("checkout-api")
            .with_service_version("1.2.3")
            .with_deployment_environment("production")
            .with_allowed_attribute_keys([
                "http.request.method",
                "http.route",
                "http.response.status_code",
                "db.system",
                "messaging.system",
                "exception.type",
                "unsafe.debug",
            ]),
    );
    let provider = SdkTracerProvider::builder()
        .with_resource(
            Resource::builder_empty()
                .with_service_name("resource-service")
                .build(),
        )
        .with_span_processor(SimpleSpanProcessor::new(exporter))
        .build();
    let tracer = provider.tracer("checkout-instrumentation");

    let mut root = tracer
        .span_builder("GET /checkout/{cart_id}")
        .with_kind(SpanKind::Server)
        .with_attributes([
            KeyValue::new("http.request.method", "GET"),
            KeyValue::new("http.route", "/checkout/{cart_id}?coupon=sample"),
            KeyValue::new("http.response.status_code", 202_i64),
            KeyValue::new("http.target", "/checkout/123?coupon=sample"),
            KeyValue::new("authorization", "Bearer not-for-telemetry"),
            KeyValue::new("unsafe.debug", "not-for-telemetry"),
        ])
        .start(&tracer);
    root.end();

    provider.force_flush().expect("force flush should succeed");
    provider.shutdown().expect("shutdown should succeed");

    serde_json::from_str(&client.lock().unwrap().preview_json().unwrap()).unwrap()
}

#[test]
fn opentelemetry_exporter_queues_privacy_bounded_spans_from_standard_processor() {
    let payload = export_checkout_root_span();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_fields(
        &payload["events"],
        &[
            ("/0/type", Value::from("span")),
            ("/0/id", Value::from("evt_rust_otel_1")),
            ("/0/timestamp", Value::from("2026-06-02T10:00:30Z")),
        ],
    );

    let span = &events[0]["attributes"];
    assert_fields(
        span,
        &[
            ("/name", Value::from("GET /checkout/{cart_id}")),
            ("/status", Value::from("ok")),
        ],
    );
    assert_eq!(span["traceId"].as_str().unwrap().len(), 32);
    assert_eq!(span["spanId"].as_str().unwrap().len(), 16);
    assert!(span["durationMs"].as_f64().unwrap() >= 0.0_f64);
    assert_eq!(span["context"]["trace"]["traceId"], span["traceId"]);
    assert_eq!(span["context"]["trace"]["spanId"], span["spanId"]);
    assert_fields(
        span,
        &[
            ("/context/trace/sampled", Value::Bool(true)),
            (
                "/context/resource/service/name",
                Value::from("checkout-api"),
            ),
            ("/context/resource/service/version", Value::from("1.2.3")),
            (
                "/context/resource/deployment/environment",
                Value::from("production"),
            ),
        ],
    );

    let metadata = &span["metadata"];
    assert_fields(
        metadata,
        &[
            ("/source", Value::from("opentelemetry.span_exporter")),
            ("/service.name", Value::from("checkout-api")),
            ("/service.version", Value::from("1.2.3")),
            ("/deployment.environment", Value::from("production")),
            ("/otel.span.kind", Value::from("server")),
            (
                "/otel.instrumentation.scope.name",
                Value::from("checkout-instrumentation"),
            ),
            ("/http.request.method", Value::from("GET")),
            ("/http.route", Value::from("/checkout/{cart_id}")),
            ("/http.response.status_code", Value::from(202_i32)),
        ],
    );
    assert!(metadata.get("http.target").is_none());
    assert!(metadata.get("authorization").is_none());
    assert!(metadata.get("unsafe.debug").is_none());

    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("coupon=sample"));
    assert!(!text.contains("bearer"));
    assert!(!text.contains("not-for-telemetry"));
    assert!(!text.contains("baggage"));
    assert!(!text.contains("tracestate"));
}

#[test]
fn opentelemetry_exporter_records_error_status_exception_type_and_drops_error_messages() {
    let client = sample_client();
    let exporter = LogBrewOpenTelemetrySpanExporter::new(
        Arc::clone(&client),
        LogBrewOpenTelemetrySpanExporterConfig::new("2026-06-02T10:00:31Z")
            .with_allowed_attribute_keys(["db.system", "exception.type"]),
    );
    let provider = SdkTracerProvider::builder()
        .with_span_processor(SimpleSpanProcessor::new(exporter))
        .build();
    let tracer = provider.tracer("db-instrumentation");

    let mut span = tracer
        .span_builder("SELECT checkout")
        .with_kind(SpanKind::Client)
        .with_attributes([
            KeyValue::new("db.system", "postgresql"),
            KeyValue::new(
                "db.statement",
                "select * from users where email='sample@example.com'",
            ),
            KeyValue::new("exception.type", "DbTimeout"),
        ])
        .start(&tracer);
    span.set_status(Status::error("timeout talking to database"));
    span.end();

    provider.force_flush().expect("force flush should succeed");

    let payload: Value =
        serde_json::from_str(&client.lock().unwrap().preview_json().unwrap()).unwrap();
    let queued_span = &payload["events"][0]["attributes"];
    assert_eq!(queued_span["name"], "SELECT checkout");
    assert_eq!(queued_span["status"], "error");
    let metadata = &queued_span["metadata"];
    assert_eq!(metadata["otel.span.kind"], "client");
    assert_eq!(metadata["db.system"], "postgresql");
    assert_eq!(metadata["exception.type"], "DbTimeout");
    assert!(metadata.get("otel.status.description").is_none());
    assert!(metadata.get("db.statement").is_none());

    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("sample@example.com"));
    assert!(!text.contains("timeout talking to database"));
}

fn assert_fields(object: &Value, expected: &[(&str, Value)]) {
    for field in expected {
        assert_eq!(object.pointer(field.0), Some(&field.1), "field {}", field.0);
    }
}
