# Node Prisma Tracing Competitor Review - 2026-07-06

This note records the source-backed design decision for LogBrew's Prisma Client tracing helpers.

## Sources Checked

- Sentry JavaScript public repo `getsentry/sentry-javascript@96cbf5ec8c420c6b6a8dba4e2fe245cad4333edb`
- Sentry paths read:
  - `packages/node/src/index.ts`
  - `packages/node/src/integrations/tracing/prisma/index.ts`
  - `packages/node/src/integrations/tracing/prisma/vendored/active-tracing-helper.ts`
  - `packages/node/src/integrations/tracing/prisma/vendored/instrumentation.ts`
  - `packages/node/src/integrations/tracing/prisma/vendored/constants.ts`
  - `packages/node/src/integrations/tracing/prisma/vendored/v6-tracing-helper.ts`
- Sentry functions/classes read: `prismaIntegration`, `instrumentPrisma`, `SentryPrismaInteropInstrumentation.enable`, `ActiveTracingHelper.getTraceParent`, `dispatchEngineSpans`, `runInChildSpan`, `buildSpanAttributes`, `buildSpanName`, and `PrismaV6TracingHelper`.
- Datadog JS public repo `DataDog/dd-trace-js@02cb1a1fc744c4589385d91c674a6c5720a5d747`
- Datadog paths read:
  - `packages/datadog-plugin-prisma/src/index.js`
  - `packages/datadog-plugin-prisma/src/datadog-tracing-helper.js`
  - `packages/datadog-instrumentations/src/prisma.js`
  - `packages/datadog-plugin-prisma/test/index.spec.js`
  - `packages/datadog-plugin-prisma/test/integration-test/server-ts-v7-otel.mjs`
  - `packages/datadog-plugin-prisma/test/naming.js`
- Datadog functions/classes read: `PrismaPlugin`, `startEngineSpan`, `bindStart`, `bindAsyncStart`, `asyncStart`, `end`, `error`, `formatResourceName`, `DatadogTracingHelper.getTraceParent`, `dispatchEngineSpans`, `getActiveContext`, `runInChildSpan`, `prismaHook`, `resolveDatasourceUrl`, `resolveAdapterDbConfig`, and `parseDBString`.
- OpenTelemetry JS Contrib public repo `open-telemetry/opentelemetry-js-contrib@07607d0adab59f87c0e517075fa1fbd41c18f99e`
- OpenTelemetry source check: no Prisma instrumentation package was found in this tree; related ORM/database packages include MySQL, MySQL2, Sequelize, and TypeORM.
- PostHog Node public repo `PostHog/posthog-node@fe534177f0257f1f8400bf8189d9bdd6c3e20aea`
- PostHog source check: no comparable Prisma tracing integration was found in `src`, `test`, `tests`, or `package.json`.

## Competitor Pattern

Sentry and Datadog are stronger on automatic Prisma coverage. Both hook deeper Prisma runtime/engine paths, create client and engine spans, handle multiple Prisma major versions, and can connect Prisma engine activity to an active trace.

That power has tradeoffs:

- Sentry vendors Prisma instrumentation helpers and creates spans from Prisma engine telemetry. This gives broad automatic coverage, but the integration has to track Prisma internals and query span naming.
- Datadog has a dedicated Prisma plugin plus instrumentation hook. It captures richer database metadata and DBM correlation, but also handles connection/datasource details and error metadata that are heavier than LogBrew's privacy default.
- OpenTelemetry JS Contrib and PostHog Node did not show a comparable Prisma integration in the checked public source.

## LogBrew Design

LogBrew added a lighter `@logbrew/prisma` package:

- `instrumentLogBrewPrismaClient(prisma, options)` returns an extended Prisma Client and an `uninstall()` handle.
- `createLogBrewPrismaExtension(options)` exposes the app-owned Prisma Client extension directly.
- `prismaOperationWithLogBrewSpan(context, options)` wraps a single Prisma-like operation.
- The implementation reuses `@logbrew/node` `databaseOperationWithLogBrewSpan`, so trace IDs, parent spans, failure handling, queue behavior, flush/shutdown, and retry behavior stay consistent with other Node database spans.

The package deliberately avoids global Prisma runtime patching, Prisma engine helper injection, SQL text, Prisma `args`, result payloads, database connection details, arbitrary headers, exception messages, stacks, baggage, and tracestate.

## Where LogBrew Is Better

For privacy-sensitive users, LogBrew is safer by default than the richer Sentry/Datadog Prisma paths. It is explicit, reversible, target-scoped to one app-owned Prisma Client, and proves installed-package behavior with a local fake intake and high-load queue pressure.

## Where LogBrew Is Worse

Sentry and Datadog still lead on automatic Prisma runtime coverage, Prisma engine spans, multi-version Prisma internals, DBM-style trace context handoff, and hosted trace UI. LogBrew's first version captures model/action spans through Prisma Client extensions, but it does not see all engine-internal spans or connection/datasource metadata.

## Verification

`scripts/real_user_prisma_smoke.sh` now proves the installed-artifact path:

- Packs and installs local `@logbrew/sdk`, `@logbrew/node`, and `@logbrew/prisma`.
- Installs `@prisma/client@6.17.0` and `prisma@6.17.0`.
- Runs real Prisma Client generation and real SQLite Prisma operations.
- Typechecks public TypeScript declarations and verifies CommonJS exports.
- Captures success, row-count, error-type-only failure, direct extension, direct wrapper, and uninstall behavior.
- Drives 1,500 Prisma operations into a 1,000-event queue, proves 500 drops, and flushes to a local intake with HTTP 503-to-202 retry in two attempts.
- Asserts no SQL, args, result values, email/name data, connection string, headers, query metadata, exception message, or stack leaks.

Local note: Prisma `db push` failed in the local temp-app environment with a blank schema-engine error even when run without LogBrew. The smoke keeps real Prisma Client runtime coverage by generating the client and creating the minimal SQLite table with Node's bundled SQLite API.
