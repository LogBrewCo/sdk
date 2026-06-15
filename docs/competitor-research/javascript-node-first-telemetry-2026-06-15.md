# JavaScript and Node.js First Telemetry Comparison, 2026-06-15

## Scope

This pass compared the first useful Node.js observability path for a developer evaluating LogBrew against Sentry, Datadog, OpenTelemetry, and PostHog. The goal was not feature counting. The goal was to answer: can a new Node.js service install the SDK, send useful logs, traces, metrics, errors, and product workflow signals, and understand privacy behavior faster than with the main alternatives?

## Sources checked

- [Sentry for Node.js](https://docs.sentry.io/platforms/javascript/guides/node/)
- [Sentry JavaScript options](https://docs.sentry.io/platforms/javascript/configuration/options/)
- [Sentry Node logs](https://docs.sentry.io/platforms/javascript/guides/node/logs/)
- [Sentry Node tracing](https://docs.sentry.io/platforms/javascript/guides/node/tracing/)
- [Sentry Node metrics](https://docs.sentry.io/platforms/javascript/guides/node/metrics/)
- [Datadog Node.js tracing](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/nodejs/)
- [OpenTelemetry JavaScript Node.js getting started](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)
- [PostHog Node.js SDK](https://posthog.com/docs/libraries/node)

## Real install evidence

Measured in isolated npm apps with `npm install --ignore-scripts --no-audit --no-fund` on 2026-06-15. The LogBrew path installed the public `@logbrew/sdk@latest` plus `@logbrew/node@latest`.

| Package path | Version | Install time | `node_modules` size | Files | Lock entries |
| --- | ---: | ---: | ---: | ---: | ---: |
| `@logbrew/sdk` + `@logbrew/node` | `0.1.3` + `0.1.0` | 0.8s | 200 KiB | 25 | 2 |
| `@sentry/node` | `10.57.0` | 2.2s | 43,372 KiB | 5,556 | 20 |
| `dd-trace` | `5.108.0` | 11.8s | 99,580 KiB | 2,510 | 58 |
| OpenTelemetry Node quickstart packages | `0.219.0` / `2.8.0` | 6.4s | 76,260 KiB | 8,184 | 197 |
| `posthog-node` | `5.37.0` | 1.7s | 3,176 KiB | 475 | 3 |

Registry metadata also showed `@logbrew/sdk@0.1.3` remains dependency-free at 99,060 bytes unpacked, while `@sentry/node@10.57.0` is 3,889,201 bytes unpacked and `dd-trace@5.108.0` is 5,415,919 bytes before transitive install size.

## Honest findings

LogBrew is much lighter and safer for the first install path. It does not require an Agent, does not need setup-before-app global patching, and does not install a large OpenTelemetry or native-module tree. The `@logbrew/node` helper keeps response ownership in the app and omits query text in automatic request metadata.

Sentry is still stronger on breadth. Its current JavaScript docs put errors, logs, tracing, metrics, replay, profiling, filtering hooks, and source maps in one mature product path. LogBrew has the core primitives, but source-map upload and lookup remain a real gap until the backend contract is implemented and proven.

Datadog is stronger for deep automatic APM in large services, but its Node setup depends on early import or process flags, an Agent path, and more bundling caveats. That is useful for teams that want broad auto-instrumentation, but it is heavier and less app-owned than LogBrew.

OpenTelemetry is the portability baseline, but the Node quickstart still asks the user to install several packages and place instrumentation before app code. LogBrew should remain compatible with W3C `traceparent` while keeping the common hosted-service path simpler.

PostHog has useful product-context concepts, including contexts and explicit event naming. LogBrew's product action and network milestone helpers now cover a similar agent-readable workflow need without visual replay claims or automatic payload capture.

## Work shipped from this comparison

- Added `js/logbrew-node/examples/first-useful-telemetry.mjs`, a packaged Node example that emits release, environment, log, request span, product action, network milestone, and histogram metric events from an installed-style `node:http` flow.
- Updated `js/logbrew-node/README.md` with a "First Useful Telemetry" section that tells a new service which signals to capture first and states privacy behavior directly.
- Updated `scripts/real_user_node_smoke.sh` so installed package checks run the new example, validate the event payload, and confirm the request span omits query text.

## Next practical gaps

- Add the same "first useful telemetry" pattern to Express, Fastify, NestJS, and Next docs, using route templates and the existing opt-in request duration metric helpers.
- Keep source-map and native symbolication work honest: do not claim parity with Sentry or Datadog until upload and lookup are proven end to end.
- Add a compact migration note mapping common Sentry concepts to LogBrew primitives: breadcrumbs to product actions, request spans to W3C-linked spans, Sentry levels to canonical severities, and `beforeSend`-style filtering to `eventFilter`.
