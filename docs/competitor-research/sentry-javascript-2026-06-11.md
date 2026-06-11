# Sentry JavaScript SDK Comparison - 2026-06-11

This note captures a current install and docs comparison for LogBrew JavaScript packages versus Sentry JavaScript packages. It is product research for SDK prioritization, not public marketing copy.

## Sources Checked

- Sentry JavaScript breadcrumbs docs: https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/
- Sentry JavaScript distributed tracing docs: https://docs.sentry.io/platforms/javascript/tracing/distributed-tracing/
- Sentry JavaScript options docs: https://docs.sentry.io/platforms/javascript/configuration/options/
- Sentry JavaScript automatic instrumentation docs: https://docs.sentry.io/platforms/javascript/tracing/instrumentation/automatic-instrumentation/
- Sentry JavaScript capture docs: https://docs.sentry.io/platforms/javascript/usage/

## Install Footprint Evidence

Commands were run in a fresh temporary npm app with `--package-lock-only --ignore-scripts`:

```bash
npm install @logbrew/sdk@0.1.1 @logbrew/browser@0.1.0 @sentry/browser@latest @sentry/node@latest --package-lock-only --ignore-scripts
npm view @logbrew/sdk@0.1.1 version dist.unpackedSize dist.fileCount dependencies --json
npm view @logbrew/browser@0.1.0 version dist.unpackedSize dist.fileCount dependencies peerDependencies --json
npm view @sentry/browser@latest version dist.unpackedSize dist.fileCount dependencies --json
npm view @sentry/node@latest version dist.unpackedSize dist.fileCount dependencies optionalDependencies --json
```

| Package | Version observed | Unpacked size | Files | Runtime dependency shape |
| --- | --- | ---: | ---: | --- |
| `@logbrew/sdk` | `0.1.1` | 90,289 bytes | 12 | No dependencies |
| `@logbrew/browser` | `0.1.0` | 64,807 bytes | 10 | No dependencies; peer dependency on `@logbrew/sdk` |
| `@sentry/browser` | `10.57.0` | 2,681,257 bytes | 692 | Depends on Sentry core, replay, replay-canvas, feedback, and browser-utils packages |
| `@sentry/node` | `10.57.0` | 3,889,201 bytes | 1,071 | Depends on Sentry core/server packages, OpenTelemetry packages, and import-hook instrumentation |

## Product Takeaways

- LogBrew's lightweight package footprint is a real advantage. Protect the dependency-free core and keep framework packages thin and app-owned.
- Sentry's docs emphasize automatic instrumentation, replay, breadcrumbs, broad SDK configuration, and runtime hooks. LogBrew should not copy this by default; its differentiator is explicit, privacy-safe signals that developers and AI agents can reason about.
- Sentry breadcrumbs are useful for event context, but they are buffered until another event. LogBrew action and network milestone helpers should continue to create first-class, queryable timeline events instead of hidden context-only breadcrumbs.
- Sentry browser tracing can automatically capture page loads, navigations, HTTP requests, interactions, and long tasks after tracing is enabled. LogBrew should keep automatic capture opt-in and bounded, but make explicit action/network/span wiring easier to add.
- Sentry trace propagation uses Sentry-specific `sentry-trace` and `baggage` headers. LogBrew should keep W3C `traceparent` helpers dependency-free and obvious in docs/examples.
- Sentry options include safeguards such as `sendDefaultPii: false`, `attachStacktrace: false`, and breadcrumb limits. LogBrew should continue to state these privacy defaults directly in SDK docs and prove no stack/query/header/payload capture unless users opt in.

## Concrete LogBrew Work To Prioritize

- Keep public JS docs highlighting the dependency-light install path and explicit privacy-safe timeline helpers.
- Add more first-class AI/agent analysis examples around action/network/session timelines, because this is a clearer differentiator than broad automatic replay.
- Continue proving npm package size, dependency graph, and installed artifact behavior in real-user smokes for changed packages.
- Do not add global fetch/console/logger patches by default to chase competitor feature parity. Prefer reversible, app-owned integrations with explicit targets.
- Consider a future lightweight migration note for Sentry users that maps breadcrumbs to LogBrew actions, trace propagation to W3C `traceparent`, and Sentry levels to LogBrew canonical severities.
