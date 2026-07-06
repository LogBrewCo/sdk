# Node Redis Pipeline Tracing - 2026-07-06

## Gap

LogBrew already traced app-owned Node Redis `sendCommand()` and `connect()`, but batch-style Redis work through `multi().exec()`, `multi().execAsPipeline()`, or ioredis `pipeline().exec()` was still invisible. That left a real debugging gap for request traces where most cache latency happens in a batch rather than a single command.

## Competitor Source Read

- Sentry JavaScript `getsentry/sentry-javascript@9d53b0cd8ccd894d7ce24530cb1b289f2607eb97`
  - `packages/node/src/index.ts`: exports `redisIntegration`.
  - `packages/node/src/integrations/tracing/redis/index.ts`: `instrumentRedis`, `redisIntegration`, diagnostics-channel handoff, Redis/ioredis instrumentation setup.
  - `packages/node/src/integrations/tracing/redis/vendored/redis-instrumentation.ts`: `RedisInstrumentationV4_V5`, `_getPatchMultiCommandsExec`, `_getPatchMultiCommandsAddCommand`, `_getPatchRedisClientMulti`, `_traceClientCommand`, `_endSpansWithRedisReplies`.
  - `packages/node/src/integrations/tracing/redis/cache.ts`: `cacheResponseHook`, cache hit/item-size/key enrichment.
- Datadog JavaScript `DataDog/dd-trace-js@02cb1a1fc744c4589385d91c674a6c5720a5d747`
  - `packages/datadog-instrumentations/src/redis.js`: command queue hooks, `wrapAddCommand`, `wrapCommandQueueClass`, `getStartCtx`, finish/error channels.
  - `packages/datadog-plugin-redis/src/index.js`: `RedisPlugin`, `bindStart`, `formatCommand`, raw-command and connection metadata.
  - `packages/datadog-plugin-ioredis/src/index.js`: ioredis plugin subclass.
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@07607d0adab59f87c0e517075fa1fbd41c18f99e`
  - `packages/instrumentation-redis/src/v4-v5/instrumentation.ts`: `RedisInstrumentationV4_V5`, multi/pipeline `exec` and `addCommand` wrappers, per-command span completion from replies, cluster multi handling.
  - `packages/instrumentation-redis/test/v4-v5/redis.test.ts`: mixed/same-command pipeline tests for `execAsPipeline()`.
  - `packages/instrumentation-ioredis/test/ioredis.test.ts`: ioredis pipeline child-span behavior.
  - `packages/redis-common/src/index.ts`: default Redis statement serializer and argument-count rules.
- PostHog Node `PostHog/posthog-node@fe534177f0257f1f8400bf8189d9bdd6c3e20aea`
  - Checked `src`, `lib`, and `packages` for Redis/ioredis tracing; no comparable Redis pipeline tracing integration found.

## Pattern Observed

Sentry and OpenTelemetry wrap Redis module internals so multi-command objects retain open per-command spans until `exec()` / `execAsPipeline()` returns replies. Datadog instruments lower-level command queues and records richer raw command and connection metadata. Those approaches give broader hidden coverage, but they are heavier, version-coupled, and can expose command or connection detail unless configured carefully.

## LogBrew Implementation

LogBrew now keeps the app-owned model. `instrumentLogBrewRedisClient(client, { tracePipelines: true })` wraps only `multi`, `MULTI`, or `pipeline` methods on the client instance the app passes in. It records one aggregate `redis.multi` or `redis.pipeline` span when `exec()` / `execAsPipeline()` completes, returns the same driver values or failures, and puts the original instance methods back on `uninstall()`.

Captured metadata is intentionally smaller than competitors: `framework=node:redis`, Redis DB semantic keys, optional caller `cacheName`, `redisPipelineCommandCount`, capped command verbs such as `SET,GET`, sampled state, W3C trace IDs, and type-only exception events. It does not capture command arguments, keys, values, raw command text, replies, connection URLs, host/port/user data, headers, baggage, tracestate, or exception messages/stacks.

## Honest Comparison

LogBrew is better for teams that want safe, explicit Redis batch visibility without global Redis/ioredis module patching or command/key capture. It now also has installed-artifact proof against current `redis` and `ioredis` package object shapes without requiring a live Redis server. Sentry, Datadog, and OpenTelemetry remain stronger for hidden automatic Redis coverage, per-command spans inside a pipeline, cluster coverage, richer semantic conventions, connection metadata, command filtering/obfuscation controls, and hosted trace UI.

## Verification

- RED: `bash scripts/real_user_node_smoke.sh` failed on missing `evt_node_redis_pipeline` span from packed `@logbrew/node`.
- GREEN: `npm --prefix js/logbrew-node test`.
- GREEN: `bash scripts/real_user_node_smoke.sh` passed with packed `@logbrew/sdk` and `@logbrew/node`, aggregate Redis pipeline/multi span proof, type declaration proof, privacy assertions, retry/flush/shutdown behavior, and existing Node helper coverage.
- GREEN: `bash scripts/real_user_node_redis_packages_smoke.sh` passed with packed `@logbrew/sdk` and `@logbrew/node`, `redis@6.1.0`, `ioredis@5.11.1`, real pipeline object chains, local no-service execution seams, success/error aggregate spans, uninstall checks, and privacy assertions.
