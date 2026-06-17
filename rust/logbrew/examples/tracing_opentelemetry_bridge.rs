use logbrew::{
    EnvironmentEvent, LogBrewClient, Metadata, MetadataValue, RecordingTransport, ReleaseEvent,
    Traceparent, TraceparentSpanInput, opentelemetry_span_context_from_current_tracing_span,
};
use opentelemetry::{
    Context,
    trace::{
        SpanContext, SpanId, TraceContextExt as _, TraceFlags, TraceId, TraceState,
        TracerProvider as _, noop::NoopTracerProvider,
    },
};
use std::sync::{Arc, Mutex};
use tracing_opentelemetry::OpenTelemetrySpanExt as _;
use tracing_subscriber::prelude::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));

    {
        let mut client = client
            .lock()
            .expect("LogBrew client lock should be healthy");
        client.release(
            "evt_release_checkout",
            "2026-06-02T10:00:00Z",
            ReleaseEvent::new("1.2.3"),
        )?;
        client.environment(
            "evt_environment_checkout",
            "2026-06-02T10:00:01Z",
            EnvironmentEvent::new("production"),
        )?;
    }

    let tracer = NoopTracerProvider::new().tracer("checkout-service");
    let subscriber =
        tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(tracer));

    tracing::subscriber::with_default(subscriber, || -> Result<(), Box<dyn std::error::Error>> {
        let remote_parent = SpanContext::new(
            TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736")?,
            SpanId::from_hex("00f067aa0ba902b7")?,
            TraceFlags::SAMPLED,
            true,
            TraceState::NONE,
        );
        let checkout_span = tracing::info_span!("checkout.otel");
        checkout_span.set_parent(Context::new().with_remote_span_context(remote_parent))?;
        let _guard = checkout_span.enter();

        let otel_context = opentelemetry_span_context_from_current_tracing_span()
            .ok_or("expected active OpenTelemetry span context")?;
        let outgoing_headers = Traceparent::create_headers_from_opentelemetry_context(
            &otel_context,
            "1111111111111111",
        )?;

        let mut span_metadata = Metadata::new();
        span_metadata.insert(
            "bridge".to_string(),
            MetadataValue::String("tracing-opentelemetry".to_string()),
        );
        let outgoing_header_count = outgoing_headers.len() as u64;
        span_metadata.insert(
            "outgoingTraceHeaderCount".to_string(),
            MetadataValue::from(outgoing_header_count),
        );
        span_metadata.insert(
            "sampled".to_string(),
            MetadataValue::Bool(otel_context.sampled()),
        );

        let span = Traceparent::span_attributes_from_opentelemetry_context(
            &otel_context,
            TraceparentSpanInput::new("checkout.otel.child", "1111111111111111", "ok")
                .with_metadata(span_metadata),
        )?;
        client
            .lock()
            .expect("LogBrew client lock should be healthy")
            .span("evt_tracing_otel_child", "2026-06-02T10:00:02Z", span)?;
        Ok(())
    })?;

    let mut client = client
        .lock()
        .expect("LogBrew client lock should be healthy");
    println!("{}", client.preview_json()?);
    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":3}}",
        response.status_code, response.attempts
    );
    Ok(())
}
