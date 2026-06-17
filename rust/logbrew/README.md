# logbrew

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Rust SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
cargo add logbrew
cargo add logbrew --features http
cargo add logbrew --features tower
cargo add logbrew --features tracing
```

`cargo doc --package logbrew --no-deps` documents the main `LogBrewClient`, `ClientBuilder`, `SdkError`, `Transport`, `RecordingTransport`, `TransportResponse`, `TransportError`, public event builders such as `MetricEvent`, metadata aliases such as `Metadata` and `MetadataValue`, timeline builders such as `ProductTimeline`, request helpers such as `HttpRequestTelemetry`, W3C helpers such as `Traceparent` and `OpenTelemetrySpanContext`, and lifecycle helpers such as `pending_events`, `flush`, `shutdown`, and `preview_json`. With the `http` feature enabled, docs also include `DEFAULT_HTTP_ENDPOINT`, `HttpTransportConfig`, and `HttpTransport`. With the `tower` feature enabled, docs include `TowerRequestTelemetryLayer` for app-owned Tower/Axum request telemetry. With the `tracing` feature enabled, docs include `LogBrewTracingLayer` for app-owned `tracing` event-to-log conversion plus opt-in span conversion.

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

For Axum apps, enable the optional Tower integration and use `route_layer` so LogBrew receives Axum's matched route template instead of the raw request URI. Axum, Tokio, and Tower stay out of default `cargo add logbrew`; only apps that opt in to the `tower` feature pay for the integration.

```bash
cargo add logbrew --features tower
```

The packaged `examples/axum_request_middleware.rs` file is a runnable mini-app; the core pattern is:

```rust
use axum::{
    body::Body,
    extract::MatchedPath,
    http::Request,
};
use logbrew::{
    LogBrewClient, Metadata, MetadataValue, TowerRequestIds, TowerRequestTelemetryLayer,
};
use std::sync::{Arc, Mutex};

fn logbrew_layer(
    client: Arc<Mutex<LogBrewClient>>,
) -> TowerRequestTelemetryLayer<
    impl Fn(&Request<Body>) -> String + Clone,
    impl Fn() -> TowerRequestIds + Clone,
    impl Fn() -> String + Clone,
> {
    let mut metadata = Metadata::new();
    metadata.insert("framework".to_string(), MetadataValue::String("axum".to_string()));

    TowerRequestTelemetryLayer::new(
        client,
        |request: &Request<Body>| {
            request
                .extensions()
                .get::<MatchedPath>()
                .map(|path| path.as_str().to_string())
                .unwrap_or_else(|| request.uri().path().to_string())
        },
        || TowerRequestIds::new("11111111111111111111111111111111", "b7ad6b7169203331"),
        || "2026-06-02T10:00:00Z".to_string(),
    )
    .with_metadata(metadata)
}
```

Attach the layer with `Router::route(...).route_layer(logbrew_layer(client.clone()))`, keep the LogBrew client in your own state management, generate unique trace/span IDs per request, and flush on your normal lifecycle boundary. The layer reads only the W3C `traceparent` propagation header and framework-owned route/status metadata; do not capture arbitrary headers, raw request URIs, payloads, account session values, or user-specific identifiers.

## Actix Middleware Example

For Actix Web apps, keep telemetry in app-owned middleware and call `HttpRequestTelemetry` with Actix's matched route pattern after the handler returns. Actix stays out of the LogBrew dependency graph; your app owns the `actix-web` dependency and the middleware placement.

```bash
cargo add logbrew
cargo add actix-web
```

The packaged `examples/actix_request_middleware.rs` file is a runnable mini-app; the core pattern is:

```rust
use actix_web::{
    Error,
    dev::{ServiceRequest, ServiceResponse},
    middleware::Next,
    web,
};
use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue};
use std::{sync::{Arc, Mutex}, time::Instant};

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

async fn logbrew_request_telemetry(
    request: ServiceRequest,
    next: Next<impl actix_web::body::MessageBody + 'static>,
) -> Result<ServiceResponse<impl actix_web::body::MessageBody>, Error> {
    let started = Instant::now();
    let method = request.method().as_str().to_string();
    let incoming = request
        .headers()
        .get("traceparent")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let app_state = request
        .app_data::<web::Data<AppState>>()
        .map(|data| data.get_ref().clone());
    let response = next.call(request).await?;

    let route_template = response
        .request()
        .match_pattern()
        .unwrap_or_else(|| "/unknown".to_string());
    let mut metadata = Metadata::new();
    metadata.insert("framework".to_string(), MetadataValue::String("actix-web".to_string()));
    let mut telemetry = HttpRequestTelemetry::new(
        route_template,
        method,
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_status_code(response.status().as_u16())
    .with_duration_ms(started.elapsed().as_secs_f64() * 1000.0)
    .with_metadata(metadata);
    if let Some(traceparent) = incoming {
        telemetry = telemetry.with_incoming_traceparent(traceparent);
    }
    let Ok(events) = telemetry.build() else {
        return Ok(response);
    };
    if let Some(app_state) = app_state {
        if let Ok(mut client) = app_state.client.lock() {
            let span_event_id = format!("evt_actix_request_span_{}", events.span_id);
            let metric_event_id = format!("evt_actix_request_duration_{}", events.span_id);
            let _ = client.span(span_event_id, "2026-06-02T10:00:00Z", events.span);
            if let Some(metric) = events.metric {
                let _ = client.metric(metric_event_id, "2026-06-02T10:00:00Z", metric);
            }
        }
    }
    Ok(response)
}
```

The packaged example also adds the outgoing `traceparent` to the response. Flush the app-owned `LogBrewClient` on your normal lifecycle boundary, keep route values templated, and do not capture arbitrary headers, raw request URIs, payloads, account session values, or user-specific identifiers.

## Rocket Fairing Example

For Rocket apps, keep request telemetry in app-owned fairings. Record timing in `AdHoc::on_request`, then build the LogBrew request span in `AdHoc::on_response` after Rocket has matched the route; this lets you use `Request::route()` for `/checkout/<cart_id>` instead of emitting raw request paths.

```bash
cargo add logbrew
cargo add rocket
```

The packaged `examples/rocket_request_fairing.rs` file is a runnable mini-app; the core pattern is:

```rust
use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue};
use rocket::{Data, Request, Response, fairing::AdHoc, http::Header};
use std::{sync::{Arc, Mutex}, time::Instant};

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

fn logbrew_request_timer() -> AdHoc {
    AdHoc::on_request(
        "LogBrew request timer",
        |request: &mut Request<'_>, _data: &Data<'_>| {
            Box::pin(async move {
                let _ = request.local_cache(Instant::now);
            })
        },
    )
}

fn logbrew_request_telemetry() -> AdHoc {
    AdHoc::on_response(
        "LogBrew request telemetry",
        |request: &Request<'_>, response: &mut Response<'_>| {
            Box::pin(async move {
                let started = *request.local_cache(Instant::now);
                let Some(state) = request.rocket().state::<AppState>() else { return; };
                let route_template = request
                    .route()
                    .map(|route| route.uri.to_string())
                    .unwrap_or_else(|| "/unknown".to_string());
                let mut metadata = Metadata::new();
                metadata.insert(
                    "framework".to_string(),
                    MetadataValue::String("rocket".to_string()),
                );
                let mut telemetry = HttpRequestTelemetry::new(
                    route_template,
                    request.method().to_string(),
                    "11111111111111111111111111111111",
                    "b7ad6b7169203331",
                )
                .with_status_code(response.status().code)
                .with_duration_ms(started.elapsed().as_secs_f64() * 1000.0)
                .with_metadata(metadata);
                if let Some(traceparent) = request.headers().get_one("traceparent") {
                    telemetry = telemetry.with_incoming_traceparent(traceparent);
                }
                let Ok(events) = telemetry.build() else { return; };
                response.set_header(Header::new(
                    "traceparent",
                    events.outgoing_traceparent.clone(),
                ));
                if let Ok(mut client) = state.client.lock() {
                    let _ = client.span(
                        "evt_rocket_request_span",
                        "2026-06-02T10:00:00Z",
                        events.span,
                    );
                    if let Some(metric) = events.metric {
                        let _ = client.metric(
                            "evt_rocket_request_duration",
                            "2026-06-02T10:00:00Z",
                            metric,
                        );
                    }
                }
            })
        },
    )
}
```

Attach the fairings with `rocket::build().manage(app_state).attach(logbrew_request_timer()).attach(logbrew_request_telemetry())`. Keep the LogBrew client in your own managed state, generate unique trace/span IDs per request, and flush on your normal lifecycle boundary. The fairing reads only the W3C `traceparent` propagation header plus Rocket-owned route/status metadata; do not capture arbitrary headers, raw request URIs, payloads, account session values, or user-specific identifiers.

## Tracing Bridge

For Rust services that already use the `tracing` ecosystem, enable the optional bridge to convert app log events into LogBrew log events without replacing your subscriber stack or capturing arbitrary structured fields by default. Closed `tracing` spans are only converted when your app explicitly calls `with_span_events()`.

```bash
cargo add logbrew --features tracing
cargo add tracing tracing-subscriber
```

```rust
use logbrew::{LogBrewClient, LogBrewTracingLayer};
use std::sync::{Arc, Mutex};
use tracing_subscriber::prelude::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));
    let layer = LogBrewTracingLayer::new(client.clone(), || {
        "2026-06-02T10:00:02Z".to_string()
    })
    .with_span_events()
    .with_allowed_fields(["routeTemplate", "statusCode", "sampled"])
    .with_logger("checkout");

    let subscriber = tracing_subscriber::registry().with(layer);
    tracing::subscriber::with_default(subscriber, || {
        let incoming_traceparent =
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let span = tracing::info_span!(
            target: "checkout",
            "checkout.request",
            traceparent = incoming_traceparent,
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
        );
        let _guard = span.enter();
        tracing::info!(
            target: "checkout",
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
            statusCode = 202_u64,
            sampled = true,
            "checkout tracing event accepted"
        );
    });

    println!("{}", client.lock().unwrap().preview_json()?);
    Ok(())
}
```

`LogBrewTracingLayer` maps `trace`/`debug` to `info`, `warn` to `warning`, and `error` to `error`. It records `tracingTarget` and `tracingLevel`, but only copies additional primitive fields that your app allowlists with `with_allowed_fields(...)`; route-template field values are sanitized to remove query strings and hash fragments. With `with_span_events()`, the layer continues a valid `traceparent` or `trace_parent` field on a root span, generates W3C-shaped child span IDs, adds trace correlation to logs emitted inside a span, records parent/child span links, copies the sampled flag, marks the current span as `error` when an error-level event is emitted inside it, and adds privacy-bounded event summaries such as `tracingSpanEventCount`, `tracingSpanErrorEventCount`, `tracingLastErrorLevel`, and `tracingLastErrorTarget` to the closed span. Malformed trace context is ignored non-fatally and the raw propagation field is not emitted as metadata. Span event summaries intentionally do not copy error messages, stacks, payloads, headers, or arbitrary event fields. Do not allowlist payloads, headers, account session values, raw URLs, or user-specific identifiers.

## W3C Trace Context

Use `Traceparent` when your Rust app already has an incoming or outgoing W3C `traceparent` value:

```rust
use logbrew::{OpenTelemetrySpanContext, Traceparent, TraceparentSpanInput};

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

    // If your app already uses OpenTelemetry, copy the active SpanContext IDs into
    // this dependency-free input instead of adding a LogBrew OTel exporter.
    let otel_context = OpenTelemetrySpanContext::new(
        &trace.trace_id,
        &trace.parent_span_id,
        &trace.trace_flags,
    )?;
    let otel_child = Traceparent::span_attributes_from_opentelemetry_context(
        &otel_context,
        TraceparentSpanInput::new("POST /checkout/:cart_id", "f7ad6b7169203332", "ok"),
    )?;
    drop(otel_child);
    Ok(())
}
```

`Traceparent` validates W3C shape, rejects forbidden or all-zero IDs, normalizes identifiers, exposes the sampled flag, creates one-header outbound carriers, and derives LogBrew child span events. `OpenTelemetrySpanContext` accepts the trace ID, span ID, and trace flags from an app-owned OpenTelemetry span context, then creates LogBrew child spans with the OTel span as parent. It does not install OpenTelemetry, patch HTTP clients, read tracestate/baggage, or capture request payloads or headers.

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
