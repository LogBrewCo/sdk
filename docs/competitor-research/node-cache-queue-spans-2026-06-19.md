# Node Cache And Queue Spans - Competitor Research - 2026-06-19

## Scope

Reduce the Node observability gap for cache and queue timing correlation while keeping `@logbrew/node` explicit, dependency-free, and privacy bounded. Sentry, Datadog, and OpenTelemetry are stronger for automatic Redis, memcached, AMQP, Kafka, and queue-client coverage; LogBrew should provide a lighter default helper before considering opted integration packages.

## Sources Read

- Sentry JavaScript `getsentry/sentry-javascript@5e83b2b076b4b6a968af12da21322422b47b1bc4`
- `packages/node/src/index.ts` exports `redisIntegration`, `kafkaIntegration`, and `amqplibIntegration`.
- `packages/node/src/integrations/tracing/redis/index.ts` wires Redis and ioredis instrumentation, derives cache hit/item-size attributes, and can update cache-span names from safe key handling.
- `packages/node/src/integrations/tracing/kafka/index.ts` wraps KafkaJS producer/consumer spans with Sentry origins.
- `packages/node/src/integrations/tracing/amqplib/index.ts` wraps AMQP publish/consume spans through vendored OpenTelemetry instrumentation hooks.
- Datadog `DataDog/dd-trace-js@13c5eaab4e3331c7e2b4f25e42cf364518edc000`
- `packages/datadog-plugin-redis/src/index.js` starts Redis command spans, normalizes command names, and bounds raw command formatting.
- `packages/datadog-plugin-memcached/src/index.js` starts memcached command spans and optionally includes command metadata.
- `packages/dd-trace/src/plugins/cache.js` provides the shared cache plugin operation shape.
- `packages/dd-trace/src/service-naming/schemas/v1/messaging.js` maps producer/consumer operation names for AMQP, Kafka, SQS/SNS, BullMQ, NATS, and cloud pub/sub.
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@f3d14c0a2996acbe5bce4bf83d36142640a413a0`
- `packages/instrumentation-redis/src/redis.ts` selects Redis instrumentation for multiple Redis client generations.
- `packages/redis-common/src/index.ts` serializes a bounded subset of Redis command arguments.
- `packages/instrumentation-memcached/src/instrumentation.ts` wraps memcached command execution, records operation attributes, and can include query text when enhanced reporting is enabled.
- `packages/instrumentation-amqplib/src/amqplib.ts` wraps AMQP consume/publish paths, links message context, and ends producer/consumer spans around publish confirmations or acknowledgement behavior.

## Competitor Pattern

Competitors win on automatic breadth. They patch or instrument popular clients, distinguish producer/consumer/cache command operations, propagate trace context through queue libraries, and expose richer semantic attributes. The tradeoff is broader dependency and patching surface, more runtime coupling to specific client versions, and a higher chance of recording key, command, broker, or message-derived details unless users tune options.

## LogBrew Decision

`@logbrew/node` now provides explicit `cacheOperationWithLogBrewSpan(...)` and `queueOperationWithLogBrewSpan(...)` helpers. Apps wrap one app-owned operation callback, LogBrew creates a child trace from the supplied or active request trace, scopes asynchronous work under that trace, records one span, preserves operation results, rethrows original errors, and isolates telemetry capture failures.

The cache helper records only primitive safe metadata plus `cacheSystem`, `cacheOperation`, `cacheOperationKind`, optional `cacheName`, hit flag, item size/count, duration, sampled flag, and W3C trace IDs. It avoids cache client monkeypatching, cache keys, values, raw commands, headers, and error messages/stacks.

The queue helper records only primitive safe metadata plus `queueSystem`, `queueOperation`, `queueOperationKind`, optional queue/task names, message count, duration, sampled flag, and W3C trace IDs. It avoids queue client monkeypatching, broker header mutation, message bodies, job arguments, broker URLs, raw propagation metadata, and error messages/stacks.

## Verification

- TDD red: `bash scripts/real_user_node_smoke.sh` failed before implementation because the packed README/API did not expose the new helpers.
- Green: `bash scripts/real_user_node_smoke.sh` passed on Node v22.18.0 from packed local artifacts, proving README mentions, ESM imports, TypeScript consumption, success/error cache spans, success/error queue spans, trace correlation, result/error preservation, and no cache key/message detail leakage.
- File-size hygiene: `scripts/real_user_node_smoke.sh` is 996 lines, `js/logbrew-node/index.js` is 956 lines, and `js/logbrew-node/index.cjs` is 972 lines after refactoring duplicated trace setup.

## Remaining Gap

Sentry, Datadog, and OpenTelemetry still have broader automatic Redis, ioredis, memcached, AMQP, Kafka, SQS/SNS, and BullMQ coverage. LogBrew should only add automatic driver/client coverage in separate opted integration packages with installed-artifact proof, version-range proof, and the same privacy limits. Core `@logbrew/node` should stay explicit and dependency-free.
