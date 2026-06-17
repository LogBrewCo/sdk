#![cfg(feature = "tracing")]

use logbrew::{LogBrewClient, LogBrewTracingLayer};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tracing_subscriber::prelude::*;

fn sample_client() -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .max_retries(2)
        .build()
        .expect("client should build")
}

#[test]
fn tracing_layer_queues_allowed_log_fields() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string())
            .with_allowed_fields(["routeTemplate", "statusCode", "sampled", "unsafeDebug"]);
    let subscriber = tracing_subscriber::registry().with(layer);

    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(
            target: "checkout",
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
            statusCode = 202_u64,
            sampled = true,
            unsafeDebug = ?vec!["debug-value"],
            authorization = "Bearer sample",
            requestBody = "card=sample",
            "checkout tracing event accepted"
        );
    });

    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "log");
    assert_eq!(events[0]["timestamp"], "2026-06-02T10:00:00Z");
    assert_eq!(
        events[0]["attributes"]["message"],
        "checkout tracing event accepted"
    );
    assert_eq!(events[0]["attributes"]["level"], "info");
    assert_eq!(events[0]["attributes"]["logger"], "checkout");
    let metadata = &events[0]["attributes"]["metadata"];
    assert_eq!(metadata["routeTemplate"], "/checkout/{cart_id}");
    assert_eq!(metadata["statusCode"], 202);
    assert_eq!(metadata["sampled"], true);
    assert_eq!(metadata["tracingTarget"], "checkout");
    assert_eq!(metadata["tracingLevel"], "INFO");
    assert!(metadata.get("unsafeDebug").is_none());
    assert!(metadata.get("authorization").is_none());
    assert!(metadata.get("requestBody").is_none());
    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("coupon=sample"));
    assert!(!text.contains("bearer sample"));
    assert!(!text.contains("card=sample"));
    assert!(!text.contains("debug-value"));
}

#[test]
fn tracing_layer_normalizes_warning_and_debug_levels() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string());
    let subscriber = tracing_subscriber::registry().with(layer);

    tracing::subscriber::with_default(subscriber, || {
        tracing::debug!(target: "worker", "debug event");
        tracing::warn!(target: "worker", "warning event");
    });

    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["attributes"]["level"], "info");
    assert_eq!(events[1]["attributes"]["level"], "warning");
    assert!(events[0]["attributes"]["metadata"].get("message").is_none());
}

#[test]
fn tracing_layer_can_queue_privacy_bounded_spans() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string())
            .with_span_events()
            .with_allowed_fields(["routeTemplate", "statusCode", "cartTier", "unsafeDebug"]);
    let subscriber = tracing_subscriber::registry().with(layer);

    tracing::subscriber::with_default(subscriber, || {
        let root = tracing::info_span!(
            target: "checkout",
            "checkout.request",
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
            cartTier = "gold",
            unsafeDebug = ?vec!["debug-value"],
            authorization = "Bearer sample",
        );
        let _root_guard = root.enter();
        tracing::info!(
            target: "checkout",
            statusCode = 202_u64,
            "checkout tracing event accepted"
        );
        let child = tracing::debug_span!(target: "checkout", "checkout.validate");
        let _child_guard = child.enter();
        tracing::error!(target: "checkout", "cart validation failed");
    });

    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| &event["type"])
            .collect::<Vec<_>>(),
        vec!["log", "log", "span", "span"]
    );

    let info_log_metadata = &events[0]["attributes"]["metadata"];
    assert_eq!(
        info_log_metadata["traceId"],
        "00000000000000000000000000000001"
    );
    assert_eq!(info_log_metadata["spanId"], "0000000000000001");

    let child_span = &events[2]["attributes"];
    assert_eq!(child_span["name"], "checkout.validate");
    assert_eq!(child_span["traceId"], "00000000000000000000000000000001");
    assert_eq!(child_span["spanId"], "0000000000000002");
    assert_eq!(child_span["parentSpanId"], "0000000000000001");
    assert_eq!(child_span["status"], "error");
    assert!(child_span["durationMs"].as_f64().unwrap() >= 0.0);
    assert_eq!(child_span["metadata"]["tracingSpanEventCount"], 1);
    assert_eq!(child_span["metadata"]["tracingSpanErrorEventCount"], 1);
    assert_eq!(child_span["metadata"]["tracingLastErrorLevel"], "ERROR");
    assert_eq!(child_span["metadata"]["tracingLastErrorTarget"], "checkout");
    assert!(
        !child_span["metadata"]
            .to_string()
            .contains("cart validation failed")
    );

    let root_span = &events[3]["attributes"];
    assert_eq!(root_span["name"], "checkout.request");
    assert_eq!(root_span["traceId"], "00000000000000000000000000000001");
    assert_eq!(root_span["spanId"], "0000000000000001");
    assert_eq!(root_span["status"], "ok");
    assert_eq!(root_span["metadata"]["tracingSpanEventCount"], 1);
    assert!(
        root_span["metadata"]
            .get("tracingSpanErrorEventCount")
            .is_none()
    );
    assert_eq!(
        root_span["metadata"]["routeTemplate"],
        "/checkout/{cart_id}"
    );
    assert_eq!(root_span["metadata"]["cartTier"], "gold");
    assert!(root_span["metadata"].get("unsafeDebug").is_none());
    assert!(root_span["metadata"].get("authorization").is_none());

    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("coupon=sample"));
    assert!(!text.contains("bearer sample"));
    assert!(!text.contains("debug-value"));
}

#[test]
fn tracing_layer_continues_incoming_traceparent_on_root_span() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string())
            .with_span_events()
            .with_allowed_fields(["routeTemplate", "statusCode"]);
    let subscriber = tracing_subscriber::registry().with(layer);
    let incoming_traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    tracing::subscriber::with_default(subscriber, || {
        let root = tracing::info_span!(
            target: "checkout",
            "checkout.request",
            traceparent = incoming_traceparent,
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
        );
        let _root_guard = root.enter();
        tracing::info!(
            target: "checkout",
            statusCode = 202_u64,
            "checkout tracing event accepted"
        );
        let child = tracing::debug_span!(target: "checkout", "checkout.validate");
        let _child_guard = child.enter();
        tracing::info!(target: "checkout", "cart validation passed");
    });

    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| &event["type"])
            .collect::<Vec<_>>(),
        vec!["log", "log", "span", "span"]
    );

    let root_log_metadata = &events[0]["attributes"]["metadata"];
    assert_eq!(
        root_log_metadata["traceId"],
        "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    assert_eq!(root_log_metadata["spanId"], "0000000000000001");
    assert_eq!(root_log_metadata["parentSpanId"], "00f067aa0ba902b7");
    assert_eq!(root_log_metadata["sampled"], true);

    let child_log_metadata = &events[1]["attributes"]["metadata"];
    assert_eq!(
        child_log_metadata["traceId"],
        "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    assert_eq!(child_log_metadata["spanId"], "0000000000000002");
    assert_eq!(child_log_metadata["parentSpanId"], "0000000000000001");
    assert_eq!(child_log_metadata["sampled"], true);

    let child_span = &events[2]["attributes"];
    assert_eq!(child_span["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(child_span["spanId"], "0000000000000002");
    assert_eq!(child_span["parentSpanId"], "0000000000000001");
    assert_eq!(child_span["metadata"]["sampled"], true);
    assert_eq!(child_span["metadata"]["tracingSpanEventCount"], 1);
    assert!(
        child_span["metadata"]
            .get("tracingSpanErrorEventCount")
            .is_none()
    );

    let root_span = &events[3]["attributes"];
    assert_eq!(root_span["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(root_span["spanId"], "0000000000000001");
    assert_eq!(root_span["parentSpanId"], "00f067aa0ba902b7");
    assert_eq!(
        root_span["metadata"]["routeTemplate"],
        "/checkout/{cart_id}"
    );
    assert_eq!(root_span["metadata"]["sampled"], true);
    assert_eq!(root_span["metadata"]["tracingSpanEventCount"], 1);
    assert!(root_span["metadata"].get("traceparent").is_none());

    let text = payload.to_string();
    assert!(!text.contains(incoming_traceparent));
    assert!(!text.contains("coupon=sample"));
}

#[cfg(feature = "tracing-opentelemetry")]
#[test]
fn tracing_opentelemetry_helper_returns_none_without_otel_layer() {
    let subscriber = tracing_subscriber::registry();

    tracing::subscriber::with_default(subscriber, || {
        let span = tracing::info_span!("checkout.without_otel");
        let _guard = span.enter();

        assert!(
            logbrew::opentelemetry_span_context_from_current_tracing_span().is_none(),
            "helper should not synthesize context when no OTel layer is installed"
        );
        assert!(
            logbrew::opentelemetry_span_context_from_tracing_span(&span).is_none(),
            "helper should ignore spans without valid OTel context"
        );
    });
}

#[cfg(feature = "tracing-opentelemetry")]
#[test]
fn tracing_opentelemetry_helper_copies_active_span_context() {
    use logbrew::{Traceparent, TraceparentSpanInput};
    use opentelemetry::{
        Context,
        trace::{
            SpanContext, SpanId, TraceContextExt as _, TraceFlags, TraceId, TraceState,
            TracerProvider as _, noop::NoopTracerProvider,
        },
    };
    use tracing_opentelemetry::OpenTelemetrySpanExt as _;

    let provider = NoopTracerProvider::new();
    let tracer = provider.tracer("logbrew-test");
    let subscriber =
        tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(tracer));

    tracing::subscriber::with_default(subscriber, || {
        let remote_context = SpanContext::new(
            TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap(),
            SpanId::from_hex("00f067aa0ba902b7").unwrap(),
            TraceFlags::SAMPLED,
            true,
            TraceState::NONE,
        );
        let root = tracing::info_span!("checkout.otel");
        root.set_parent(Context::new().with_remote_span_context(remote_context))
            .expect("root span should accept an OTel parent before it starts");
        let _guard = root.enter();

        let copied = logbrew::opentelemetry_span_context_from_current_tracing_span()
            .expect("expected active OTel context");
        assert_eq!(copied.trace_id(), "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(copied.span_id(), "00f067aa0ba902b7");
        assert_eq!(copied.trace_flags(), "01");
        assert!(copied.sampled());

        let headers =
            Traceparent::create_headers_from_opentelemetry_context(&copied, "1111111111111111")
                .unwrap();
        assert_eq!(
            headers.get("traceparent").map(String::as_str),
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01")
        );

        let child = Traceparent::span_attributes_from_opentelemetry_context(
            &copied,
            TraceparentSpanInput::new("checkout.otel.child", "1111111111111111", "ok"),
        )
        .unwrap();
        let mut client = sample_client();
        client
            .span("evt_otel_child", "2026-06-02T10:00:00Z", child)
            .unwrap();
        let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
        let span = &payload["events"][0]["attributes"];
        assert_eq!(span["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(span["parentSpanId"], "00f067aa0ba902b7");
        assert_eq!(span["spanId"], "1111111111111111");
    });
}
