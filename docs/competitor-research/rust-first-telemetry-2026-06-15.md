# Rust First Useful Telemetry Comparison - 2026-06-15

## Scope

Tested the first useful Rust service telemetry path from a real user perspective: create a new Cargo app, install the package from crates.io with an isolated Cargo home, inspect current official docs and public source, and compare the effort needed to emit useful release, environment, log, product action, network milestone, metric, and W3C-linked span telemetry.

## Real Install Footprint

Measured with Cargo 1.94.1 and Rust 1.94.1 using a fresh Cargo home per package. Cache size is included because Cargo stores downloaded registry sources outside the app directory.

| Package set | Version tested | Result | Lock entries | Cargo cache | Notes |
| --- | --- | --- | ---: | ---: | --- |
| LogBrew `logbrew` | `0.1.0` | installed | 13 | 9,552 KiB / 527 files | Dependency-light core with no default HTTP feature. |
| Sentry `sentry` | `0.48.2` | installed | 268 | 464,876 KiB / 19,866 files | Richer tracing, panic, release-health, debug-image, transport defaults. |
| OpenTelemetry quickstart set | `opentelemetry` `0.32.0`, `opentelemetry_sdk` `0.32.1`, `opentelemetry-stdout` | installed | 46 | 44,592 KiB / 2,531 files | Strong standards baseline, more setup pieces. |
| Datadog `ddtrace` | `0.2.1` | installed | 162 | 148,528 KiB / 9,218 files | Preview Rust tracing path; more dependencies. |
| PostHog `posthog-rs` | `0.12.0` | installed | 261 | 460,628 KiB / 16,652 files | Product analytics/error-tracking client, not full observability. |

## Competitor Findings

- Sentry docs: [Rust](https://docs.sentry.io/platforms/rust/) and [tracing instrumentation](https://docs.sentry.io/platforms/rust/tracing/instrumentation/). Sentry is much richer for panic/error capture, release health, tracing integration, and debug-image workflows.
- Sentry source at `getsentry/sentry-rust@e33b7ff20eb5bf948eacf89d7eecdcc59b31d4f3`: `sentry-tracing/src/converters.rs`, `sentry-tracing/src/layer/mod.rs`, and `sentry-core/src/performance.rs` show tracing-layer conversion, log/event correlation, and distributed tracing headers. Sentry uses its own `sentry-trace` flow rather than a minimal W3C-only helper.
- OpenTelemetry docs: [Rust getting started](https://opentelemetry.io/docs/languages/rust/getting-started/). OpenTelemetry remains the standards baseline for W3C trace propagation, spans, metrics, and logs, but the first-useful hosted-service path requires multiple crates and exporter/provider setup.
- OpenTelemetry source at `open-telemetry/opentelemetry-rust@c14b570d42377f4c331e32b93897361e47fb7ccf`: `opentelemetry-sdk/src/propagation/trace_context.rs` validates and injects W3C `traceparent`; `opentelemetry-sdk/src/logs/record.rs` keeps trace context on logs.
- Datadog docs: [Rust library](https://docs.datadoghq.com/tracing/trace_collection/automatic_instrumentation/dd_libraries/rust/) and [ddtrace crate docs](https://docs.rs/ddtrace/latest/ddtrace/). Datadog Rust is explicitly preview-stage, with more setup and agent-oriented tracing behavior.
- Datadog source at `DataDog/dd-trace-rs@0d1d982f0464318f5c1a21c2db1c84b58ff2c95c`: `docs/repo_structure.md` describes tracing, metrics, logs, and W3C propagation components.
- PostHog crate docs: [posthog-rs](https://docs.rs/posthog-rs/latest/posthog_rs/). PostHog is useful for product analytics and error tracking, but does not cover logs, W3C request spans, service metrics, or trace/log correlation as a backend observability SDK.

## LogBrew Improvements From This Pass

- LogBrew Rust now has explicit dependency-free W3C `Traceparent` helpers that validate shape, reject forbidden/all-zero IDs, normalize IDs, expose sampled flags, create outbound `traceparent` carriers, and derive child span events.
- The packaged Rust first-useful example emits release, environment, service log, product action, network milestone, `http.server.duration` histogram metric, and a W3C-linked span from one copyable app-owned flow.
- `Metadata` and `MetadataValue` aliases are public, so users can attach primitive metadata without adding `serde_json` as an explicit app dependency.
- The installed crate smoke validates direct example output, `make run-first-useful-telemetry`, and a generated consumer app that copies the packaged example while keeping canonical six-event parity output separate.

## Where LogBrew Is Better Today

- Much smaller first install than Sentry, Datadog, OpenTelemetry quickstart, and PostHog Rust in fresh Cargo-home measurements.
- Simpler first-useful hosted-service path for apps that want logs, product timeline signals, network milestones, metrics, and request spans without a tracing stack, global HTTP patching, payload capture, or header capture.
- Stronger privacy posture by default: route templates are explicit and query/hash-free, metadata must be primitive, and examples use placeholder ingest keys instead of account/session bearer values.

## Where LogBrew Is Still Worse

- No automatic Rust framework instrumentation yet for Axum, Actix, Rocket, or Tower layers.
- No native Rust `tracing` subscriber/layer integration yet, so users must call LogBrew explicitly instead of bridging existing spans/logs.
- Source-map/native symbolication remains a broader product gap compared with Sentry and Datadog.
- Backend-owned setup status, usage/quota APIs, and project-scoped write-only ingest configuration are still contract-pending, so SDK dogfooding remains pending.

## Next Focus

The thin app-owned Rust request helper now exists as `HttpRequestTelemetry`; see `docs/competitor-research/rust-http-server-request-2026-06-15.md`. Next, add one installed Axum or Tower mini-app smoke example that shows the exact middleware glue, then evaluate a `tracing` bridge that reports capture failures without interrupting application logging.
