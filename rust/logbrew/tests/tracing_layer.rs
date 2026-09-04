#![cfg(feature = "tracing")]

use logbrew::{
    LogBrewClient, LogBrewTracingLayer, TelemetryContext, TelemetryNamedVersion, TelemetryResource,
    TelemetryTraceContext,
};
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

fn queued_events(client: &Arc<Mutex<LogBrewClient>>) -> Vec<Value> {
    let payload: Value =
        serde_json::from_str(&client.lock().unwrap().preview_json().unwrap()).unwrap();
    payload["events"].as_array().unwrap().clone()
}

fn assert_strings(value: &Value, expected: &[(&str, &str)]) {
    for (pointer, expected) in expected {
        assert_eq!(
            value.pointer(pointer).and_then(Value::as_str),
            Some(*expected),
            "{pointer}"
        );
    }
}

fn assert_absent(value: &Value, pointers: &[&str]) {
    for pointer in pointers {
        assert!(value.pointer(pointer).is_none(), "unexpected {pointer}");
    }
}

fn assert_not_contains(value: &Value, fragments: &[&str]) {
    let text = serde_json::to_string(value).unwrap().to_ascii_lowercase();
    for fragment in fragments {
        assert!(!text.contains(fragment), "unexpected {fragment}");
    }
}

fn assert_event_types(events: &[Value], expected: &[&str]) {
    let actual = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

fn assert_correlation(
    attributes: &Value,
    trace_id: &str,
    span_id: &str,
    parent_span_id: Option<&str>,
) {
    let flat = attributes
        .get("traceId")
        .map_or(&attributes["metadata"], |_| attributes);
    let trace = &attributes["context"]["trace"];
    for values in [flat, trace] {
        assert_strings(values, &[("/traceId", trace_id), ("/spanId", span_id)]);
        assert_eq!(
            values.get("parentSpanId").and_then(Value::as_str),
            parent_span_id
        );
    }
}

#[test]
fn tracing_layer_queues_allowed_log_fields() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string())
            .with_allowed_fields(["routeTemplate", "statusCode", "sampled", "unsafeDebug"])
            .with_context(
                TelemetryContext::new().with_resource(
                    TelemetryResource::new()
                        .with_service(TelemetryNamedVersion::new("checkout-service")),
                ),
            );
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
        tracing::debug!(target: "worker", "debug event");
        tracing::warn!(target: "worker", "warning event");
        tracing::error!(target: "worker", "error event");
    });

    let events = queued_events(&client);
    assert_event_types(&events, &["log", "log", "log", "log"]);
    assert_eq!(
        events
            .iter()
            .map(|event| event["attributes"]["level"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["info", "info", "warning", "error"]
    );
    assert_strings(
        &events[0],
        &[
            ("/timestamp", "2026-06-02T10:00:00Z"),
            ("/attributes/message", "checkout tracing event accepted"),
            ("/attributes/logger", "checkout"),
            ("/attributes/metadata/routeTemplate", "/checkout/{cart_id}"),
            ("/attributes/context/resource/framework/name", "tracing"),
            (
                "/attributes/context/resource/service/name",
                "checkout-service",
            ),
        ],
    );
    let metadata = &events[0]["attributes"]["metadata"];
    assert_eq!(metadata["statusCode"], 202);
    assert_eq!(metadata["sampled"], true);
    assert_absent(
        metadata,
        &["/unsafeDebug", "/authorization", "/requestBody"],
    );
    assert_not_contains(
        &Value::Array(events),
        &[
            "coupon=sample",
            "bearer sample",
            "card=sample",
            "debug-value",
        ],
    );
}

#[test]
fn tracing_layer_can_queue_privacy_bounded_spans() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string())
            .with_span_events()
            .with_error_issues()
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

    let events = queued_events(&client);
    assert_event_types(&events, &["log", "log", "issue", "span", "span"]);

    for (index, span_id, parent_id) in [
        (0, "0000000000000001", None),
        (2, "0000000000000002", Some("0000000000000001")),
        (3, "0000000000000002", Some("0000000000000001")),
        (4, "0000000000000001", None),
    ] {
        assert_correlation(
            &events[index]["attributes"],
            "00000000000000000000000000000001",
            span_id,
            parent_id,
        );
    }
    let issue = &events[2]["attributes"];
    assert_strings(
        issue,
        &[
            ("/title", "cart validation failed"),
            ("/message", "cart validation failed"),
            ("/level", "error"),
            ("/metadata/mechanism", "tracing.event"),
            ("/metadata/sourceFileName", "tracing_layer.rs"),
            ("/metadata/issueGroupingSource", "tracing_callsite"),
            ("/metadata/issueEvidenceCompleteness", "partial"),
            ("/metadata/issueMissingEvidence", "exception,stackFrames"),
        ],
    );
    assert_eq!(issue["metadata"]["handled"], true);
    assert!(issue["metadata"]["sourceLineNumber"].as_u64().is_some());
    assert_absent(issue, &["/stackFrames", "/exception"]);

    let child_span = &events[3]["attributes"];
    assert_strings(
        child_span,
        &[
            ("/name", "checkout.validate"),
            ("/status", "error"),
            ("/metadata/tracingLastErrorLevel", "ERROR"),
            ("/metadata/tracingLastErrorTarget", "checkout"),
        ],
    );
    assert!(child_span["durationMs"].as_f64().unwrap() >= 0.0);
    assert_eq!(child_span["metadata"]["tracingSpanEventCount"], 1);
    assert_eq!(child_span["metadata"]["tracingSpanErrorEventCount"], 1);
    assert!(
        !child_span["metadata"]
            .to_string()
            .contains("cart validation failed")
    );

    let root_span = &events[4]["attributes"];
    assert_strings(
        root_span,
        &[
            ("/name", "checkout.request"),
            ("/status", "ok"),
            ("/metadata/routeTemplate", "/checkout/{cart_id}"),
            ("/metadata/cartTier", "gold"),
        ],
    );
    assert_eq!(root_span["metadata"]["tracingSpanEventCount"], 1);
    assert_absent(
        &root_span["metadata"],
        &[
            "/tracingSpanErrorEventCount",
            "/unsafeDebug",
            "/authorization",
        ],
    );
    assert_not_contains(
        &Value::Array(events),
        &["coupon=sample", "bearer sample", "debug-value"],
    );
}

#[test]
fn tracing_layer_continues_incoming_traceparent_on_root_span() {
    let stale_trace_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let stale_span_id = "bbbbbbbbbbbbbbbb";
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string())
            .with_span_events()
            .with_allowed_fields(["routeTemplate", "statusCode"])
            .with_context(TelemetryContext::new().with_trace(
                TelemetryTraceContext::new(stale_trace_id).with_span_id(stale_span_id),
            ));
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

    let events = queued_events(&client);
    assert_event_types(&events, &["log", "log", "span", "span"]);

    for (index, span_id, parent_id) in [
        (0, "0000000000000001", "00f067aa0ba902b7"),
        (1, "0000000000000002", "0000000000000001"),
        (2, "0000000000000002", "0000000000000001"),
        (3, "0000000000000001", "00f067aa0ba902b7"),
    ] {
        assert_correlation(
            &events[index]["attributes"],
            "4bf92f3577b34da6a3ce929d0e0e4736",
            span_id,
            Some(parent_id),
        );
    }
    let root_log = &events[0]["attributes"];
    let root_log_metadata = &root_log["metadata"];
    assert_eq!(root_log_metadata["sampled"], true);
    assert_eq!(root_log["context"]["trace"]["sampled"], true);

    assert_eq!(events[1]["attributes"]["metadata"]["sampled"], true);

    let child_span = &events[2]["attributes"];
    assert_eq!(child_span["metadata"]["sampled"], true);
    assert_eq!(child_span["metadata"]["tracingSpanEventCount"], 1);
    assert_absent(&child_span["metadata"], &["/tracingSpanErrorEventCount"]);

    let root_span = &events[3]["attributes"];
    assert_strings(
        root_span,
        &[("/metadata/routeTemplate", "/checkout/{cart_id}")],
    );
    assert_eq!(root_span["metadata"]["sampled"], true);
    assert_eq!(root_span["metadata"]["tracingSpanEventCount"], 1);
    assert_absent(&root_span["metadata"], &["/traceparent"]);
    assert_not_contains(
        &Value::Array(events),
        &[
            incoming_traceparent,
            "coupon=sample",
            stale_trace_id,
            stale_span_id,
        ],
    );
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
