# logbrew

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Rust SDK for creating LogBrew event batches, typed issue diagnostics, local validation, and explicit transport delivery.

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

`cargo doc --package logbrew --no-deps` documents the main `LogBrewClient`, shared context types such as `TelemetryContext` and `TelemetryResource`, sync and async context scopes, `ClientBuilder`, `AutomaticDeliveryConfig`, `DeliveryHealthSnapshot`, `SdkError`, transports, public event builders such as `MetricEvent`, typed issue helpers such as `IssueException`, `IssueStackFrame`, `IssueBreadcrumb`, and `IssueBreadcrumbBuffer`, timeline builders, HTTP/dependency/W3C helpers, and delivery lifecycle methods. Feature-gated docs cover the explicit HTTP clients, Tower/Axum request and error correlation, `tracing` logs/spans, `tracing-opentelemetry` context copying, and the OpenTelemetry span exporter.

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

## Shared Telemetry Context

Every release, environment, issue, log, span, action, and metric can carry the same schema-v1 context. Put stable service/deployment/application identity on the client, then add request- or job-local trace, opaque session, opaque subject, and low-cardinality tags in a scope:

```rust
use logbrew::{
    LogBrewClient, LogEvent, TelemetryApplication, TelemetryContext, TelemetryDeployment,
    TelemetryNamedVersion, TelemetryResource, TelemetrySessionContext,
    TelemetrySubjectContext, TelemetryTraceContext, with_telemetry_context,
};

let service = TelemetryContext::new().with_resource(
    TelemetryResource::new()
        .with_service(TelemetryNamedVersion::new("checkout-api").with_version("1.2.3"))
        .with_deployment(
            TelemetryDeployment::new()
                .with_environment("production")
                .with_release("checkout@1.2.3"),
        )
        .with_application(
            TelemetryApplication::new()
                .with_name("checkout")
                .with_version("1.2.3"),
        ),
);
let mut client = LogBrewClient::builder("checkout-api", "1.2.3")
    .api_key("LOGBREW_API_KEY")
    .context(service)
    .build()?;

let request = TelemetryContext::new()
    .with_trace(
        TelemetryTraceContext::new("4bf92f3577b34da6a3ce929d0e0e4736")
            .with_span_id("b7ad6b7169203331")
            .with_parent_span_id("00f067aa0ba902b7")
            .with_sampled(true),
    )
    .with_session(TelemetrySessionContext::new("opaque-session-id"))
    .with_subject(TelemetrySubjectContext::user("opaque-subject-id"))
    .with_tag("customer.tier", "pro");

with_telemetry_context(request, || {
    client.log(
        "evt_checkout_log",
        "2026-06-02T10:00:00Z",
        LogEvent::new("checkout failed", "error"),
    )
})??;
# Ok::<(), Box<dyn std::error::Error>>(())
```

The client adds conservative `rust` runtime, target OS family, and architecture context by default. Call `.capture_runtime_context(false)` for an explicit opt-out. It never probes or emits hostnames, process IDs, commands or arguments, environment variables, local account or path data, network/cloud identity, CPU details, or memory details.

Merge precedence is runtime defaults, client context, current scoped context, signal-derived trace identity, then an event's explicit `.with_context(...)` override. Resource sections and tags merge by field; trace, session, and subject sections replace earlier values. Tags serialize in stable key order and are capped at 32. Context strings, IDs, keys, W3C IDs, empty sections, and schema version are validated before queue admission.

`activate_telemetry_context` returns a same-thread RAII guard with idempotent `close`; nested scopes restore exactly even during panic unwinding. `with_telemetry_context_async` wraps any future and activates context only while each poll runs, so executor thread migration and concurrent tasks do not leak context. Use the async wrapper around a request or job future instead of holding the synchronous guard across `.await`.

Session and subject IDs must be application-owned opaque identifiers. Do not put email addresses, names, authentication material, raw device identifiers, IP addresses, or other direct PII in them. Tags are for bounded dimensions, not messages, URLs, payloads, stack text, or arbitrary customer data. `validate_telemetry_context` and `merge_telemetry_contexts` let applications preflight values without queueing an event.

## Typed Issue Diagnostics

Use `IssueEvent::from_error_with_mechanism` when an application catches a concrete Rust error and wants machine-readable exception identity without copying its `Display` or `Debug` text. Add caller-known code locations and request- or task-local history explicitly:

```rust
use logbrew::{
    IssueBreadcrumb, IssueBreadcrumbBuffer, IssueEvent, LogBrewClient, Metadata,
    MetadataValue,
};

let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
    .api_key("LOGBREW_API_KEY")
    .build()?;
let mut breadcrumbs = IssueBreadcrumbBuffer::new();
let mut data = Metadata::new();
data.insert(
    "routeTemplate".to_string(),
    MetadataValue::String("/checkout/{cart_id}".to_string()),
);
breadcrumbs.push(
    IssueBreadcrumb::new("2026-06-02T10:00:01Z", "http.request")
        .with_type("http")
        .with_level("error")
        .with_data(data),
);

let error = std::io::Error::other("error text is not emitted by the typed projection");
let issue = breadcrumbs.apply_to(
    IssueEvent::from_error_with_mechanism(&error, "rust.application", true)
        .with_stack_frame(
            logbrew::issue_stack_frame!()
                .with_function("checkout::submit")
                .with_in_app(true),
        ),
);
client.issue("evt_issue_checkout", "2026-06-02T10:00:02Z", issue)?;
# Ok::<(), Box<dyn std::error::Error>>(())
```

Pass a concrete error reference when exact type identity matters; a `dyn Error` trait object can expose only the trait-object type. Generated diagnostics never format the error or panic payload and never capture raw stack text, source lines, locals, arguments, or absolute paths. A frame retains only a basename, positive coordinates, and explicitly supplied bounded code identity. Frame lists are newest-first and capped at 32. Breadcrumbs are oldest-to-newest and capped at 64; each accepts at most eight flat finite primitive data fields. `IssueBreadcrumbBuffer` is caller-owned, retains the newest 64 entries, and marks the issue when older entries were evicted.

`IssueEvent::from_panic_payload` creates a privacy-safe panic projection without installing a hook. If the application already owns `std::panic::set_hook`, call `IssueEvent::from_panic_info` inside that hook to retain Rust's exact panic location. The helper does not install, replace, flush, or otherwise take ownership of the process-global panic hook.

Run the complete deterministic example locally:

```bash
cargo run --example issue_diagnostics
```

## Bounded Delivery

Every client uses one bounded FIFO queue. The defaults retain at most 1,000 events or 4 MiB of compact event JSON and send at most 100 events or 256 KiB of exact request-body bytes per batch. Configure smaller limits when building the client:

```rust
let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
    .api_key("LOGBREW_API_KEY")
    .max_queue_events(500)
    .max_queue_bytes(2 * 1024 * 1024)
    .max_batch_events(50)
    .max_request_body_bytes(128 * 1024)
    .build()?;
```

Admission returns `event_too_large` or `queue_full` without changing retained work. `flush` snapshots only the work present when it starts, acknowledges accepted prefixes, and keeps a failed prefix byte-identical ahead of later captures. Its `TransportResponse` reports transport attempts, accepted batches, and accepted events. `shutdown` closes the client only after its starting snapshot is accepted; a failed shutdown leaves the client open with all unaccepted queued work intact.

`delivery_health()` returns a content-free `DeliveryHealthSnapshot` with bounded queue and delivery counters. It never includes event data, event identifiers, API keys, endpoints, request bytes, transport errors, or status text. Cloned clients coordinate through the same queue, so they can safely capture while another clone performs transport I/O; only one flush or shutdown may run at a time.

Custom `Transport` implementations should return `TransportResponse::new(status_code)`. Constructing the response through this helper keeps custom transports compatible with client-owned delivery totals.

## Automatic Delivery

Automatic delivery is explicit and client-owned. Pass an owned transport at construction; the default manual `build`, `flush`, and `shutdown` APIs remain unchanged and start no worker.

```rust
use logbrew::{AutomaticDeliveryConfig, HttpTransport, HttpTransportConfig, LogBrewClient};
use std::time::Duration;

let transport = HttpTransport::new(HttpTransportConfig::default())?;
let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
    .api_key("LOGBREW_API_KEY")
    .build_with_owned_transport(
        transport,
        AutomaticDeliveryConfig {
            interval: Duration::from_secs(3),
            threshold: 50,
            ..AutomaticDeliveryConfig::default()
        },
    )?;

// Capture uses the same bounded queue as manual delivery. The worker starts lazily.
client.log(
    "evt_worker_started",
    "2026-06-02T10:00:00Z",
    logbrew::LogEvent::new("worker started", "info"),
)?;

// Explicit flush clears automatic pause/backoff and uses the owned transport.
client.flush_owned()?;
client.shutdown_owned()?;
# Ok::<(), Box<dyn std::error::Error>>(())
```

The worker coalesces threshold and interval wakes, keeps one delivery in flight, and reuses the queue's immutable failed prefix. Retryable network, timeout, and server exhaustion use capped equal-jitter backoff. Authentication, quota, and other terminal rejection categories pause automatic delivery until `flush_owned` explicitly retries. No response headers or response text are parsed.

`shutdown_owned` is the explicit join-and-drain point: it stops and joins scheduling before draining its starting queue snapshot once. A failed shutdown leaves the client open with unaccepted work retained; a successful shutdown closes it. Dropping the final client owner only requests that the worker stop and does not promise an implicit flush or an unbounded wait for in-flight transport I/O. Owned transports should therefore use bounded I/O, and applications should call `shutdown_owned` when delivery at shutdown is required.

Automatic health adds only fixed lifecycle facts to `DeliveryHealthSnapshot`: whether automatic delivery is enabled/running, in-flight/coalesced state, consecutive failures, pause reason, and bounded retry delay. It does not add event content, identifiers, endpoints, status values, server text, or transport details.

## First Useful Service Telemetry

For a Rust service, emit release and environment identity once per deployment. Within each request or job, combine a canonical-severity log, meaningful product/network actions, an aggregate-ready metric, and the exact causal span. The shared scope makes those different signals one investigation timeline without repeating trace or session IDs in flat metadata:

```rust
use logbrew::{
    LogBrewClient, LogEvent, MetricEvent, TelemetryContext, TelemetrySessionContext,
    TelemetryTraceContext, with_telemetry_context,
};

let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
    .api_key("LOGBREW_API_KEY")
    .build()?;
let request = TelemetryContext::new()
    .with_trace(
        TelemetryTraceContext::new("4bf92f3577b34da6a3ce929d0e0e4736")
            .with_span_id("b7ad6b7169203331")
            .with_parent_span_id("00f067aa0ba902b7")
            .with_sampled(true),
    )
    .with_session(TelemetrySessionContext::new("opaque-session-id"));

with_telemetry_context(request, || -> Result<(), logbrew::SdkError> {
    client.log(
        "evt_log_checkout_started",
        "2026-06-02T10:00:02Z",
        LogEvent::new("checkout request started", "info").with_logger("checkout"),
    )?;
    client.metric(
        "evt_metric_http_server_duration",
        "2026-06-02T10:00:05Z",
        MetricEvent::new("http.server.duration", "histogram", 183.4, "ms", "delta"),
    )?;
    Ok(())
})??;
```

Metrics answer questions across many events—rate, latency distribution, saturation, and change after a release—while a span explains one execution and logs/actions explain what happened inside it. Do not use a metric as a substitute for the trace or attach high-cardinality request, user, or session values as metric tags.

The runnable [`first_useful_telemetry.rs`](examples/first_useful_telemetry.rs) example emits release, environment, log, product action, network milestone, request-duration metric, and request span as one schema-valid envelope. It uses route templates, primitive bounded metadata, and canonical severities (`info`, `warning`, `error`, `critical`), and excludes account-specific values, payloads, arbitrary headers, query strings, fragments, full URLs, direct PII, and sensitive values.

## HTTP Server Request Telemetry

For Axum, Tower, Actix, Rocket, or a custom Rust server, keep request capture in your app-owned middleware and pass stable route metadata into `HttpRequestTelemetry`. The helper builds a request span plus an optional `http.server.duration` metric without installing framework middleware, patching HTTP clients, or capturing payloads/headers.

```rust
use logbrew::{
    HttpRequestTelemetry, LogBrewClient, TelemetryContext, TelemetryNamedVersion,
    TelemetryResource,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    let request = HttpRequestTelemetry::new(
        "https://api.example.invalid/checkout/:cart_id?coupon=sample#review",
        "post",
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_incoming_traceparent(incoming)
    .with_status_code(202)
    .with_duration_ms(183.4)
    .with_context(TelemetryContext::new().with_resource(
        TelemetryResource::new()
            .with_service(
                TelemetryNamedVersion::new("checkout-service").with_version("1.2.3"),
            )
            .with_framework(TelemetryNamedVersion::new("axum")),
    ))
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

`HttpRequestTelemetry` strips query strings and hash fragments from route templates, normalizes HTTP methods, adds primitive metadata such as `routeTemplate`, `method`, `statusCode`, and `statusCodeClass`, treats valid incoming W3C `traceparent` values as parent context, and falls back to the explicit app trace ID when propagation is missing or malformed. Its span and optional metric receive the same typed service/framework and effective trace/span/parent/sampled context, so either signal can lead an investigator to the exact request. It does not create backend setup state, inspect account sessions, capture arbitrary headers, or read request/response bodies.

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
    LogBrewClient, TelemetryContext, TelemetryNamedVersion, TelemetryResource,
    TowerRequestIds, TowerRequestTelemetryLayer,
};
use std::sync::{Arc, Mutex};

fn logbrew_layer(
    client: Arc<Mutex<LogBrewClient>>,
) -> TowerRequestTelemetryLayer<
    impl Fn(&Request<Body>) -> String + Clone,
    impl Fn() -> TowerRequestIds + Clone,
    impl Fn() -> String + Clone,
> {
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
    .with_context(TelemetryContext::new().with_resource(
        TelemetryResource::new()
            .with_service(
                TelemetryNamedVersion::new("checkout-service").with_version("1.2.3"),
            )
            .with_framework(TelemetryNamedVersion::new("axum")),
    ))
    .with_error_issues()
}
```

Attach the layer with `Router::route(...).route_layer(logbrew_layer(client.clone()))`, keep the LogBrew client in your own state management, generate unique trace/span IDs per request, and flush on your normal lifecycle boundary. When a service returns an error, the layer queues an error span and duration metric subject to the client's normal validation and queue limits. `with_error_issues()` additionally queues one typed issue with the same trace/span IDs, `tower.service` mechanism, `handled: false`, and a sanitized route-template breadcrumb, then returns the original service error unchanged. The automatic issue declares that stack frames are missing because middleware cannot recover the original throw site; attach a caller frame through the explicit issue API when application code owns that location. Leave issue capture off when another integration already owns the same failure.

The layer reads only the W3C `traceparent` propagation header and framework-owned route/status metadata. It does not format the service error or capture arbitrary headers, raw request URIs, query strings, payloads, account session values, or user-specific identifiers.

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
use logbrew::{
    HttpRequestTelemetry, LogBrewClient, TelemetryContext, TelemetryNamedVersion,
    TelemetryResource,
};
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
    let mut telemetry = HttpRequestTelemetry::new(
        route_template,
        method,
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_status_code(response.status().as_u16())
    .with_duration_ms(started.elapsed().as_secs_f64() * 1000.0)
    .with_context(TelemetryContext::new().with_resource(
        TelemetryResource::new()
            .with_service(
                TelemetryNamedVersion::new("checkout-service").with_version("1.2.3"),
            )
            .with_framework(TelemetryNamedVersion::new("actix-web")),
    ));
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
use logbrew::{
    HttpRequestTelemetry, LogBrewClient, TelemetryContext, TelemetryNamedVersion,
    TelemetryResource,
};
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
                let mut telemetry = HttpRequestTelemetry::new(
                    route_template,
                    request.method().to_string(),
                    "11111111111111111111111111111111",
                    "b7ad6b7169203331",
                )
                .with_status_code(response.status().code)
                .with_duration_ms(started.elapsed().as_secs_f64() * 1000.0)
                .with_context(TelemetryContext::new().with_resource(
                    TelemetryResource::new()
                        .with_service(
                            TelemetryNamedVersion::new("checkout-service")
                                .with_version("1.2.3"),
                        )
                        .with_framework(TelemetryNamedVersion::new("rocket")),
                ));
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
use logbrew::{
    LogBrewClient, LogBrewTracingLayer, TelemetryContext, TelemetryDeployment,
    TelemetryNamedVersion, TelemetryResource,
};
use std::sync::{Arc, Mutex};
use tracing_subscriber::prelude::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .context(TelemetryContext::new().with_resource(
                TelemetryResource::new()
                    .with_service(
                        TelemetryNamedVersion::new("checkout-service")
                            .with_version("1.2.3"),
                    )
                    .with_deployment(
                        TelemetryDeployment::new().with_environment("production"),
                    ),
            ))
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

`LogBrewTracingLayer` maps `trace`/`debug` to `info`, `warn` to `warning`, and `error` to `error`. Every converted log and span carries typed `tracing` framework identity plus configured service/deployment context. Work inside a span also carries exact typed trace, span, parent, and sampled identity, while the existing primitive correlation fields remain for wire compatibility. The layer records `tracingTarget` and `tracingLevel`, but only copies additional primitive fields that your app allowlists with `with_allowed_fields(...)`; route-template field values are sanitized to remove query strings and hash fragments. With `with_span_events()`, the layer continues a valid `traceparent` or `trace_parent` field on a root span, generates W3C-shaped child span IDs, records parent/child links, marks the current span as `error` when an error-level event is emitted inside it, and adds privacy-bounded event summaries such as `tracingSpanEventCount`, `tracingSpanErrorEventCount`, `tracingLastErrorLevel`, and `tracingLastErrorTarget` to the closed span. Malformed trace context is ignored non-fatally and the raw propagation field is not emitted as metadata. Span event summaries intentionally do not copy error messages, stacks, payloads, headers, or arbitrary event fields. Do not allowlist payloads, headers, account session values, raw URLs, or user-specific identifiers.

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

The exporter copies trace ID, span ID, parent span ID, sampled state, span kind, duration, instrumentation scope, and only primitive attributes explicitly allowlisted with `with_allowed_attribute_keys(...)`. It also maps configured or resource-provided OTel service name/version and deployment environment into the shared typed resource context, and writes the same exact trace/span/parent/sampled identity into typed trace context. Route-template strings are sanitized to remove query strings and hash fragments. It intentionally drops baggage, tracestate, arrays, payloads, arbitrary headers, full URLs, authorization values, exception messages, stack traces, SQL statements, and future unknown OTel value variants. Use this when you want LogBrew to receive spans from an existing OTel pipeline; use the `tracing-opentelemetry` context-copy helper when you only need IDs for child spans or outbound propagation.

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

For dependency work where a panic would otherwise hide the failed span, use the explicit `capture_panic(...)` helper around app-owned work. It queues an ok span on success, queues an error span with only `exception.type=panic`, `panic=true`, and a type-level `panicType` on panic, then resumes the original unwind. It does not install a global panic hook and does not record panic messages, stacks, SQL, cache keys, payloads, headers, baggage, or tracestate.

## Metrics

Use `MetricEvent` for explicit app-owned measurements such as counters, gauges, and histograms. A metric is the aggregatable view of behavior over time: use it to compare request volume, error rate, latency distributions, queue depth, or business throughput across releases and environments. Use logs and actions for discrete facts and spans for one execution path; metrics should answer trends and thresholds across many executions.

Metrics are not captured automatically. Put stable service/deployment identity on the client and only bounded dimensions such as route template, operation, region, or status class in metadata/tags. Avoid raw URLs, query strings, event IDs, trace IDs, session IDs, user IDs, request or response payloads, headers, and free-form text as metric dimensions. A metric may still inherit scoped trace/session context for investigation linkage, but backends should aggregate only the explicitly selected low-cardinality dimensions.

```rust
use logbrew::{LogBrewClient, MetricEvent};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.metric(
        "evt_metric_001",
        "2026-06-02T10:00:06Z",
        MetricEvent::new("checkout.request.duration", "histogram", 42.5, "ms", "delta")
            .with_description("Duration of one completed checkout request."),
    )?;

    println!("{}", client.preview_json()?);
    Ok(())
}
```

Metric kinds are `counter`, `gauge`, and `histogram`. Gauge metrics use `instant` temporality; counter and histogram metrics use `delta` or `cumulative` temporality and must be non-negative. An optional `with_description(...)` gives people and investigation tools the stable meaning of the measurement. Keep it generic, single-line, between 1 and 1,024 Unicode scalar values, and free of identifiers, personal data, or changing values. It is not a query dimension.

## Product And Network Timelines

Use `ProductTimeline` when your app already knows the product step or API milestone that matters and you want an agent-readable timeline without recording a visual session replay:

```rust
use logbrew::{
    LogBrewClient, ProductTimeline, TelemetryContext, TelemetrySessionContext,
    TelemetryTraceContext,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let timeline_context = TelemetryContext::new()
        .with_trace(TelemetryTraceContext::new(
            "4bf92f3577b34da6a3ce929d0e0e4736",
        ))
        .with_session(TelemetrySessionContext::new("opaque-session-id"));

    client.action(
        "evt_checkout_submit",
        "2026-06-02T10:00:07Z",
        ProductTimeline::product_action("checkout.submit")
            .with_route_template("/checkout/:cart_id")
            .with_context(timeline_context.clone())
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
            .with_context(timeline_context)
            .build()?,
    )?;

    println!("{}", client.preview_json()?);
    Ok(())
}
```

The builders return normal `ActionEvent` values, so they work with the existing queue, preview, flush, and retry behavior. Explicit `.with_context(...)` is the preferred typed correlation path. The older `.with_session_id(...)` and `.with_trace_id(...)` helpers remain compatible; valid W3C trace IDs and session IDs are promoted into typed context while their legacy primitive metadata stays available. The builders accept only primitive metadata, copy it defensively, strip query strings and hashes from route templates, reduce full HTTP URLs to paths, normalize HTTP methods, and infer failed network milestones from `4xx`/`5xx` status codes. They do not patch HTTP clients, capture request or response payloads, capture arbitrary headers, auto-capture clicks, or claim visual replay.

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
