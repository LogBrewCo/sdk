#![cfg(feature = "opentelemetry-exporter")]

use logbrew::{
    LogBrewClient, LogBrewOpenTelemetrySpanExporter, LogBrewOpenTelemetrySpanExporterConfig,
};
use opentelemetry::{
    KeyValue,
    trace::{Span, SpanKind, Status, Tracer, TracerProvider},
};
use opentelemetry_sdk::{
    Resource,
    trace::{SdkTracerProvider, SimpleSpanProcessor},
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

fn sample_client() -> Arc<Mutex<LogBrewClient>> {
    Arc::new(Mutex::new(
        LogBrewClient::builder("rust-otel-exporter-test", "0.1.0")
            .api_key("LOGBREW_API_KEY")
            .build()
            .expect("client should build"),
    ))
}

#[test]
fn opentelemetry_exporter_queues_privacy_bounded_spans_from_standard_processor() {
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

    let payload: Value =
        serde_json::from_str(&client.lock().unwrap().preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "span");
    assert_eq!(events[0]["id"], "evt_rust_otel_1");
    assert_eq!(events[0]["timestamp"], "2026-06-02T10:00:30Z");

    let span = &events[0]["attributes"];
    assert_eq!(span["name"], "GET /checkout/{cart_id}");
    assert_eq!(span["status"], "ok");
    assert!(span["traceId"].as_str().unwrap().len() == 32);
    assert!(span["spanId"].as_str().unwrap().len() == 16);
    assert!(span["durationMs"].as_f64().unwrap() >= 0.0);

    let metadata = &span["metadata"];
    assert_eq!(metadata["source"], "opentelemetry.span_exporter");
    assert_eq!(metadata["service.name"], "checkout-api");
    assert_eq!(metadata["service.version"], "1.2.3");
    assert_eq!(metadata["deployment.environment"], "production");
    assert_eq!(metadata["otel.span.kind"], "server");
    assert_eq!(
        metadata["otel.instrumentation.scope.name"],
        "checkout-instrumentation"
    );
    assert_eq!(metadata["http.request.method"], "GET");
    assert_eq!(metadata["http.route"], "/checkout/{cart_id}");
    assert_eq!(metadata["http.response.status_code"], 202);
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
    let span = &payload["events"][0]["attributes"];
    assert_eq!(span["name"], "SELECT checkout");
    assert_eq!(span["status"], "error");
    let metadata = &span["metadata"];
    assert_eq!(metadata["otel.span.kind"], "client");
    assert_eq!(metadata["db.system"], "postgresql");
    assert_eq!(metadata["exception.type"], "DbTimeout");
    assert!(metadata.get("otel.status.description").is_none());
    assert!(metadata.get("db.statement").is_none());

    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("sample@example.com"));
    assert!(!text.contains("timeout talking to database"));
}
