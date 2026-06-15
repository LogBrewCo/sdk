# PHP First-Useful Telemetry Comparison - 2026-06-15

This pass compared the first useful PHP service telemetry path for a developer evaluating LogBrew against Sentry, Datadog, OpenTelemetry, and PostHog. The test used isolated Composer projects, official docs, and public SDK source reading, then converted the practical gap into dependency-light PHP helpers and installed-package verifier coverage.

## Real install footprint

| Package path | Version resolved | Direct package refs | Files | Installed footprint | Install time |
| --- | ---: | ---: | ---: | ---: | ---: |
| `logbrew/sdk` from Packagist | `0.1.0` | 1 | 399 | 3,568 KiB | 7.1s |
| Local LogBrew subtree archive after this pass | `0.1.0` | 1 | 20 | 164 KiB | checked by package smoke |
| `sentry/sentry` | `4.28.0` | 1 | 282 | 1,948 KiB | 7.2s |
| `sentry/sentry-laravel` | `4.26.0` | 1 | 2,167 | 13,424 KiB | 8.4s |
| `datadog/dd-trace` | `1.21.0` | 1 | 992 | 11,812 KiB | 7.8s |
| OpenTelemetry quickstart packages | API `1.9.0`, SDK `1.14.0`, OTLP exporter `1.4.0` | 3 | 1,144 | 6,904 KiB | 7.6s |
| `posthog/posthog-php` | `4.6.0` | 1 | 83 | 588 KiB | 7.1s |

Honest status: the current public Packagist package is smaller than Sentry Laravel, Datadog, and the OpenTelemetry quickstart set, but larger than Sentry core and PostHog PHP. The local subtree package consumed by `scripts/real_user_php_smoke.sh` is much smaller, so the next PHP release must verify the public Packagist distribution path before making footprint claims.

## Sources reviewed

- Sentry PHP docs: [Laravel trace propagation](https://docs.sentry.io/platforms/php/guides/laravel/tracing/trace-propagation/). Sentry is strong on framework-level trace continuation and Laravel request lifecycle integration.
- Sentry source at `getsentry/sentry-php@d0c1a8f9e510db803c6dded07bbdcb342e48d17e`: `src/Tracing/PropagationContext.php` and related trace context classes. The source reinforces that trace propagation is a first-class PHP SDK surface.
- Sentry Laravel source at `getsentry/sentry-laravel@fe9d07e3f4b8a09c94afac88cd241f01d14549a1`: `src/Sentry/Laravel/Tracing/Middleware.php`. The source confirms mature framework-owned request transactions, but with Laravel-specific integration weight.
- Datadog docs: [PHP tracing](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/php/) and [PHP log/trace correlation](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/php/). Datadog is strong on automatic tracing and log correlation once its extension/runtime setup is installed.
- Datadog source at `DataDog/dd-trace-php@46641ee200c2f75a19e044a84596034a0640cb68`: `src/DDTrace/Integrations/Logs/LogsIntegration.php`. The source confirms trace IDs are injected into logger context/message paths for correlation.
- OpenTelemetry docs: [PHP](https://opentelemetry.io/docs/languages/php/) and [PHP getting started](https://opentelemetry.io/docs/languages/php/getting-started/). OpenTelemetry remains the standards baseline for W3C propagation, spans, metrics, and exporters.
- OpenTelemetry source at `open-telemetry/opentelemetry-php@2f1c57fda6b2b6172e42996fe4256915a08120b7`: `src/API/Trace/Propagation/TraceContextPropagator.php` and trace context validators. The source confirms strict traceparent validation and propagation shape.
- PostHog docs: [PHP SDK](https://posthog.com/docs/libraries/php). PostHog is smaller and strong for product analytics, but it is not a logs/traces/metrics observability-first path.
- PostHog source at `PostHog/posthog-php@05c98f658df66abebebdf502b4c5ebd5a36fa2db`: `lib/Client.php`.

## What competitors do better

- Sentry has stronger PHP/Laravel framework capture, request transactions, error capture, source context, and mature trace continuation.
- Datadog has stronger automatic instrumentation and log/trace correlation when the extension and tracer are configured.
- OpenTelemetry has the best standards alignment for teams already running collectors/exporters and wanting vendor-neutral pipelines.
- PostHog has a much smaller PHP package footprint than the current public LogBrew Packagist distribution and has mature product analytics semantics.

## What LogBrew can now do better

- LogBrew PHP now has explicit dependency-free W3C `Traceparent` helpers that validate shape, reject forbidden/all-zero IDs, normalize IDs, expose sampled flags, create outbound headers, and derive LogBrew child span attributes.
- The shipped PHP first-useful example emits release, environment, service log, product action, network milestone, `http.server.duration` histogram metric, and a W3C-linked span from one copyable app-owned flow.
- The flow remains privacy-first: no Laravel middleware side effects, no global HTTP patching, no request/response payload capture, no arbitrary header capture, and route metadata stays query/fragment-free.
- The installed Composer package smoke now validates the first-useful output directly and through `make run-first-useful-telemetry`, while keeping canonical six-event parity output separate.

## Changes made

- Added `php/logbrew-php/src/Traceparent.php`, `TraceparentContext.php`, and `TraceparentSpanInput.php`.
- Added `php/logbrew-php/examples/first_useful_telemetry.php` and `make run-first-useful-telemetry`.
- Updated `php/logbrew-php/README.md` with first useful PHP service telemetry and W3C trace context guidance.
- Added `scripts/check_php_first_useful_payload.py` to verify event order, trace/session correlation, route-template privacy, metric shape, W3C child span linkage, and outbound traceparent output.
- Expanded `scripts/real_user_php_smoke.sh` so archive, install, remove/reinstall, Composer scripts, reflection docs, and installed examples cover the new helper and example.

## Remaining honest gaps

- PHP still lacks first-party Laravel/Symfony request helpers with deterministic W3C child spans, query-free route templates, and opt-in request duration metrics.
- The public Packagist distribution path is still heavier than Sentry core and PostHog PHP; verify and reduce public package contents before making footprint claims.
- Source-map/native symbolication and backend release-artifact lookup proof remain worse than Sentry/Datadog and should not be claimed as supported.
- LogBrew’s PHP path is intentionally explicit and app-owned. That is safer and easier to audit, but it is not a replacement for teams that require broad transparent auto-instrumentation immediately.

## Next priority

Reduce the PHP public package footprint, then add a thin framework-owned PHP request helper for Laravel or Symfony that preserves app response ownership, continues W3C `traceparent` as a child span, omits query strings by default, and makes request duration metrics opt-in. Continue first-useful parity for Ruby and Rust after PHP packaging is under control.
