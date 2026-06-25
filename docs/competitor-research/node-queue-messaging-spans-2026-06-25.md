# Node Queue Messaging Spans - 2026-06-25

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@5b0f83c39bcdce5eb67fca5361821d595c26d47e`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/instrumentation.ts`: `KafkaJsInstrumentation`, `_getProducerPatch()`, `_getConsumerPatch()`, `_getSendPatch()`, `_getSendBatchPatch()`, `_getConsumerEachMessagePatch()`, and `_getConsumerEachBatchPatch()`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/utils.ts`: `startProducerSpan(...)`, `startConsumerSpan(...)`, `getHeaderAsString(...)`, `getLinksFromHeaders(...)`, and `endSpansOnPromise(...)`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/semconv.ts` and `packages/node/src/integrations/tracing/amqplib/vendored/semconv.ts` for vendored messaging semantic keys.
- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039`.
- Read `packages/instrumentation-kafkajs/src/instrumentation.ts`: `_getConsumerEachMessagePatch()`, `_getConsumerEachBatchPatch()`, `_getSendPatch()`, `_getSendBatchPatch()`, `_startConsumerSpan(...)`, `_startProducerSpan(...)`, and `_endSpansOnPromise(...)`.
- Read `packages/instrumentation-kafkajs/src/semconv.ts` and `packages/instrumentation-amqplib/src/semconv.ts` for `messaging.system`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, and `messaging.batch.message_count`.
- Datadog dd-trace-js: `DataDog/dd-trace-js@4638d8ec5136d176c017b0546b30f79bf52ad3cb`.
- Read `packages/datadog-plugin-kafkajs/src/producer.js` and `packages/datadog-plugin-kafkajs/src/consumer.js`: producer/consumer plugins set destination/topic metadata, batch size, partition/offset metadata, trace header injection/extraction, and data-stream checkpoints.

## Competitor Pattern

Sentry and OpenTelemetry are strongest for automatic Kafka/AMQP instrumentation: they wrap producers and consumers, create producer/consumer spans, propagate trace headers through broker messages, add batch and destination metadata, and use span links for batch processing. Sentry's `getLinksFromHeaders(...)` extracts a producer trace from message headers and `_getConsumerEachBatchPatch()` attaches those links during batch processing; OpenTelemetry's `_getConsumerEachBatchPatch()` follows the same batch-receive plus per-message link pattern. Datadog adds broad messaging plugins, topic metadata, batch size, partition/offset tags, header propagation, and data-stream monitoring.

The tradeoff is a larger dependency and privacy surface: global/module patching, broker header mutation, message key/partition/offset tags, optional baggage, data-stream metadata, and more framework-specific behavior.

## LogBrew Implementation

`@logbrew/node` keeps queue spans explicit and dependency-free through `queueOperationWithLogBrewSpan(...)`.

- It now emits a safe portable messaging subset from already sanitized app inputs: `messaging.system`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, and `messaging.batch.message_count` for batches larger than one.
- It now exposes `createLogBrewQueueTraceHeaders()` so producers can create exactly one normalized W3C `traceparent` from the active queue span, and `queueOperationWithLogBrewSpan(...)` accepts an incoming `traceparent` to continue a consumed message trace.
- It now exposes `createLogBrewQueueTraceLinks()` so batch consumers can turn string, header-like, array-valued, or Buffer-like `traceparent` carriers into bounded `SpanLinkSummary[]` values without throwing on malformed propagation or retaining raw headers.
- It preserves existing LogBrew metadata (`queueSystem`, `queueOperation`, `queueOperationKind`, `queueName`, `taskName`, `messageCount`) for readable agent/debug output.
- It avoids hidden Kafka/AMQP/BullMQ/SQS patching, broker URL capture, header mutation, arbitrary header capture, message bodies, job arguments, message keys, partition/offset tags, baggage, tracestate, and raw propagation metadata.

## Verification

- RED: `bash scripts/real_user_node_smoke.sh` failed after adding installed-artifact assertions for missing `messaging.*` queue metadata.
- GREEN: `bash scripts/real_user_node_smoke.sh` passed on Node `v22.18.0` after the helper emitted the safe semantic aliases from the packed package.
- RED: `bash scripts/real_user_node_queue_trace_smoke.sh` failed from an installed app because `@logbrew/node` did not export `createLogBrewQueueTraceHeaders`.
- GREEN: `bash scripts/real_user_node_queue_trace_smoke.sh` passed on Node `v22.18.0`, proving installed producer traceparent creation, consumer trace continuation, malformed propagation fallback, TypeScript export coverage, and no raw propagation header storage.
- RED: `NPM_CONFIG_CACHE=/private/tmp/logbrew-node-queue-npm-cache bash scripts/real_user_node_queue_trace_smoke.sh` failed from an installed app because `@logbrew/node` did not export `createLogBrewQueueTraceLinks`.
- GREEN: the same installed smoke passed on Node `v22.18.0`, proving batch span links from real message headers, malformed-carrier skip, primitive metadata filtering, ESM and TypeScript export coverage, and no raw `traceparent`, header, body, or payload storage.
- Focused syntax proof: `npm test --prefix js/logbrew-node` passed.
- Focused package proof: `bash scripts/check_js_lint.sh`, `bash scripts/check_js_package.sh`, and `NPM_CONFIG_CACHE=/private/tmp/logbrew-node-npm-cache bash scripts/real_user_node_smoke.sh` passed.

## Remaining Gaps

- Sentry, Datadog, and OpenTelemetry remain stronger for automatic Kafka/AMQP/BullMQ/SQS instrumentation, automatic broker header injection/extraction, partition/offset diagnostics, data-stream monitoring, baggage/tracestate, and framework-owned queue integrations.
- Next LogBrew steps should stay opt-in and evidence-backed: optional framework/integration packages for popular queues, richer explicit span links/events in real queue examples, and local fake-intake proof for queue-heavy production failure behavior.
