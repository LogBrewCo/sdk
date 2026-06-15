# Java First-Useful Telemetry Comparison - 2026-06-15

This pass compared the first useful Java backend telemetry path for a developer evaluating LogBrew against Sentry, Datadog, OpenTelemetry, and PostHog. The local environment did not have `mvn`, so the clean install-footprint check used a temporary Gradle project with an isolated Gradle cache, `mavenCentral()`, and copied resolved artifacts into per-vendor directories.

## Real install footprint

| Package path | Resolved artifact path | Files | Size | Jar entries |
| --- | --- | ---: | ---: | ---: |
| LogBrew Java | `co.logbrew:logbrew-sdk:0.1.0` | 1 | 36.3 KiB | 30 |
| Sentry Java core | `io.sentry:sentry:8.43.2` | 1 | 1,192.9 KiB | 800 |
| Datadog Java tracer | `com.datadoghq:dd-java-agent:1.63.0` | 1 | 33,271.6 KiB | 18,733 |
| OpenTelemetry Java agent | `io.opentelemetry.javaagent:opentelemetry-javaagent:2.28.1` | 1 | 23,643.6 KiB | 16,097 |
| PostHog Java server | `com.posthog:posthog-server:2.7.0` | 9 | 3,712.2 KiB | 2,097 |

LogBrew is materially lighter for app-owned telemetry: one dependency-free runtime jar when optional Logback dependencies are not used. This is a product advantage only if the SDK also shows a useful first payload quickly, which was the gap this cycle addressed.

## Sources reviewed

- Sentry Java docs: [Sentry for Java](https://docs.sentry.io/platforms/java/), [configuration options](https://docs.sentry.io/platforms/java/configuration/options/), and [capturing errors](https://docs.sentry.io/platforms/java/usage/). Sentry has a mature global SDK model, release/environment options, filtering hooks, request body defaults, flush/close behavior, and strong framework coverage.
- Sentry source at `getsentry/sentry-java@aab75f770bf249460a877aeacdca4902d0ad8929`: `sentry/src/main/java/io/sentry/Sentry.java` and `sentry/src/main/java/io/sentry/SentryOptions.java`. The source confirms a global static API surface plus options for before-send filtering and flush/close behavior.
- Datadog docs: [Java tracing setup](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/java/), [Java logs and traces correlation](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/java/), and [Java tracer configuration](https://docs.datadoghq.com/tracing/trace_collection/library_config/java/). Datadog is strong on automatic tracing/log correlation, but the first path centers on a large Java agent and Datadog Agent setup.
- Datadog source at `DataDog/dd-trace-java@9b642bd103ac9f4ea85fdaa4c341db7a07bb591f`: `dd-trace-api/src/main/java/datadog/trace/api/CorrelationIdentifier.java` plus public docs around bytecode auto-instrumentation. This reinforces the correlation value but also the agent/runtime-instrumentation cost.
- OpenTelemetry docs: [Getting Started by Example](https://opentelemetry.io/docs/languages/java/getting-started/). The official first path is standards-aligned and emits traces, metrics, and logs, but uses Spring Boot plus the Java agent for the less-than-five-minute experience.
- OpenTelemetry source at `open-telemetry/opentelemetry-java-instrumentation@172a70528b1c9f1e6f4edb36b0f4164e25bb5d60`: `README.md` documents the Java agent attaching to an application and injecting bytecode to capture telemetry.
- PostHog docs: [Java SDK](https://posthog.com/docs/libraries/java). PostHog is strong on product analytics, feature flags, batching, and shutdown guidance, but its Java path is not a logs/traces/metrics observability-first path.
- PostHog source at `PostHog/posthog-java@dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e`: `posthog/src/main/java/com/posthog/java/PostHog.java` shows capture/enqueue/shutdown behavior in the underlying library.

## What competitors do better

- Sentry and Datadog have mature framework auto-capture and production battle-tested error paths that LogBrew still does not match.
- Datadog and OpenTelemetry have stronger automatic trace/log correlation when a Java agent is acceptable.
- Sentry and Datadog still have better source context, profiling, and deep framework integrations.
- PostHog has a broader product analytics workflow including identity, flags, experiments, and local evaluation.

## What LogBrew can now do better

- The Java core remains dependency-light and app-owned: no Java agent, no global HTTP patching, no automatic request body capture, and no arbitrary header capture.
- The new first-useful Java example emits release, environment, service log, product action, network milestone, `http.server.duration` histogram metric, and a W3C-linked span from one copyable app.
- The new `Traceparent` helper validates W3C shape, rejects forbidden/all-zero IDs, normalizes IDs, exposes sampled flags, creates outbound `traceparent` carriers, and derives LogBrew span attributes with primitive metadata only.
- Product and network milestones stay agent-readable without visual replay: they use route templates, method/status/duration, session ID, trace ID, and primitive metadata while stripping query/hash text.

## Changes made

- Added `java/logbrew-java/src/main/java/co/logbrew/sdk/Traceparent.java` with dependency-free W3C traceparent parse/create/header/span helpers.
- Added `java/logbrew-java/examples/FirstUsefulTelemetry.java`, a packaged first-useful service payload example.
- Updated `java/logbrew-java/README.md` with first-useful telemetry and W3C trace context guidance.
- Updated `java/logbrew-java/examples/Makefile`, `scripts/check_java_package.sh`, and `scripts/real_user_java_smoke.sh` so package and installed-source proof covers the new example and trace helper.
- Added `scripts/check_java_first_useful_payload.py` to verify event order, trace/session correlation, route-template privacy, metric shape, W3C child span linkage, and outbound traceparent output.

## Remaining honest gaps

- Java still lacks a first-party Spring MVC/Spring Boot request wrapper with deterministic W3C child spans, opt-in request duration metrics, and query-free route-template capture comparable to JS/Python framework packages.
- Java still does not have source-context upload or symbolication proof comparable to Sentry/Datadog.
- LogBrew's Java path is intentionally explicit. That is safer and lighter, but it is not a substitute for Datadog/OpenTelemetry auto-instrumentation in teams that need broad transparent framework coverage immediately.

## Next priority

Add the same first-useful installed proof to .NET, PHP, Ruby, and Rust. For Java specifically, the next high-value gap is a thin Spring Boot request capture helper that preserves app response ownership, continues W3C traceparent as a child span, omits query strings by default, and makes request duration metrics opt-in.
