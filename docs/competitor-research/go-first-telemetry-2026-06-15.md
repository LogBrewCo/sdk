# Go First Useful Telemetry Competitor Check - 2026-06-15

## Scope

Tested the first useful Go backend telemetry path from a real user perspective: create a fresh module, install the package from a clean module cache, inspect current official docs/source, and compare the amount of work needed to emit useful logs, product actions, network milestones, metrics, and W3C-linked spans.

Local toolchain: `go version go1.24.5 darwin/arm64`.

## Clean Install Footprint

Measured with isolated temporary apps, isolated `GOMODCACHE`, `GOPROXY=https://proxy.golang.org,direct`, and `go get ...@latest` or the latest published LogBrew Go version. File and size counts use the resolved module directories from `go list -m -json all`, excluding the root app and Go download cache.

| SDK path | Version resolved | Install time | Modules | Files | Source footprint |
| --- | ---: | ---: | ---: | ---: | ---: |
| `github.com/LogBrewCo/sdk/go/logbrew` | `v0.1.1` | 3.4s | 1 | 13 | 76 KiB |
| `github.com/getsentry/sentry-go` | `v0.46.2` | 9.8s | 17 | 1,223 | 49,368 KiB |
| `github.com/DataDog/dd-trace-go/v2/ddtrace/tracer` | `v2.8.2` | 16.3s | 262 | 6,643 | 76,552 KiB |
| OpenTelemetry Go quickstart packages | `otel v1.44.0`, `otelhttp v0.69.0` | 9.3s | 30 | 1,844 | 34,983 KiB |
| `github.com/posthog/posthog-go` | `v1.15.0` | 1.9s | 15 | 869 | 12,462 KiB |

Datadog's latest tracer install also triggered an automatic `go1.25.0` toolchain download in a fresh app, which is real adoption friction for teams pinned to older local toolchains.

## Sources Reviewed

- Sentry Go docs: [docs.sentry.io/platforms/go](https://docs.sentry.io/platforms/go/) and public source docs in [getsentry/sentry-go](https://github.com/getsentry/sentry-go). Sentry covers errors and performance tracing well, but its setup examples add tracing config early and include `SendDefaultPII` guidance that can collect request headers/IP when enabled.
- Datadog Go tracing docs: [trace collection for Go](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/go/), [log/trace correlation for Go](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/go/), and public source in [DataDog/dd-trace-go](https://github.com/DataDog/dd-trace-go). Datadog is powerful but heavy, agent-oriented, and correlation often requires tracer/agent/log pipeline setup.
- OpenTelemetry Go docs: [getting started](https://opentelemetry.io/docs/languages/go/getting-started/). OTel is standards-aligned and strong for traces/metrics, but the first-useful path requires multiple packages/providers/exporters and the logs signal remains a more advanced setup concern.
- PostHog Go docs: [posthog.com/docs/libraries/go](https://posthog.com/docs/libraries/go). PostHog has a simple product analytics queue and flush story, but it is not a backend observability SDK for logs, metrics, W3C request spans, or trace/log correlation.

## What LogBrew Is Better At Today

- Install weight is substantially lower: 76 KiB/13 files for LogBrew Go versus multi-MiB competitor installs for comparable first telemetry attempts.
- The SDK is dependency-free and app-owned. It does not patch global HTTP clients, install a background agent, or require framework auto-instrumentation to emit the first useful payload.
- The Go first-useful example now emits release, environment, service log, product action, network milestone, `http.server.duration` histogram metric, and a W3C-linked request span from one copyable app.
- Route privacy is stricter by default for timeline helpers: full URLs are reduced to path-only route templates, nested metadata is dropped, and payload/header capture is not part of the API.
- Trace propagation is lightweight: `ParseTraceparent`, `SpanAttributesFromTraceparent`, and `CreateTraceparent` cover the common W3C continuation path without pulling in OpenTelemetry.

## Where Competitors Are Still Ahead

- Sentry and Datadog still beat LogBrew on mature source-map/native symbolication, release artifact upload, stack trace grouping, profiling, and broad framework auto-instrumentation.
- OpenTelemetry is stronger when teams already standardize on OTLP collectors and vendor-neutral trace/metric pipelines.
- Datadog and Sentry provide deeper production troubleshooting workflows once their agents, dashboards, source maps, and integrations are fully configured.

## Changes Made From This Pass

- Added `go/logbrew/examples/first_useful_telemetry/main.go` as an installed-artifact example that emits the first useful Go service payload without unsafe automatic capture.
- Updated `go/logbrew/README.md` with first-useful telemetry guidance and explicit privacy boundaries.
- Updated `go/logbrew/examples/Makefile` with `make run-first-useful-telemetry`.
- Updated `scripts/real_user_go_smoke.sh` and `scripts/check_go_first_useful_payload.py` so package smoke verification checks the example is shipped, runnable from the extracted module, schema-valid, W3C-correlated, and free of query string, payload, and header leakage.

## Next Priorities

- Add the same first-useful installed proof to Java, .NET, PHP, Ruby, and Rust so all core SDKs can be judged by real user telemetry usefulness, not only parity fixtures.
- Keep source-map/native symbolication claims blocked until backend upload/storage/lookup proof exists.
- For Go specifically, evaluate app-owned `net/http` helper examples next, but avoid global transport patching or request payload/header capture by default.
