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

That `cargo doc` path should expose the crate summary plus the main `LogBrewClient`, `ClientBuilder`, `SdkError`, `Transport`, `RecordingTransport`, `TransportResponse`, `TransportError`, public batch-shape structs, and public event-builder rustdoc pages after install, including queue and lifecycle helpers like `pending_events`, `flush`, `shutdown`, and `preview_json`.
With `cargo add logbrew --features http`, the same docs should also expose `DEFAULT_HTTP_ENDPOINT`, `HttpTransportConfig`, and `HttpTransport` so users can send queued batches through a blocking HTTP transport without changing the default lightweight install.
The packaged crate should also keep its `README.md` plus core `Cargo.toml` metadata such as package name, version, license, repository, readme path, keywords, and categories, and a fresh temp app should still build correctly when it depends on the extracted packaged crate contents instead of the live repo source. A separate temp lifecycle app should also be able to add the crate through `cargo add --path`, remove it cleanly with `cargo remove logbrew`, prove that both `Cargo.toml`, `Cargo.lock`, locked metadata, and the dependency tree drop the crate, then add it back again before the main runtime smoke flow starts. That main temp app should also be able to add the crate through `cargo add --path`, keep the expected dependency entry in its `Cargo.toml`, and generate a `Cargo.lock` that keeps the expected local `logbrew` package entry plus the app-to-crate dependency edge a user would commit after install. That generated lockfile should also be strong enough to drive `cargo pkgid logbrew` for the resolved crate identity, `cargo metadata --locked`, including the resolved root package and `smoke-app -> logbrew` dependency edge, plus a `cargo tree --locked --depth 1 --charset ascii` view that still shows the temp app root and direct `logbrew` child, and `cargo fetch --locked`, `cargo check --locked`, `cargo build --locked`, `cargo test --locked`, `cargo doc --locked`, and later `cargo run --locked` checks without any dependency drift. The temp app should also be able to keep those installed-user commands behind a local `.cargo/config.toml` alias layer so the consumer-owned command surface is proved alongside the raw cargo behavior.
That locked run path should also include a temp binary that mirrors the published README example, and the packaged `.crate` should still ship `examples/readme_example.rs`, `examples/real_user_smoke.rs`, plus a tiny `examples/Makefile` wrapper so the shipped README example is proven directly from the extracted release artifact through raw `cargo run --example readme_example` and through `make run-readme-example`, while the stronger shipped example is proven through both raw `cargo run --example real_user_smoke` and the helper-backed `make run` or `make run-real-user-smoke` commands. That helper surface should also be discoverable enough that plain `make` prints copy-pasteable commands for both shipped example paths instead of only the stronger one, and the packaged README should teach those helper commands explicitly instead of leaving them as an inferred artifact feature.

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
