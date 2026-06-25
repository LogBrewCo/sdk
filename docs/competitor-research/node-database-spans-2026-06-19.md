# Node Database Span Research - 2026-06-19

## Goal

Close the Node server-side database span gap after request and outbound fetch tracing shipped. Sentry, Datadog, and OpenTelemetry are stronger for automatic driver coverage; LogBrew needs a lighter explicit helper that is easy to verify from the installed package and does not capture raw SQL or connection data by default.

## Sources Read

- Sentry JavaScript SDK: `https://github.com/getsentry/sentry-javascript.git` at `5e83b2b076b4b6a968af12da21322422b47b1bc4`.
- Sentry files/functions: `packages/node/src/index.ts` exports `mongoIntegration`, `mongooseIntegration`, `mysqlIntegration`, `mysql2Integration`, `postgresIntegration`, `postgresJsIntegration`, and `prismaIntegration`; `packages/node/src/integrations/tracing/postgresjs.ts` implements `PostgresJsInstrumentation`, `_sanitizeSqlQuery(...)`, `_reconstructQuery(...)`, `_setOperationName(...)`, and `_patchQueryPrototype(...)`; `packages/node/src/integrations/tracing/postgres/index.ts`, `mongo/index.ts`, `mysql/index.ts`, and `prisma/index.ts` expose vendored driver instrumentations.
- OpenTelemetry JS Contrib: `https://github.com/open-telemetry/opentelemetry-js-contrib.git` at `f3d14c0a2996acbe5bce4bf83d36142640a413a0`.
- OpenTelemetry files/functions: `packages/instrumentation-pg/src/instrumentation.ts` (`_getClientQueryPatch`, `recordOperationDuration`, `requestHook` handling, optional trace context propagation) and `packages/instrumentation-pg/src/utils.ts` (`handleConfigQuery`, `parseNormalizedOperationName`, `sanitizedErrorMessage`); `packages/instrumentation-mongodb/src/instrumentation.ts` (`_getV3SpanAttributes`, `_getV4SpanAttributes`, `_getSpanAttributes`, `_spanNameFromAttrs`).
- Datadog dd-trace-js: `https://github.com/DataDog/dd-trace-js.git` at `13c5eaab4e3331c7e2b4f25e42cf364518edc000`.
- Datadog files/functions: `packages/datadog-plugin-prisma/src/index.js` (`PrismaPlugin.startEngineSpan`, `bindStart`, `formatResourceName`) and `packages/datadog-plugin-mongodb-core/src/index.js` (`MongodbCorePlugin.bindStart`, query resource/meta construction, DBM comment path).

## Competitor Patterns

- Sentry exposes broad Node DB integrations and, for `postgres.js`, reconstructs template queries, sanitizes literals, creates spans around driver internals, and records DB semantic attributes. This is powerful automatic coverage but requires instrumentation-owned wrapping.
- OpenTelemetry patches driver query methods, creates `CLIENT` spans, derives operation names, records DB semantic attributes, optional parameter reporting, duration metrics, and optional trace context propagation through database mechanisms. It is standards-rich but dependency-heavy.
- Datadog plugins derive DB resources/meta from Prisma engine spans and Mongo operations, can include DB names/users/hosts/ports, and integrate with DBM comment propagation. It wins observability depth but crosses privacy boundaries LogBrew should not use as defaults.

## LogBrew Implementation

- Added `databaseOperationWithLogBrewSpan(...)` to `@logbrew/node`.
- The helper is explicit and dependency-free: apps pass an operation callback around important DB work instead of LogBrew patching `pg`, MongoDB, Prisma, MySQL, ORMs, or global async hooks beyond the existing request-local trace context.
- It creates a child trace context from the supplied or active request trace, activates it while the operation runs, queues one span, returns the original result, and rethrows the original exception.
- Metadata is privacy-bounded: `framework=node:database`, `dbSystem`, `dbOperation`, `dbOperationKind`, optional `dbName`, optional safe `dbStatementTemplate`, optional non-negative `rowCount`, sampled flag, primitive safe caller metadata, and exception type only.
- It drops unsafe metadata keys such as SQL/query/statement text, params/parameters, headers, connection strings, hosts, usernames, auth values, URLs, cookies, and sensitive values. It does not capture result rows, connection details, raw propagation metadata, baggage, tracestate, error messages, or stack traces.

## Tradeoffs

- Better than Sentry/Datadog/OpenTelemetry for teams that want one app-owned database span around the operation that matters, minimal package footprint, no driver monkey-patching, no local agent assumption, and clear privacy behavior.
- Worse than Sentry/Datadog/OpenTelemetry for teams that expect automatic coverage across every query, ORM-specific operation naming, full DB semantic conventions, query comments, DB duration metrics, fetch spans, or DBM integration.
- The next safe improvement is optional framework-owned examples or integration packages for common drivers/ORMs, not hidden patching inside `@logbrew/node`.

## Verification

- Red installed proof: `bash scripts/real_user_node_smoke.sh` failed after adding the README/import/type/runtime expectations because `databaseOperationWithLogBrewSpan` did not exist.
- Green installed proof: `bash scripts/real_user_node_smoke.sh` passed on Node `v22.18.0`, including packed install, README proof, runtime DB success/error spans, TypeScript declaration consumption, result preservation, error rethrow, trace correlation, and no raw SQL/params/error-message leakage.
- Package/static checks: `npm test --prefix js/logbrew-node`, `bash scripts/check_js_package.sh`, `bash scripts/check_js_lint.sh`, and `python3 scripts/check_generated_artifacts.py` passed.

## Remaining Gaps

- Node still lacks optional automatic driver integrations for teams that explicitly want Sentry/Datadog-style drop-in coverage.
- Cache and queue spans are still thinner than competitor automatic instrumentation.
- LogBrew still avoids baggage, tracestate, span links, DB semantic conventions beyond the current safe subset, query comments, and database-side trace propagation. Bounded span events now exist, but they are explicit summaries rather than automatic full OpenTelemetry/Sentry event streams.
