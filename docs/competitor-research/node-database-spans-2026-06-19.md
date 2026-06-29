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
- 2026-06-25 refresh: OpenTelemetry JS contrib `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039` and OpenTelemetry JS `open-telemetry/opentelemetry-js@53337962f2506e2422196b532cb058a533f0b5e3`.
- Read `packages/instrumentation-pg/src/utils.ts`: `getSemanticAttributesFromConnection(...)`, `getSemanticAttributesFromPoolConnection(...)`, `getQuerySpanName(...)`, and `parseNormalizedOperationName(...)` derive stable DB semantic metadata while avoiding raw auth material in connection strings. Read `semantic-conventions/src/stable_attributes.ts` for `db.system.name`, `db.namespace`, and `db.operation.name`.
- 2026-06-29 `pg` refresh: Sentry JavaScript `getsentry/sentry-javascript@6e7c2a3fa66b0427e5dfb3cb6ce67c0697670972`, OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@eb98ccc85069304a1f0c2e6b33be1b2ca961b4be`, and Datadog dd-trace-js `DataDog/dd-trace-js@d1aa54a04b20570b1d8fb258e74266f97f652c11`.
- 2026-06-29 files/functions read: Sentry `packages/node/src/index.ts` (`postgresIntegration`, `postgresJsIntegration` exports), `packages/node/src/integrations/tracing/postgres/index.ts` (`instrumentPostgres`, `postgresIntegration`, `setupOnce`), `packages/node/src/integrations/tracing/postgres/vendored/instrumentation.ts` (`_getClientQueryPatch`, `_getPoolConnectPatch`, `_getClientConnectPatch`, `handleConnectResult`), and `packages/core/src/integrations/postgresjs.ts` (`instrumentPostgresJsSql`, `_instrumentSqlInstance`, `_wrapSingleQueryHandle`); OpenTelemetry `packages/instrumentation-pg/src/instrumentation.ts` (`PgInstrumentation`, `_patchPgClient`, `_getClientQueryPatch`, `_getPoolConnectPatch`, `recordOperationDuration`, request hooks, optional trace context propagation) and `packages/instrumentation-pg/src/utils.ts` (`getQuerySpanName`, `parseNormalizedOperationName`, `getSemanticAttributesFromConnection`, `getSemanticAttributesFromPoolConnection`, `handleConfigQuery`, `patchCallback`, `handleExecutionResult`); Datadog `packages/datadog-plugin-pg/src/index.js` (`PGPlugin`, `bindStart`, `injectDbmQuery`) and `packages/datadog-plugin-pg/test/index.spec.js` pool parent preservation and DBM comment propagation cases.

## Competitor Patterns

- Sentry exposes broad Node DB integrations and, for `postgres.js`, reconstructs template queries, sanitizes literals, creates spans around driver internals, and records DB semantic attributes. This is powerful automatic coverage but requires instrumentation-owned wrapping.
- OpenTelemetry patches driver query methods, creates `CLIENT` spans, derives operation names, records DB semantic attributes, optional parameter reporting, duration metrics, and optional trace context propagation through database mechanisms. It is standards-rich but dependency-heavy.
- Datadog plugins derive DB resources/meta from Prisma engine spans and Mongo operations, can include DB names/users/hosts/ports, and integrate with DBM comment propagation. It wins observability depth but crosses privacy boundaries LogBrew should not use as defaults.
- For `pg`, all three competitors prove users value query-level spans. Sentry/OpenTelemetry patch `Client`/`Pool` query/connect paths and preserve callback/Promise behavior; Datadog additionally supports DBM SQL comment propagation. Their power comes from broad hidden instrumentation, but the same path can expose connection/user/host/query/comment details unless carefully configured.

## LogBrew Implementation

- Added `databaseOperationWithLogBrewSpan(...)` to `@logbrew/node`.
- Added `instrumentLogBrewPgClient(...)` to `@logbrew/node` for apps that already use `pg` and want safer query-level spans around an app-owned `Client` or `Pool`.
- The `pg` helper wraps only the passed object, preserves Promise and callback query results, rethrows driver errors, supports clean `uninstall()`, and uses the active LogBrew request trace when one exists.
- `pg` span metadata includes `framework=node:pg`, `db.system.name=postgresql`, `db.operation.name`, safe prepared-statement name when present, optional database name, row count, duration, sampled flag, W3C trace IDs, and type-only exception events on failure.
- It deliberately avoids module-global patching, SQL comment injection, raw SQL capture, parameter capture, result rows, connection strings, connection endpoint/user/passphrase capture, baggage, tracestate, raw propagation metadata, and driver-owned dependency installation.
- The helper is explicit and dependency-free: apps pass an operation callback around important DB work instead of LogBrew patching `pg`, MongoDB, Prisma, MySQL, ORMs, or global async hooks beyond the existing request-local trace context.
- It creates a child trace context from the supplied or active request trace, activates it while the operation runs, queues one span, returns the original result, and rethrows the original exception.
- Metadata is privacy-bounded: `framework=node:database`, `dbSystem`, `dbOperation`, `dbOperationKind`, optional `dbName`, optional safe `dbStatementTemplate`, optional non-negative `rowCount`, sampled flag, primitive safe caller metadata, exception type only, and a portable DB semantic subset: `db.system.name`, `db.operation.name`, and optional `db.namespace`.
- Cache helper spans now emit the same safe DB semantic aliases for cache systems such as Redis when the app provides `system`, `operationKind`, and `cacheName`.
- It drops unsafe metadata keys such as SQL/query/statement text, params/parameters, headers, connection strings, hosts, usernames, auth values, URLs, cookies, and sensitive values. It does not capture result rows, connection details, raw propagation metadata, baggage, tracestate, error messages, or stack traces.

## Tradeoffs

- Better than Sentry/Datadog/OpenTelemetry for teams that want one app-owned database span around the operation that matters, minimal package footprint, no driver monkey-patching, no local agent assumption, and clear privacy behavior.
- Better than Sentry/Datadog/OpenTelemetry for `pg` users who want an owned-instance wrapper that can be installed/uninstalled locally and proven from the packed package without global monkey-patching or query/comment capture.
- Worse than Sentry/Datadog/OpenTelemetry for teams that expect automatic coverage across every query, ORM-specific operation naming, full DB semantic conventions, query comments, DB duration metrics, fetch spans, or DBM integration.
- The next safe improvement is optional framework-owned examples or integration packages for common drivers/ORMs, plus high-load/failure proof for the driver helpers, not hidden patching inside `@logbrew/node`.

## Verification

- Red installed proof: `bash scripts/real_user_node_smoke.sh` failed after adding the README/import/type/runtime expectations because `databaseOperationWithLogBrewSpan` did not exist.
- Green installed proof: `bash scripts/real_user_node_smoke.sh` passed on Node `v22.18.0`, including packed install, README proof, runtime DB success/error spans, TypeScript declaration consumption, result preservation, error rethrow, trace correlation, and no raw SQL/params/error-message leakage.
- 2026-06-25 green installed proof: the same Node smoke verifies `db.system.name`, `db.operation.name`, and `db.namespace` on DB/cache spans from the packed package.
- 2026-06-29 red installed proof: `bash scripts/real_user_node_smoke.sh` failed after adding `pg` installed-app expectations because `@logbrew/node` did not export `instrumentLogBrewPgClient`.
- 2026-06-29 green installed proof: `npm test --prefix js/logbrew-node` and `bash scripts/real_user_node_smoke.sh` passed on Node `v22.18.0`, including packed `pg.js`/`pg.cjs` files, README proof, ESM import, CommonJS export, TypeScript declaration consumption, `pg-mem` backed query success/failure, result preservation, error rethrow, trace correlation, row-count metadata, clean uninstall, and no raw SQL/parameters/connection-string/connection-endpoint/user/passphrase/email leakage.
- Package/static checks: `npm test --prefix js/logbrew-node`, `bash scripts/check_js_package.sh`, `bash scripts/check_js_lint.sh`, and `python3 scripts/check_generated_artifacts.py` passed.

## Remaining Gaps

- Node still lacks optional automatic driver integrations for teams that explicitly want Sentry/Datadog-style drop-in coverage.
- `pg` support is instance-owned and explicit; LogBrew still lacks Sentry/OpenTelemetry-style module-level automatic `pg` instrumentation, pool connect spans, DB metrics, DBM comments, and database-side trace propagation.
- Cache and queue spans are still thinner than competitor automatic instrumentation.
- LogBrew still avoids baggage, tracestate, query comments, database-side trace propagation, and the broader automatic semantic conventions competitors can fill from patched drivers. Bounded span events and span links now exist, but they are explicit summaries/references rather than automatic full OpenTelemetry/Sentry event/link streams.
