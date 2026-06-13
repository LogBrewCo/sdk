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

`cargo doc --package logbrew --no-deps` documents the main `LogBrewClient`, `ClientBuilder`, `SdkError`, `Transport`, `RecordingTransport`, `TransportResponse`, `TransportError`, public event builders such as `MetricEvent`, timeline builders such as `ProductTimeline`, and lifecycle helpers such as `pending_events`, `flush`, `shutdown`, and `preview_json`. With the `http` feature enabled, docs also include `DEFAULT_HTTP_ENDPOINT`, `HttpTransportConfig`, and `HttpTransport`.

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
