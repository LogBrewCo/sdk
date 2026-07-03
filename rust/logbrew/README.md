# logbrew

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Rust SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
cargo add logbrew
cargo add logbrew --features http
cargo add logbrew --features hyper
cargo add logbrew --features tower
cargo add logbrew --features tracing
cargo add logbrew --features tracing-opentelemetry
cargo add logbrew --features opentelemetry-exporter
```

`cargo doc --package logbrew --no-deps` documents the main `LogBrewClient`, `ClientBuilder`, `SdkError`, `Transport`, `RecordingTransport`, `TransportResponse`, `TransportError`, public event builders such as `MetricEvent`, metadata aliases such as `Metadata` and `MetadataValue`, timeline builders such as `ProductTimeline`, request helpers such as `HttpRequestTelemetry`, outbound HTTP helpers such as `HttpClientSpan`, dependency span helpers such as `DependencyOperationSpan`, W3C helpers such as `Traceparent` and `OpenTelemetrySpanContext`, and lifecycle helpers such as `pending_events`, `flush`, `shutdown`, and `preview_json`. With the `http` feature enabled, docs also include `DEFAULT_HTTP_ENDPOINT`, `HttpTransportConfig`, `HttpTransport`, and the explicit `ureq` capture helper. With the `hyper` feature enabled, docs include an explicit `http::Request` async send helper for Hyper-compatible clients without adding Hyper as an SDK dependency. With the `reqwest` feature enabled, docs include the explicit `reqwest` send helper and its setup/request error type. With the `tower` feature enabled, docs include `TowerRequestTelemetryLayer` for app-owned Tower/Axum request telemetry and `TowerHttpClientSpanLayer` for app-owned Tower client services. With the `tracing` feature enabled, docs include `LogBrewTracingLayer` for app-owned `tracing` event-to-log conversion plus opt-in span conversion. With the `tracing-opentelemetry` feature enabled, docs also include helpers that copy the active `tracing-opentelemetry` span context into LogBrew's dependency-free `OpenTelemetrySpanContext`. With the `opentelemetry-exporter` feature enabled, docs include `LogBrewOpenTelemetrySpanExporter` for apps that already use the OpenTelemetry SDK and want finished spans queued into an app-owned LogBrew client.

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

## Outbound HTTP Client Spans

Use `HttpClientSpan` when your Rust app owns the HTTP client call and wants one correlated outbound span plus one W3C propagation header. The dependency-free helper does not patch `reqwest`, `ureq`, Hyper, or global clients; your code sets the returned `traceparent` header on the request it already owns. If your app already uses `ureq` or `reqwest`, opt into the matching feature for a typed helper that still keeps the client app-owned.

```rust
use logbrew::{HttpClientSpan, LogBrewClient, Metadata, MetadataValue, Traceparent};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let parent = Traceparent::parse(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    )?;
    let mut metadata = Metadata::new();
    metadata.insert("retryAttempt".to_string(), MetadataValue::from(1));

    let outbound = HttpClientSpan::new(
        "https://payments.example.invalid/api/payments/:payment_id?card=sample#debug",
        "POST",
        "b7ad6b7169203331",
    )
    .with_status_code(202)
    .with_duration_ms(183.4)
    .with_metadata(metadata)
    .from_traceparent_context(&parent)?;

    // Set only this W3C header on your app-owned request.
    eprintln!("traceparent: {}", outbound.outgoing_traceparent);

    let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    client.span("evt_http_client_span", "2026-06-02T10:00:00Z", outbound.span)?;
    println!("{}", client.preview_json()?);
    Ok(())
}
```

`HttpClientSpan` strips query strings and hash fragments, reduces full URLs to route paths, normalizes methods, records status/duration metadata with source `rust_http_client`, marks `4xx`/`5xx` or `with_error_type(...)` spans as `error`, and keeps only primitive, safe metadata fields. It does not read request or response bodies, capture arbitrary transport fields, create support tickets, derive quota/usage, or own retry behavior.

If your app already uses `ureq`, enable LogBrew's `http` feature and let the helper time the call, inject the returned propagation value, queue the span, and return the original `ureq` result:

```toml
[dependencies]
logbrew = { version = "0.1", features = ["http"] }
ureq = "3"
```

```rust
let response = HttpClientSpan::new("/api/payments/:payment_id", "GET", "1111111111111111")
    .capture_ureq_call(
        &mut client,
        "evt_ureq_payment_lookup",
        "2026-06-02T10:00:01Z",
        &parent,
        |traceparent| {
            agent
                .get("https://payments.example.invalid/api/payments/123")
                .header("traceparent", traceparent)
                .call()
        },
    )?;
```

If your app already uses `reqwest`, enable LogBrew's `reqwest` feature and pass the app-owned request builder. LogBrew injects exactly one `traceparent`, times the send, queues a sanitized span, records HTTP status when available, and returns either the original `reqwest::Response` or a `ReqwestCaptureError::Request(reqwest::Error)`:

```toml
[dependencies]
logbrew = { version = "0.1", features = ["reqwest"] }
reqwest = "0.12"
```

```rust
let response = HttpClientSpan::new("/api/payments/:payment_id", "GET", "2222222222222222")
    .capture_reqwest_send(
        &mut client,
        "evt_reqwest_payment_lookup",
        "2026-06-02T10:00:02Z",
        &parent,
        reqwest_client.get("https://payments.example.invalid/api/payments/123"),
    )
    .await?;
```

If your app uses Hyper or another client built on `http::Request`/`http::Response`, enable LogBrew's `hyper` feature. The helper injects one `traceparent` into the request you already own, awaits your send closure, records response status or an error-type-only failure, and returns either the original response or a typed setup/request error. LogBrew depends only on the `http` crate for this helper, not Hyper itself:

```toml
[dependencies]
logbrew = { version = "0.1", features = ["hyper"] }
hyper = "1"
```

```rust
let response = HttpClientSpan::new("/api/payments/:payment_id", "POST", "3333333333333333")
    .capture_http_request_send(
        &mut client,
        "evt_hyper_payment_lookup",
        "2026-06-02T10:00:03Z",
        &parent,
        hyper::Request::builder()
            .method("POST")
            .uri("https://payments.example.invalid/api/payments/123")
            .body(body)?,
        |request| async move {
            // Send with your app-owned Hyper client here.
            hyper_client.request(request).await
        },
    )
    .await?;
```

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

For outbound Tower client services, the same `tower` feature also exposes `TowerHttpClientSpanLayer`. The layer injects exactly one W3C `traceparent` into the app-owned request, queues one sanitized `rust_http_client` span after the service resolves, preserves the original response/error, and does not capture request bodies, arbitrary headers, raw URLs, query strings, fragments, baggage, or tracestate.

```rust
use axum::{body::Body, http::Request};
use logbrew::{
    LogBrewClient, TowerHttpClientSpanLayer, TowerRequestIds,
};
use std::sync::{Arc, Mutex};
use tower::Layer;

let client = Arc::new(Mutex::new(
    LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?,
));
let layer = TowerHttpClientSpanLayer::new(
    client,
    |request: &Request<Body>| request.uri().path().replace("/123", "/:payment_id"),
    || {
        TowerRequestIds::new("4bf92f3577b34da6a3ce929d0e0e4736", "2222222222222222")
            .with_parent_span_id("00f067aa0ba902b7")
    },
    || "2026-06-02T10:00:11Z".to_string(),
);
let service = layer.layer(app_owned_tower_service);
```

## Actix Middleware Example

For Actix Web apps, keep telemetry in app-owned middleware and call `HttpRequestTelemetry` with Actix's matched route pattern after the handler returns. Actix stays out of the LogBrew dependency graph; your app owns the `actix-web` dependency and the middleware placement.

```bash
cargo add logbrew
cargo add actix-web --no-default-features --features macros
```

The middleware example only needs Actix's macros. Keep optional Actix features
such as cookies and compression app-owned and enable them explicitly only when
your app uses them.

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
cargo add time@=0.3.51
```

Current Rocket 0.5 fresh installs can resolve `cookie 0.18.1` with
`time 0.3.52`, which does not compile because `time` changed its parse
signature. The exact `time` pin keeps Rocket's transitive cookie parser stable
until that upstream pair is updated; it is not a LogBrew runtime dependency.

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

If your service already installs `tracing-opentelemetry`, enable `logbrew`'s `tracing-opentelemetry` feature and call `opentelemetry_span_context_from_current_tracing_span()` inside an entered span. The helper returns `None` when no valid OTel span is active; otherwise pass the copied context to `Traceparent::span_attributes_from_opentelemetry_context(...)` or `Traceparent::create_headers_from_opentelemetry_context(...)`. This is an opt-in copy bridge, not a LogBrew OpenTelemetry exporter or processor, and it does not read tracestate, baggage, span attributes, event arrays, links, payloads, headers, or raw URLs.

## OpenTelemetry Span Exporter

If your Rust service already uses `opentelemetry_sdk`, enable `opentelemetry-exporter` and install `LogBrewOpenTelemetrySpanExporter` as a normal span exporter. This queues finished OTel spans into your app-owned `LogBrewClient`; LogBrew does not create or own the OTel provider, processor, sampler, resource detectors, or transport.

```bash
cargo add logbrew --features opentelemetry-exporter
cargo add opentelemetry --no-default-features --features trace
cargo add opentelemetry_sdk --no-default-features --features trace
```

```rust
use logbrew::{
    LogBrewClient, LogBrewOpenTelemetrySpanExporter, LogBrewOpenTelemetrySpanExporterConfig,
};
use opentelemetry::{
    KeyValue,
    trace::{SpanKind, Tracer, TracerProvider},
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
        ])
        .start(&tracer);
    span.end();
    provider.force_flush()?;

    println!("{}", client.lock().unwrap().preview_json()?);
    Ok(())
}
```

The exporter copies trace ID, span ID, parent span ID, span kind, duration, instrumentation scope, and only primitive attributes explicitly allowlisted with `with_allowed_attribute_keys(...)`. Route-template strings are sanitized to remove query strings and hash fragments. It intentionally drops baggage, tracestate, arrays, payloads, arbitrary headers, full URLs, authorization values, exception messages, stack traces, SQL statements, and future unknown OTel value variants. Use this when you want LogBrew to receive spans from an existing OTel pipeline; use the `tracing-opentelemetry` context-copy helper when you only need IDs for child spans or outbound propagation.

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

## Dependency Operation Spans

Use `DependencyOperationSpan` for explicit app-owned DB, cache, and queue work that should be correlated with an existing request or OpenTelemetry span. It builds normal LogBrew `SpanEvent`s, so transport retry, flush, and shutdown behavior stays the same.

```rust
use logbrew::{DependencyOperationSpan, LogBrewClient, Traceparent};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let trace = Traceparent::parse(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    )?;
    let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    let span = DependencyOperationSpan::database("checkout lookup", "abcdef1234567890")
        .with_system("postgres")
        .with_operation("select")
        .with_target("orders")
        .with_duration_ms(8.25)
        .from_traceparent_context(&trace)?;

    client.span("evt_db_span", "2026-06-02T10:00:20Z", span)?;
    println!("{}", client.preview_json()?);
    Ok(())
}
```

The helper intentionally avoids global SQL/cache/queue patching and does not capture statements, commands, payloads, headers, raw URLs, query strings, or user-specific identifiers. Metadata uses sources such as `database.operation`, `cache.operation`, and `queue.operation`; unsafe key names and non-primitive values are dropped before the span is built. Use `with_error_type(...)` to mark a dependency span as failed without recording exception messages or stacks.

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
