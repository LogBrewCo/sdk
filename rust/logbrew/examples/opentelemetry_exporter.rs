use logbrew::{
    LogBrewClient, LogBrewOpenTelemetrySpanExporter, LogBrewOpenTelemetrySpanExporterConfig,
    RecordingTransport,
};
use opentelemetry::{
    KeyValue,
    trace::{Span, SpanKind, Status, Tracer, TracerProvider},
};
use opentelemetry_sdk::trace::{SdkTracerProvider, SimpleSpanProcessor};
use std::sync::{Arc, Mutex};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));
    let exporter = LogBrewOpenTelemetrySpanExporter::new(
        Arc::clone(&client),
        LogBrewOpenTelemetrySpanExporterConfig::new("2026-06-02T10:00:30Z")
            .with_event_id_prefix("evt_rust_otel")
            .with_service_name("checkout-service")
            .with_service_version("1.2.3")
            .with_deployment_environment("production")
            .with_allowed_attribute_keys([
                "http.request.method",
                "http.route",
                "http.response.status_code",
                "exception.type",
            ]),
    );
    let provider = SdkTracerProvider::builder()
        .with_span_processor(SimpleSpanProcessor::new(exporter))
        .build();
    let tracer = provider.tracer("checkout-instrumentation");

    let mut span = tracer
        .span_builder("POST /checkout/{cart_id}")
        .with_kind(SpanKind::Server)
        .with_attributes([
            KeyValue::new("http.request.method", "POST"),
            KeyValue::new("http.route", "/checkout/{cart_id}?coupon=sample"),
            KeyValue::new("http.response.status_code", 202_i64),
            KeyValue::new("authorization", "Bearer not-for-telemetry"),
            KeyValue::new("exception.message", "not-for-telemetry"),
        ])
        .start(&tracer);
    span.set_status(Status::Ok);
    span.end();
    provider.force_flush()?;

    let mut client = client
        .lock()
        .expect("LogBrew client lock should be healthy");
    println!("{}", client.preview_json()?);
    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":1}}",
        response.status_code, response.attempts
    );
    Ok(())
}
