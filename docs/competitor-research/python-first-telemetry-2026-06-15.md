# Python First Telemetry Comparison, 2026-06-15

## Scope

This pass compared the first useful Python observability path for a developer evaluating LogBrew against Sentry, Datadog, OpenTelemetry, and PostHog. The goal was to test what a real Python service gets after install: logs, traces, metrics, release/environment context, product workflow signals, privacy behavior, and package friction.

## Sources checked

- [Sentry for Python](https://docs.sentry.io/platforms/python/)
- [Sentry Python logging integration](https://docs.sentry.io/platforms/python/integrations/logging/)
- [Sentry Python logging integration source](https://github.com/getsentry/sentry-python/blob/master/sentry_sdk/integrations/logging.py)
- [Datadog Python tracing](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/python/)
- [Datadog Python log/trace correlation](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/python/)
- [Datadog ddtrace advanced usage](https://ddtrace.readthedocs.io/en/stable/advanced_usage.html)
- [Datadog dd-trace-py source](https://github.com/DataDog/dd-trace-py)
- [Datadog dd-trace-py issue 796](https://github.com/DataDog/dd-trace-py/issues/796)
- [OpenTelemetry Python getting started](https://opentelemetry.io/docs/languages/python/getting-started/)
- [OpenTelemetry Python logging instrumentation](https://opentelemetry-python-contrib.readthedocs.io/en/latest/instrumentation/logging/logging.html)
- [OpenTelemetry Python logs example source](https://github.com/open-telemetry/opentelemetry-python/blob/main/docs/examples/logs/example.py)
- [PostHog Python SDK](https://posthog.com/docs/libraries/python)
- [PostHog Python SDK source](https://github.com/PostHog/posthog-python)

## Real install evidence

Measured in isolated Python virtual environments with current PyPI packages on 2026-06-15. Payload size and files are based on installed distribution records, excluding `pip`, `setuptools`, and `wheel`.

| Package path | Version | Install time | Payload size | Files | Distributions |
| --- | ---: | ---: | ---: | ---: | ---: |
| `logbrew-sdk` | `0.1.1` | 2.9s | 115 KiB | 21 | 1 |
| `sentry-sdk` | `2.62.0` | 3.1s | 4,987 KiB | 486 | 3 |
| `ddtrace` | `4.10.4` | 5.0s | 28,455 KiB | 2,230 | 6 |
| OpenTelemetry Python quickstart packages | `1.42.1` / `0.63b1` | 7.2s | 51,415 KiB | 1,494 | 21 |
| `posthog` | `7.19.0` | 3.6s | 6,786 KiB | 437 | 9 |

## Honest findings

LogBrew is far lighter than the comparable Python observability paths and remains dependency-free. The install path is especially attractive for teams that want hosted telemetry without an Agent, global monkeypatching, or a large OpenTelemetry exporter tree.

Sentry is stronger on breadth. Its Python quick start shows one early `sentry_sdk.init(...)` path for errors, logs, tracing, profiling, and verification, and the logging docs show standard-library log capture with configurable thresholds. The tradeoff is that its most complete path is global and broad by design, including default integrations and optional PII-bearing behavior.

Datadog is stronger for deep APM in production estates that already run a Datadog Agent. The first path asks users to run applications through `ddtrace-run`, and its log correlation docs/source are built around patching logging and adding trace attributes to records. That is powerful, but it is heavier and more operationally coupled than LogBrew's app-owned handler path.

OpenTelemetry is the portability baseline and covers traces, metrics, and logs, but the Python quickstart and logs example require multiple packages and explicit SDK/exporter/logging setup. This is the right ecosystem bridge, not the lowest-friction hosted SaaS onboarding path.

PostHog is strong on product-event naming, contexts, sessions, and feature-flag-aware event capture. Those ideas map well to LogBrew's explicit product action and network milestone helpers, but PostHog is product analytics-first rather than logs/traces/metrics-first.

Public docs and issue signals also support avoiding hidden global logging behavior. Datadog's Python log-correlation path requires automatic instrumentation and formatter changes before trace IDs show up in logs, and issue 796 shows a user reporting missing INFO logs only when using `ddtrace-run`. OpenTelemetry's logging instrumentation can install handlers, inject record fields, and optionally call `logging.basicConfig()` for trace correlation. LogBrew should keep its Python logging integration app-owned and explicit.

## Work shipped from this comparison

- Added `python/logbrew_py/src/logbrew_sdk/examples/first_useful_telemetry.py`, a packaged Python example that emits release, environment, standard-library log, product action, network milestone, histogram metric, and W3C-linked request span events.
- Added `python/logbrew_py/examples/first_useful_telemetry.py` for source-checkout users.
- Updated `python/logbrew_py/README.md` with a "First Useful Telemetry" section focused on what a new Python service should capture first and what LogBrew intentionally does not capture.
- Updated `scripts/real_user_python_smoke.sh` so wheel, sdist, freeze reinstall, and direct hash reinstall paths run the new packaged example, validate the event payload, and assert no query text, payload fields, or header metadata leaked.

## Next practical gaps

- Add the same first-useful telemetry flow to FastAPI and Django READMEs using their request wrappers and opt-in request duration metrics.
- Keep Python logger integrations app-owned. Do not add global `logging` monkeypatching by default; use explicit handlers and clear failure behavior.
- Consider a small Python migration note mapping Sentry breadcrumbs to LogBrew product actions, Sentry/Datadog trace-log correlation to W3C `traceparent`, and PostHog product events to LogBrew action metadata.
