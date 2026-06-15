# logbrew

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Rust SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
cargo add logbrew
cargo add logbrew --features http
```

`cargo doc --package logbrew --no-deps` documents the main `LogBrewClient`, `ClientBuilder`, `SdkError`, `Transport`, `RecordingTransport`, `TransportResponse`, `TransportError`, public event builders such as `MetricEvent`, metadata aliases such as `Metadata` and `MetadataValue`, timeline builders such as `ProductTimeline`, request helpers such as `HttpRequestTelemetry`, W3C helpers such as `Traceparent`, and lifecycle helpers such as `pending_events`, `flush`, `shutdown`, and `preview_json`. With the `http` feature enabled, docs also include `DEFAULT_HTTP_ENDPOINT`, `HttpTransportConfig`, and `HttpTransport`.

The `examples` directory contains copyable snippets for creating a client, previewing queued JSON, and sending events through the optional HTTP transport in your own Rust service.

## Example

```rust
use logbrew::{
    ActionEvent, EnvironmentEvent, IssueEvent, LogBrewClient, LogEvent, RecordingTransport,
    ReleaseEvent, SpanEvent,
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

    println!("{}", client.preview_json()?);

    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":6}}",
        response.status_code, response.attempts
    );
    Ok(())
}
```

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush` or `shutdown` to send queued events through a transport, and use `preview_json` when you want a stable local JSON preview before sending anything.

## First Useful Service Telemetry

For a Rust service, start with release, environment, a canonical-severity log, a product action, a network milestone, a request-duration metric, and one W3C-linked request span:

```rust
use logbrew::{
    EnvironmentEvent, LogBrewClient, LogEvent, Metadata, MetadataValue, MetricEvent,
    ProductTimeline, ReleaseEvent, Traceparent, TraceparentSpanInput,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let trace = Traceparent::parse(incoming)?;
    let child_span_id = "b7ad6b7169203331";
    let route_template = "/checkout/:cart_id";
    let session_id = "sess_checkout_123";

    let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;

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

    let mut log_metadata = Metadata::new();
    log_metadata.insert("traceId".to_string(), MetadataValue::String(trace.trace_id.clone()));
    log_metadata.insert("sessionId".to_string(), MetadataValue::String(session_id.to_string()));
    log_metadata.insert("routeTemplate".to_string(), MetadataValue::String(route_template.to_string()));
    client.log(
        "evt_log_checkout_started",
        "2026-06-02T10:00:02Z",
        LogEvent::new("checkout request started", "info")
            .with_logger("checkout")
            .with_metadata(log_metadata),
    )?;

    client.action(
        "evt_action_checkout_submit",
        "2026-06-02T10:00:03Z",
        ProductTimeline::product_action("checkout.submit")
            .with_route_template(route_template)
            .with_session_id(session_id)
            .with_trace_id(&trace.trace_id)
            .with_screen("Checkout")
            .build()?,
    )?;
    client.action(
        "evt_action_payment_api",
        "2026-06-02T10:00:04Z",
        ProductTimeline::network_milestone("/payments/:payment_id")
            .with_method("POST")
            .with_status_code(202)
            .with_duration_ms(183.4)
            .with_session_id(session_id)
            .with_trace_id(&trace.trace_id)
            .build()?,
    )?;

    let mut metric_metadata = Metadata::new();
    metric_metadata.insert("method".to_string(), MetadataValue::String("POST".to_string()));
    metric_metadata.insert("routeTemplate".to_string(), MetadataValue::String(route_template.to_string()));
    metric_metadata.insert("statusCode".to_string(), MetadataValue::from(202));
    metric_metadata.insert("traceId".to_string(), MetadataValue::String(trace.trace_id.clone()));
    client.metric(
        "evt_metric_http_server_duration",
        "2026-06-02T10:00:05Z",
        MetricEvent::new("http.server.duration", "histogram", 183.4, "ms", "delta")
            .with_metadata(metric_metadata),
    )?;

    client.span(
        "evt_span_checkout_request",
        "2026-06-02T10:00:06Z",
        Traceparent::span_attributes_from_context(
            &trace,
            TraceparentSpanInput::new("POST /checkout/:cart_id", child_span_id, "ok")
                .with_duration_ms(183.4),
        )?,
    )?;

    println!("{}", client.preview_json()?);
    Ok(())
}
```

This stays app-owned and privacy-safe: use route templates such as `/checkout/:cart_id`, primitive metadata, release, environment, and canonical severities (`info`, `warning`, `error`, `critical`). Do not put account-specific values, request or response payloads, arbitrary headers, query strings, hashes, full URLs, or sensitive user data into telemetry.

## HTTP Server Request Telemetry

For Axum, Tower, Actix, Rocket, or a custom Rust server, keep request capture in your app-owned middleware and pass stable route metadata into `HttpRequestTelemetry`. The helper builds a request span plus an optional `http.server.duration` metric without installing framework middleware, patching HTTP clients, or capturing payloads/headers.

```rust
use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let mut metadata = Metadata::new();
    metadata.insert("framework".to_string(), MetadataValue::String("axum".to_string()));

    let request = HttpRequestTelemetry::new(
        "https://api.example.invalid/checkout/:cart_id?coupon=sample#review",
        "post",
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_incoming_traceparent(incoming)
    .with_status_code(202)
    .with_duration_ms(183.4)
    .with_metadata(metadata)
    .build()?;

    let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    client.span("evt_http_server_span", "2026-06-02T10:00:00Z", request.span)?;
    if let Some(metric) = request.metric {
        client.metric("evt_http_server_duration", "2026-06-02T10:00:00Z", metric)?;
    }

    println!("{}", client.preview_json()?);
    eprintln!("outgoing traceparent: {}", request.outgoing_traceparent);
    Ok(())
}
```

`HttpRequestTelemetry` strips query strings and hash fragments from route templates, normalizes HTTP methods, adds primitive metadata such as `routeTemplate`, `method`, `statusCode`, and `statusCodeClass`, treats valid incoming W3C `traceparent` values as parent context, and falls back to the explicit app trace ID when propagation is missing or malformed. It does not create backend setup state, inspect account sessions, capture arbitrary headers, or read request/response bodies.

## Axum Middleware Example

For Axum apps, use `route_layer` plus `middleware::from_fn_with_state` so LogBrew receives Axum's matched route template instead of the raw request URI. The packaged `examples/axum_request_middleware.rs` file is a runnable mini-app; the core pattern is:

```rust
use axum::{
    body::Body,
    extract::{MatchedPath, State},
    http::Request,
    middleware::Next,
    response::Response,
};
use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

async fn logbrew_middleware(
    State(state): State<AppState>,
    matched_path: Option<MatchedPath>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().as_str().to_string();
    let incoming_traceparent = request
        .headers()
        .get("traceparent")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let route_template = matched_path
        .map(|path| path.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());

    let response = next.run(request).await;
    let mut metadata = Metadata::new();
    metadata.insert("framework".to_string(), MetadataValue::String("axum".to_string()));

    let mut telemetry = HttpRequestTelemetry::new(
        route_template,
        method,
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_status_code(response.status().as_u16())
    .with_duration_ms(started.elapsed().as_secs_f64() * 1000.0)
    .with_metadata(metadata);
    if let Some(traceparent) = incoming_traceparent {
        telemetry = telemetry.with_incoming_traceparent(traceparent);
    }

    let events = telemetry.build().expect("request telemetry should build");
    let mut client = state.client.lock().expect("LogBrew client lock should be available");
    client
        .span("evt_http_request", "2026-06-02T10:00:00Z", events.span)
        .expect("request span should queue");
    if let Some(metric) = events.metric {
        client
            .metric("evt_http_request_duration", "2026-06-02T10:00:00Z", metric)
            .expect("request metric should queue");
    }
    response
}
```

Keep the LogBrew client in your own state management, generate unique event/span IDs per request, and flush on your normal lifecycle boundary. The middleware should only read the W3C `traceparent` propagation header and framework-owned route/status metadata; do not capture arbitrary headers, raw request URIs, payloads, account session values, or user-specific identifiers.

## W3C Trace Context

Use `Traceparent` when your Rust app already has an incoming or outgoing W3C `traceparent` value:

```rust
use logbrew::{Traceparent, TraceparentSpanInput};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let trace = Traceparent::parse(incoming)?;
    let headers = Traceparent::create_headers(
        &trace.trace_id,
        "b7ad6b7169203331",
        &trace.trace_flags,
    )?;
    let span = Traceparent::span_attributes_from_context(
        &trace,
        TraceparentSpanInput::new("POST /checkout/:cart_id", "b7ad6b7169203331", "ok"),
    )?;

    assert_eq!(headers.get("traceparent").map(String::as_str), Some("00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"));
    drop(span);
    Ok(())
}
```

`Traceparent` validates W3C shape, rejects forbidden or all-zero IDs, normalizes identifiers, exposes the sampled flag, creates one-header outbound carriers, and derives LogBrew child span events. It does not install OpenTelemetry, patch HTTP clients, or capture request payloads or headers.

## Metrics

Use `MetricEvent` for explicit app-owned measurements such as counters, gauges, and histograms. Metrics are not captured automatically; keep metadata primitive and low-cardinality, and avoid raw URLs, query strings, user IDs, request or response payloads, headers, and free-form text.

```rust
use logbrew::{LogBrewClient, MetricEvent};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.metric(
        "evt_metric_001",
        "2026-06-02T10:00:06Z",
        MetricEvent::new("checkout.request.duration", "histogram", 42.5, "ms", "delta"),
    )?;

    println!("{}", client.preview_json()?);
    Ok(())
}
```

Metric kinds are `counter`, `gauge`, and `histogram`. Gauge metrics use `instant` temporality; counter and histogram metrics use `delta` or `cumulative` temporality and must be non-negative.

## Product And Network Timelines

Use `ProductTimeline` when your app already knows the product step or API milestone that matters and you want an agent-readable timeline without recording a visual session replay:

```rust
use logbrew::{LogBrewClient, ProductTimeline};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.action(
        "evt_checkout_submit",
        "2026-06-02T10:00:07Z",
        ProductTimeline::product_action("checkout.submit")
            .with_route_template("/checkout/:cart_id")
            .with_session_id("session_123")
            .with_trace_id("trace_123")
            .with_screen("Checkout")
            .with_funnel("purchase")
            .with_step("submit")
            .build()?,
    )?;

    client.action(
        "evt_checkout_api",
        "2026-06-02T10:00:08Z",
        ProductTimeline::network_milestone("/api/checkout/:cart_id")
            .with_method("POST")
            .with_status_code(503)
            .with_duration_ms(42.5)
            .with_session_id("session_123")
            .with_trace_id("trace_123")
            .build()?,
    )?;

    println!("{}", client.preview_json()?);
    Ok(())
}
```

The builders return normal `ActionEvent` values, so they work with the existing queue, preview, flush, and retry behavior. They accept only primitive metadata, copy it defensively, strip query strings and hashes from route templates, reduce full HTTP URLs to paths, normalize HTTP methods, and infer failed network milestones from `4xx`/`5xx` status codes. They do not patch HTTP clients, capture request or response payloads, capture arbitrary headers, auto-capture clicks, or claim visual replay.

## HTTP Delivery

Enable the optional HTTP feature when you want LogBrew to post queued batches from a normal Rust app:

```bash
cargo add logbrew --features http
```

```rust
use logbrew::{
    HttpTransport, HttpTransportConfig, LogBrewClient, ReleaseEvent, DEFAULT_HTTP_ENDPOINT,
};
use std::time::Duration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;

    let mut transport = HttpTransport::new(HttpTransportConfig {
        endpoint: DEFAULT_HTTP_ENDPOINT.to_string(),
        headers: vec![("x-logbrew-env".to_string(), "production".to_string())],
        timeout: Some(Duration::from_secs(10)),
        ..Default::default()
    })?;

    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{}}}",
        response.status_code, response.attempts
    );
    Ok(())
}
```

`HttpTransport` sends JSON with an `authorization` header, returns HTTP statuses to the existing retry logic, and maps network failures to retryable `TransportError` values so queued events are preserved until delivery succeeds.
