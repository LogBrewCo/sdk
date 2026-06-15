# Ruby First-Useful Telemetry Comparison - 2026-06-15

This pass compared the first useful Ruby service telemetry path for a developer evaluating LogBrew against Sentry, Datadog, OpenTelemetry, and PostHog. The test used an isolated gem install on the local Ruby runtime, official docs, and public SDK source reading, then converted the practical gap into dependency-light Ruby trace context helpers and an installed-package example.

## Real install behavior

Local runtime: `ruby 2.6.10p210`.

| Package path | Version requested | Result | Files | Installed footprint | Notes |
| --- | ---: | --- | ---: | ---: | --- |
| Public `logbrew-sdk` from RubyGems | `0.1.0` | installed | 7 | 72 KiB | Current public package before this pass. |
| Local LogBrew gem after this pass | `0.1.0` | installed | 10 | 100 KiB | Adds W3C trace context helper and first-useful example. |
| `sentry-ruby` | latest | failed on Ruby version | 193 partial files | 3,280 KiB partial | Latest gem requires Ruby `>= 2.7` on this runtime. |
| `datadog` | latest | failed through dependency Ruby version | 64 partial files | 14,252 KiB partial | `ffi` dependency requires Ruby `>= 3.0` on this runtime. |
| OpenTelemetry quickstart gems | latest | failed on Ruby version | 15 partial files | 128 KiB partial | `opentelemetry-api` requires Ruby `>= 3.3` on this runtime. |
| `posthog-ruby` | latest | failed on Ruby version | 142 partial files | 1,816 KiB partial | Latest gem requires Ruby `>= 3.0` on this runtime. |

Honest status: LogBrew is materially easier to install on the current local Ruby 2.6 runtime and remains tiny after the added helper/example. This is not a full modern Ruby 3.3+ footprint comparison, because this machine only exposes system Ruby 2.6.10. The partial competitor folders are install-friction evidence, not complete package-size evidence.

## Sources reviewed

- Sentry Ruby docs: [Sentry Ruby](https://docs.sentry.io/platforms/ruby/) and [Tracing](https://docs.sentry.io/platforms/ruby/tracing/). Sentry is stronger for mature error capture, Rails integration, and trace continuation.
- Sentry source at `getsentry/sentry-ruby@63b020362fee17cea0c6ebb139f86e0045716b14`: `sentry-ruby/lib/sentry/propagation_context.rb`. The source shows first-class trace propagation context, baggage handling, and framework-owned request integration.
- Datadog docs: [Ruby tracing](https://docs.datadoghq.com/tracing/trace_collection/automatic_instrumentation/dd_libraries/ruby/) and [Ruby log correlation](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/ruby/). Datadog is stronger for automatic instrumentation and log/trace correlation once its tracer is configured.
- Datadog source at `DataDog/dd-trace-rb@7a07876ebb59c81b78958848d9bfda32c64decb1`: `lib/datadog/tracing/contrib/http/distributed/propagation.rb` and `lib/datadog/tracing/contrib/active_job/log_injection.rb`. The source confirms multiple propagation styles and framework log correlation hooks.
- OpenTelemetry docs: [Ruby](https://opentelemetry.io/docs/languages/ruby/) and [Getting started](https://opentelemetry.io/docs/languages/ruby/getting-started/). OpenTelemetry is the standards baseline for W3C propagation, spans, metrics, and exporters.
- OpenTelemetry source at `open-telemetry/opentelemetry-ruby@fd3b31c6480d7c03e31f97d071a0f90e0de8a632`: `api/lib/opentelemetry/trace/propagation/trace_context/trace_parent.rb` and `text_map_propagator.rb`. The source confirms strict `traceparent` parsing and carrier injection/extraction.
- PostHog docs: [Ruby SDK](https://posthog.com/docs/libraries/ruby). PostHog is stronger for product analytics semantics, feature flags, and event batching, but it is not a logs/traces/metrics observability-first path.
- PostHog source at `PostHog/posthog-ruby@0ab66925011c53827dc8f7496babc8d4dc102413`: `lib/posthog/client.rb`.

## What competitors do better

- Sentry has stronger Ruby/Rails error capture, framework lifecycle integration, source context, and trace continuation.
- Datadog has stronger automatic instrumentation, multi-propagation support, and framework log correlation when the tracer stack can be installed.
- OpenTelemetry has the strongest vendor-neutral standards path for teams already using collectors/exporters.
- PostHog has a richer product analytics client surface, including batching and feature-flag-oriented workflows.

## What LogBrew can now do better

- LogBrew Ruby now installs successfully on Ruby 2.6.10 with no runtime dependencies, where current latest competitor gems did not complete installation in this environment.
- LogBrew Ruby now has explicit dependency-free W3C `Traceparent` helpers that validate shape, reject forbidden/all-zero IDs, normalize IDs, expose sampled flags, create outbound propagation values, and derive LogBrew child span attributes.
- The shipped first-useful example emits release, environment, service log, product action, network milestone, `http.server.duration` histogram metric, and a W3C-linked span from one copyable app-owned flow.
- The flow remains privacy-first: no Rack/Rails global side effects, no HTTP client patching, no request/response body capture, no arbitrary transport metadata capture, and route metadata stays query/fragment-free.
- The installed gem smoke now validates the first-useful output directly and through `make run-first-useful-telemetry`, while keeping canonical six-event parity output separate.

## Changes made

- Added `ruby/logbrew-ruby/lib/logbrew/traceparent.rb`.
- Added `ruby/logbrew-ruby/examples/first_useful_telemetry.rb` and `make run-first-useful-telemetry`.
- Updated `ruby/logbrew-ruby/README.md` with first useful Ruby service telemetry and W3C trace context guidance.
- Added `scripts/check_ruby_first_useful_payload.py` to validate event order, trace/session correlation, route-template privacy, metric shape, W3C child span linkage, and outbound traceparent output.
- Expanded `scripts/real_user_ruby_smoke.sh` so unpacked and installed gems cover the new helper and example.

## Remaining honest gaps

- Ruby still lacks framework-owned Rack/Rails request helpers that continue W3C `traceparent` as deterministic child spans and emit opt-in request duration metrics.
- The local comparison could not measure latest competitor footprints on Ruby 3.3+, so a modern-runtime benchmark should be added when that toolchain is available.
- Source-map/native symbolication and backend release-artifact lookup proof remain worse than Sentry/Datadog and should not be claimed as supported.
- LogBrew’s Ruby path is intentionally explicit and app-owned. That is smaller and easier to audit, but it is not a replacement for teams that require broad transparent auto-instrumentation immediately.

## Next priority

Add a thin framework-owned Ruby request helper path that reads valid inbound W3C `traceparent`, creates a fresh child span ID, keeps route templates query-free, and makes `http.server.duration` metrics opt-in. Then run the same first-useful parity pass for Rust.
