# Node Redis Tracing Research - 2026-06-29

## Goal

Reduce a high-impact Node rich-trace gap: Sentry, OpenTelemetry, and Datadog all give developers Redis command spans, while LogBrew only had a generic cache wrapper. The LogBrew improvement should help a real Node developer correlate Redis latency with request traces from an installed package without adopting hidden global patching or leaking keys, values, endpoints, or connection access values.

## Sources Read

- Sentry JavaScript SDK: `https://github.com/getsentry/sentry-javascript.git` at `6e7c2a3fa66b0427e5dfb3cb6ce67c0697670972`.
- Sentry files/functions: `packages/node/src/index.ts` (`redisIntegration` export); `packages/node/src/integrations/tracing/redis/index.ts` (`instrumentRedis`, `redisIntegration`, `cacheResponseHook`); `packages/node/src/integrations/tracing/redis/vendored/redis-instrumentation.ts` (`RedisInstrumentationV4_V5`, `_traceClientCommand`, `_endSpanWithResponse`); `packages/node/src/integrations/tracing/redis/vendored/ioredis-instrumentation.ts` (`_patchSendCommand`, `_traceConnection`); `packages/server-utils/src/redis/redis-dc-subscriber.ts` (`subscribeRedisDiagnosticChannels`, command/batch/connect channel handlers); `packages/node/src/utils/redisCache.ts` (`getCacheOperation`, `getCacheKeySafely`, `calculateCacheItemSize`).
- OpenTelemetry JS Contrib: `https://github.com/open-telemetry/opentelemetry-js-contrib.git` at `eb98ccc85069304a1f0c2e6b33be1b2ca961b4be`.
- OpenTelemetry files/functions: `packages/instrumentation-redis/src/v4-v5/instrumentation.ts` (`RedisInstrumentationV4_V5`, `_getPatchRedisClientSendCommand`, `_getPatchedClientConnect`, multi-command patches); `packages/instrumentation-ioredis/src/instrumentation.ts` (`IORedisInstrumentation`, `_traceSendCommand`, `_traceConnection`, `requireParentSpan`); `packages/redis-common/src/index.ts` (`defaultDbStatementSerializer`); `packages/instrumentation-redis/src/v4-v5/utils.ts` (`getClientAttributes`, connection string redaction helper).
- Datadog dd-trace-js: `https://github.com/DataDog/dd-trace-js.git` at `d1aa54a04b20570b1d8fb258e74266f97f652c11`.
- Datadog files/functions: `packages/datadog-plugin-redis/src/index.js` (`RedisPlugin.bindStart`, command filtering, raw command formatting); `packages/datadog-plugin-ioredis/src/index.js` (`IORedisPlugin`); `packages/datadog-instrumentations/src/redis.js` (`wrapAddCommand`, `wrapCreateClient`, legacy callback wrapping); `packages/datadog-instrumentations/src/ioredis.js` (`wrapRedis`, command promise finish/error channels).

## Competitor Pattern

- Sentry exposes one `redisIntegration()` that covers `redis` and `ioredis`, including newer diagnostic-channel paths and vendored OTel wrappers. It can add cache hit/key/size data when configured, but that also means key-policy decisions matter.
- OpenTelemetry patches node-redis and ioredis internals, creates client spans for command/connect/multi paths, records DB semantic attributes, and can serialize bounded command statements. It is broad and standards-rich, but it brings OTel machinery and hidden patching.
- Datadog patches redis/ioredis through instrumentation hooks and diagnostic channels, records Redis command resources plus host/port metadata, and has command allow/block filtering. It is deep, but raw command metadata can include keys unless carefully filtered.

## LogBrew Implementation

- Added `instrumentLogBrewRedisClient(...)` to `@logbrew/node`.
- Apps pass one app-owned Redis-like client with `sendCommand(...)` and optional `connect(...)`; LogBrew wraps only that instance and returns `isInstalled()`/`uninstall()`.
- The helper supports node-redis array commands such as `sendCommand(["GET", key])` and ioredis-style command objects such as `sendCommand({ name: "SET", args: [...] })`.
- Spans use the active LogBrew request trace when present, preserve command/connect results, rethrow original errors, and add type-only exception events for failures.
- Metadata includes `framework=node:redis`, `db.system.name=redis`, `db.operation.name`, optional cache namespace, cache-hit boolean for read commands when the result is available, sampled flag, and W3C trace IDs.
- It deliberately avoids global module patching, diagnostic-channel subscriptions, command argument capture, key/value serialization, raw command text, host/port/URL/connection string capture, connection access values, baggage, tracestate, and raw propagation metadata.

## Tradeoffs

- Better than Sentry/Datadog/OpenTelemetry for developers who want a safe, local, removable helper with clear privacy defaults and installed-artifact proof.
- Worse than competitors for teams that expect automatic Redis coverage across every client, multi/pipeline spans, diagnostic-channel support, connection endpoint metadata, cache key policies, command filtering, and full OpenTelemetry semantic coverage.
- Next safe step is either optional pipeline/multi instrumentation for app-owned Redis objects or a separate framework-owned integration when source/runtime evidence shows the extra coupling is worth it.

## Verification

- RED installed proof: `bash scripts/real_user_node_smoke.sh` failed after adding Redis tarball, README, ESM import, CJS export, and TypeScript expectations because `@logbrew/node` had no Redis helper or packaged Redis files.
- GREEN installed proof: `bash scripts/real_user_node_smoke.sh` passed on Node `v22.18.0`, proving packed `redis.js`/`redis.cjs`, README proof, ESM import, CJS export, TypeScript declaration consumption, Redis-like `connect()`, node-redis array command success, ioredis-style command success, error rethrow, duplicate-install rejection, clean uninstall, trace correlation, cache-hit metadata, and no command/key/value/endpoint/access-value leakage.
- Focused package/static checks: `npm test --prefix js/logbrew-node`, `python3 scripts/check_js_sources.py js/logbrew-node`, `bash scripts/check_js_lint.sh`, and `bash scripts/check_js_package.sh` passed locally.

## Remaining Gaps

- LogBrew still lacks Sentry/OTel/Datadog-style automatic Redis module instrumentation, diagnostic-channel support, multi/pipeline spans, command filtering, and broader semantic-convention depth.
- LogBrew intentionally does not collect Redis keys or raw commands by default, so teams that want key-level cache diagnostics need an explicit future API with strong redaction and installed-artifact proof.
