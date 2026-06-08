# logbrew

Public Rust SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
cargo add logbrew
cargo add logbrew --features http
cargo check
cargo tree --depth 1
cargo doc --package logbrew --no-deps
cd examples && make
cd examples && make run-readme-example
cd examples && make run
cd examples && make run-real-user-smoke
cargo run --example readme_example -p logbrew
cargo run --example real_user_smoke -p logbrew
```

`cargo doc --package logbrew --no-deps` documents the main `LogBrewClient`, `ClientBuilder`, `SdkError`, `Transport`, `RecordingTransport`, `TransportResponse`, `TransportError`, public event builders, and lifecycle helpers such as `pending_events`, `flush`, `shutdown`, and `preview_json`. With the `http` feature enabled, docs also include `DEFAULT_HTTP_ENDPOINT`, `HttpTransportConfig`, and `HttpTransport`.

For Automation Agents

- Run `cargo tree --depth 1` to confirm the app depends on `logbrew`.
- Run `cd examples && make` to print available example commands, `make run-readme-example` for the README payload, and `make run` or `make run-real-user-smoke` for the fuller local flow.
- In a consumer app, `cargo check --locked`, `cargo test --locked`, and `cargo run --locked` are practical checks for install, examples, and lockfile consistency.

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

Use a clearly fake placeholder like `LOGBREW_API_KEY` in local examples and tests. Call `flush` or `shutdown` to send queued events through a transport, and use `preview_json` when you want a stable local JSON preview without sending anything.

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
