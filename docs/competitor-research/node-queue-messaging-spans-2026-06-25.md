# Node Queue Messaging Spans - 2026-06-25

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@3bfeb64e312fbafbd6fea4b2aafdb73ea94febec`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/instrumentation.ts`: `KafkaJsInstrumentation`, `_getProducerPatch()`, `_getConsumerPatch()`, `_getSendPatch()`, `_getSendBatchPatch()`, `_getConsumerEachMessagePatch()`, and `_getConsumerEachBatchPatch()`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/utils.ts`: `startProducerSpan(...)`, `startConsumerSpan(...)`, `getHeaderAsString(...)`, `getLinksFromHeaders(...)`, and `endSpansOnPromise(...)`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/semconv.ts` and `packages/node/src/integrations/tracing/amqplib/vendored/semconv.ts` for vendored messaging semantic keys.
- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039`.
- Read `packages/instrumentation-kafkajs/src/semconv.ts` and `packages/instrumentation-amqplib/src/semconv.ts` for `messaging.system`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, and `messaging.batch.message_count`.
- Datadog dd-trace-js: `DataDog/dd-trace-js@e0132cc778966c8309304ca7c65616df4be1d939`.
- Read `packages/datadog-plugin-kafkajs/src/producer.js` and `packages/datadog-plugin-kafkajs/src/consumer.js`: producer/consumer plugins set destination/topic metadata, batch size, partition/offset metadata, trace header injection/extraction, and data-stream checkpoints.

## Competitor Pattern

Sentry and OpenTelemetry are strongest for automatic Kafka/AMQP instrumentation: they wrap producers and consumers, create producer/consumer spans, propagate trace headers through broker messages, add batch and destination metadata, and use span links for batch processing. Datadog adds broad messaging plugins, topic metadata, batch size, partition/offset tags, header propagation, and data-stream monitoring.

The tradeoff is a larger dependency and privacy surface: global/module patching, broker header mutation, message key/partition/offset tags, optional baggage, data-stream metadata, and more framework-specific behavior.

## LogBrew Implementation

`@logbrew/node` keeps queue spans explicit and dependency-free through `queueOperationWithLogBrewSpan(...)`.

- It now emits a safe portable messaging subset from already sanitized app inputs: `messaging.system`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, and `messaging.batch.message_count` for batches larger than one.
- It preserves existing LogBrew metadata (`queueSystem`, `queueOperation`, `queueOperationKind`, `queueName`, `taskName`, `messageCount`) for readable agent/debug output.
- It avoids hidden Kafka/AMQP/BullMQ/SQS patching, broker URL capture, header mutation, arbitrary header capture, message bodies, job arguments, message keys, partition/offset tags, baggage, tracestate, and raw propagation metadata.

## Verification

- RED: `bash scripts/real_user_node_smoke.sh` failed after adding installed-artifact assertions for missing `messaging.*` queue metadata.
- GREEN: `bash scripts/real_user_node_smoke.sh` passed on Node `v22.18.0` after the helper emitted the safe semantic aliases from the packed package.
- Focused syntax proof: `npm test --prefix js/logbrew-node` passed.

## Remaining Gaps

- Sentry, Datadog, and OpenTelemetry remain stronger for automatic Kafka/AMQP/BullMQ/SQS instrumentation, trace propagation through broker headers, batch span links from real message headers, partition/offset diagnostics, data-stream monitoring, baggage/tracestate, and framework-owned queue integrations.
- Next LogBrew steps should stay opt-in and evidence-backed: optional framework/integration packages for popular queues, richer explicit span links/events in real queue examples, and local fake-intake proof for queue-heavy production failure behavior.
