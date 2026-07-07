# Node MongoDB Tracing Research - 2026-06-29

## Goal

Reduce a high-impact Node rich-trace gap: Sentry, OpenTelemetry, and Datadog all provide MongoDB spans, while LogBrew only had generic database spans plus explicit pg and Redis helpers. The LogBrew improvement should help a real Node developer correlate MongoDB collection latency with request traces from an installed package without adopting hidden global driver patching or leaking filters, documents, pipelines, endpoint details, comments, or connection access values.

## Sources Read

- Sentry JavaScript SDK: `https://github.com/getsentry/sentry-javascript.git` at `9730e1163e50e431f0d7db21ca3b8b0fb612fef8`.
- Sentry files/functions: `packages/node/src/index.ts` (`mongoIntegration` export); `packages/node/src/integrations/tracing/mongo/index.ts` (`instrumentMongo`, `mongoIntegration`); `packages/node/src/integrations/tracing/mongo/vendored/instrumentation.ts` (`MongoDBInstrumentation`, v3/v4 connection patches); `packages/node/src/integrations/tracing/mongo/vendored/patches.ts` (`getV3PatchOperation`, `getV3PatchCommand`, `getV4PatchCommandCallback`, `getV4PatchCommandPromise`, `getV4ConnectionPoolCheckOut`); `packages/node/src/integrations/tracing/mongo/vendored/utils.ts` (`getCommandType`, `getV3SpanAttributes`, `getV4SpanAttributes`, `startMongoSpan`, `patchEnd`, `shouldSkipInstrumentation`).
- OpenTelemetry JS Contrib: `https://github.com/open-telemetry/opentelemetry-js-contrib.git` at `eb98ccc85069304a1f0c2e6b33be1b2ca961b4be`.
- OpenTelemetry files/functions: `packages/instrumentation-mongodb/src/instrumentation.ts` (`MongoDBInstrumentation`, v3/v4 command patches, connect/session/pool patches, `_getV3SpanAttributes`, `_getV4SpanAttributes`, `_getSpanAttributes`, `_spanNameFromAttrs`, `_defaultDbStatementSerializer`, `requireParentSpan` behavior); `packages/instrumentation-mongodb/src/internal-types.ts` (`MongoDBInstrumentationConfig`, `DbStatementSerializer`, `MongodbCommandType`, `MongodbNamespace`).
- Datadog dd-trace-js: `https://github.com/DataDog/dd-trace-js.git` at `d1aa54a04b20570b1d8fb258e74266f97f652c11`.
- Datadog files/functions: `packages/datadog-instrumentations/src/mongodb.js` (collection filter method wrapping); `packages/datadog-instrumentations/src/mongodb-core.js` (`wrapConnectionCommand`, `wrapUnifiedCommand`, `instrument`, `instrumentPromise`, `synthesizeTopology`); `packages/datadog-plugin-mongodb-core/src/index.js` (`MongodbCorePlugin.bindStart`, query obfuscation, resource naming, DBM comment injection).

## Competitor Pattern

- Sentry exposes `mongoIntegration()` and vendors OpenTelemetry MongoDB instrumentation. It patches MongoDB v3/v4 driver internals, creates client spans only when a parent span exists, captures namespace/collection/operation metadata, and repairs async context around connection-pool callbacks.
- OpenTelemetry patches wire protocol, connection, pool, connect, and session internals. It emits old and stable DB semantic attributes, can serialize sanitized query statements, supports response hooks, and defaults to `requireParentSpan`.
- Datadog combines collection-level filter wrapping with lower-level `mongodb-core` command spans. It records MongoDB query/resource metadata, has query obfuscation modes, endpoint metadata, heartbeat handling, and optional DBM comment injection.

## LogBrew Implementation

- Added `instrumentLogBrewMongoCollection(...)` to `@logbrew/node`.
- Apps pass one app-owned MongoDB collection-like object. LogBrew wraps only supported methods on that instance and returns `isInstalled()`/`uninstall()`.
- Promise-returning and synchronous collection operations preserve results and rethrow original errors. `find()` and `aggregate()` wrap returned cursor terminal methods such as `toArray()` and `next()` so cursor materialization gets a child span.
- Spans use the active LogBrew request trace when present, carry collection/database names when safely known, and emit type-only exception events for failures.
- Metadata includes `framework=node:mongodb`, `db.system.name=mongodb`, `db.operation.name`, `db.namespace`, `db.collection.name`, `db.mongodb.collection`, sampled flag, W3C trace IDs, and bounded result counts when the result shape provides a numeric count.
- It deliberately avoids global MongoDB module patching, wire-protocol patching, connection-pool patching, query/document/pipeline serialization, raw command text, comments, host/port/URL/connection string capture, endpoint details, connection access values, baggage, tracestate, and raw propagation metadata.

## Tradeoffs

- Better than Sentry/Datadog/OpenTelemetry for developers who want explicit, removable, dependency-free instrumentation with strict privacy defaults and installed-artifact proof.
- Worse than competitors for teams that expect automatic coverage across every MongoDB client, connection-pool spans, session/connect metrics, query obfuscation modes, DBM comments, response hooks, heartbeat controls, and full OpenTelemetry semantic-convention coverage.
- Next safe step is optional Mongoose model/query instrumentation or a separate framework-owned MongoDB package if source/runtime evidence shows the extra coupling is worth it.

## Verification

- RED installed proof: `bash scripts/real_user_node_smoke.sh` failed after adding MongoDB tarball, README, ESM import, CJS export, TypeScript, and runtime expectations because `@logbrew/node` had no MongoDB helper or packaged MongoDB files.
- GREEN installed proof: `bash scripts/real_user_node_smoke.sh` passed on Node `v22.18.0`, proving packed `mongo.js`/`mongo.cjs`, README proof, ESM import, CJS export, TypeScript declaration consumption, app-owned collection wrapping, cursor `toArray()`/`next()` spans, error rethrow, duplicate-install rejection, clean uninstall, trace correlation, useful MongoDB metadata, and no filter/document/update/error detail leakage.
- Focused package/static checks: `npm test --prefix js/logbrew-node` and `python3 scripts/check_js_sources.py js/logbrew-node` passed locally.

## Mongoose Follow-Up - 2026-07-07

### Sources Read

- Sentry JavaScript SDK: `https://github.com/getsentry/sentry-javascript.git` at `851edb35850813e1ee2528783daec9c15eefe2b0`.
- Sentry files/functions: `packages/node/src/integrations/tracing/mongoose/vendored/mongoose.ts` (`MongooseInstrumentation`, `patch`, `unpatch`, `patchQueryExec`, `patchAggregateExec`, `patchOnModelMethods`, `_patchDocumentUpdateMethods`, `patchModelStatic`, `_startSpan`, `_handleResponse`); MongoDB companion files `packages/node/src/integrations/tracing/mongo/index.ts`, `packages/node/src/integrations/tracing/mongo/vendored/instrumentation.ts`, and `packages/node/src/integrations/tracing/mongo/vendored/patches.ts`.
- Datadog dd-trace-js: `https://github.com/DataDog/dd-trace-js.git` at `872f1a8373dd520d7f2fc3937bbd9a33f4265c50`.
- Datadog files/functions: `packages/datadog-plugin-mongoose/src/index.js` (`MongoosePlugin.bindStart`, `bindFinish`); `packages/datadog-plugin-mongoose/test/index.spec.js` (document `save()` context propagation); `packages/datadog-plugin-mongodb-core/src/index.js` (`MongodbCorePlugin.bindStart`, query obfuscation/resource/meta, DBM comment injection).
- OpenTelemetry JS Contrib: `https://github.com/open-telemetry/opentelemetry-js-contrib.git` at `3ae8a1be43ba7cd0c5e2a5955bafb65e78df6312`.
- OpenTelemetry files/functions: `packages/instrumentation-mongodb/src/instrumentation.ts` (`MongoDBInstrumentation`, module-version patches, connect/session/pool metrics, v3/v4 command/find/cursor patches, `requireParentSpan`).
- PostHog JavaScript SDK: `https://github.com/PostHog/posthog-js.git` at `7a3538277af8302cbe82061ec9340eea5a557443`; no MongoDB or Mongoose instrumentation source was found in the public SDK tree.

### Competitor Pattern

- Sentry and Datadog both favor automatic Mongoose coverage by patching query, aggregate, model static, and document methods, then parenting spans to their active scope or store. Sentry has special handling for document `updateOne()`/`deleteOne()` to avoid generic Query spans when newer Mongoose versions defer query construction. This gives broad coverage but couples instrumentation to Mongoose internals and raises privacy defaults that need obfuscation/redaction choices.
- OpenTelemetry covers MongoDB driver internals rather than a first-party Mongoose wrapper in the JS contrib source read here. That gives portability at the driver layer, but apps still need OpenTelemetry setup and accept global instrumentation behavior.
- PostHog does not appear to compete on server-side MongoDB/Mongoose tracing in the source read here.

### LogBrew Implementation

- Added `instrumentLogBrewMongooseModel(...)` to `@logbrew/node` for app-owned Mongoose models.
- The helper wraps only the supplied model, returns `isInstalled()`/`uninstall()`, records one child span around Query/Aggregate `exec()`, supported direct model methods, and model instance `save()`/`updateOne()`/`deleteOne()`, preserves results, and rethrows original errors.
- Spans use the active LogBrew request trace when present and include `framework=node:mongoose`, `db.system.name=mongoose`, operation kind, safe model/collection/database names, sampled flag, W3C trace IDs, type-only exception events, and bounded result counts when safe.
- It deliberately avoids global Mongoose module patching, hidden MongoDB driver patching, filter/document/update/pipeline serialization, query text, endpoint/connection data, error messages/stacks, baggage, tracestate, and raw propagation metadata.

### Verification

- RED installed proof: `bash scripts/real_user_node_mongoose_smoke.sh` failed before implementation because the packed `@logbrew/node` artifact had no `mongoose.js`/`mongoose.cjs` helper files or root API.
- GREEN installed proof: `bash scripts/real_user_node_mongoose_smoke.sh` passed with `mongoose@9.7.4`, proving packed ESM/CJS/type exports, install/remove/reinstall, real Mongoose model query/update execution through stubbed collection methods, trace correlation, duplicate-install rejection, clean uninstall, error rethrow, type-only exception event, and no query/update/error-message leakage.
- Document-method follow-up proof: RED failed because document `save()` emitted no LogBrew span and document `updateOne()`/`deleteOne()` were only generic `mongoose.query` spans. GREEN passed after adding app-owned model prototype wrapping for `save()`, `$save`, `updateOne()`, and `deleteOne()`, with document-scoped spans, duplicate-query-span suppression for document query execution, uninstall restoration, and privacy assertions for saved document values and update specs.

## Remaining Gaps

- LogBrew still lacks Sentry/OTel/Datadog-style automatic MongoDB driver instrumentation, wire-protocol coverage, pool/connect/session spans, DBM comments, query obfuscation modes, response hooks, heartbeat controls, and broader semantic-convention depth.
- LogBrew intentionally does not collect MongoDB filters, raw commands, documents, or pipelines by default, so teams that want query-level diagnostics need a future explicit API with strong redaction and installed-artifact proof.
