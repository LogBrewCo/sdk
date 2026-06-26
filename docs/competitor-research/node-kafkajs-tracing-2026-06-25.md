# Node KafkaJS Tracing - 2026-06-25

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@3bfeb64e312fbafbd6fea4b2aafdb73ea94febec`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/instrumentation.ts`: `KafkaJsInstrumentation`, `_getProducerPatch()`, `_getConsumerPatch()`, `_getSendPatch()`, `_getSendBatchPatch()`, `_getConsumerEachMessagePatch()`, and `_getConsumerEachBatchPatch()`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/utils.ts`: `getHeaderAsString(...)`, `getLinksFromHeaders(...)`, `startConsumerSpan(...)`, `startProducerSpan(...)`, and `endSpansOnPromise(...)`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/semconv.ts` for Kafka messaging semantic keys.
- Datadog dd-trace-js: `DataDog/dd-trace-js@fae4caffcdc5a00edcbba8a7bce64c4b9880cd0e`.
- Read `packages/datadog-plugin-kafkajs/src/producer.js`, `consumer.js`, `batch-consumer.js`, and `utils.js`: producer/consumer plugins inject and extract trace headers, set topic/batch metadata, track partition/offset commit details, and add data-stream checkpoints.
- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039`.
- Read `packages/instrumentation-kafkajs/src/instrumentation.ts`: `_getSendPatch()`, `_getSendBatchPatch()`, `_getConsumerEachMessagePatch()`, `_getConsumerEachBatchPatch()`, `_startProducerSpan(...)`, `_startConsumerSpan(...)`, and `_endSpansOnPromise(...)`.
- Read `packages/instrumentation-kafkajs/src/semconv.ts` for `messaging.system`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, partition, offset, key, tombstone, and batch count semantics.
- KafkaJS: `tulios/kafkajs@55b0b416308b9e597a5a6b97b0a6fd6b846255dc`.
- Read `src/producer/messageProducer.js`: `send(...)` delegates to `sendBatch(...)`, validates topics/messages, and preserves producer ownership.
- Read `src/consumer/index.js`: `subscribe(...)` and `run({ eachMessage, eachBatch })` expose the app-owned consumer callback boundary.

## Competitor Pattern

Sentry and OpenTelemetry automatically patch KafkaJS producers and consumers. They wrap `send`, `sendBatch`, `eachMessage`, and `eachBatch`, write propagation headers into messages, continue single-message consumer traces, and attach span links for batch processing. Sentry uses its own trace headers and baggage; OpenTelemetry uses its propagator and Kafka semantic conventions. Datadog adds automatic KafkaJS producer/consumer plugins, topic and batch metadata, optional partition/offset diagnostics, header propagation, and data-stream monitoring.

The tradeoff is wider runtime coupling: hidden module patching, mutation of broker message headers, optional key/partition/offset metadata, data-stream payload sizing, baggage/tracestate or vendor propagation, and more version-specific behavior.

## LogBrew Implementation

`@logbrew/kafkajs` adds explicit app-owned KafkaJS helpers:

- `kafkaJsProducerSendWithLogBrewSpan(...)`
- `kafkaJsProducerSendBatchWithLogBrewSpan(...)`
- `withLogBrewKafkaJsEachMessage(...)`
- `withLogBrewKafkaJsEachBatch(...)`
- `createLogBrewKafkaJsProducerRecord(...)`
- `createLogBrewKafkaJsProducerBatch(...)`
- `createLogBrewKafkaJsMessage(...)`
- `extractLogBrewKafkaJsTraceparent(...)`

Producer helpers clone the KafkaJS record or batch, add one normalized W3C `traceparent` header to each message when a valid active or explicit trace exists, and call the app-owned producer. Single-message consumers continue valid incoming traces. Batch consumers derive bounded span links from message headers and derive `messaging.batch.message_count`. The package uses the existing `@logbrew/node` queue span path, so spans include safe portable metadata such as `messaging.system=kafka`, `messaging.destination.name`, `messaging.operation.name`, and `messaging.operation.type`.

It intentionally avoids hidden KafkaJS patching, broker connection ownership, message keys, message values, arbitrary header capture, broker URLs, partitions, offsets, data-stream monitoring, baggage, tracestate, payloads, stack traces, exception messages, support-ticket calls, and backend-owned release-artifact behavior.

## Verification

- RED: focused public verifier test failed because no `KafkaJS real-user smoke` existed after the BullMQ smoke.
- GREEN: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_node_queue_high_load_smoke` passed after adding the verifier step.
- GREEN: `npm test --prefix js/logbrew-kafkajs` passed.
- GREEN: `bash scripts/real_user_kafkajs_smoke.sh` passed. It packs `@logbrew/sdk`, `@logbrew/node`, and `@logbrew/kafkajs`, installs them in a temporary npm app with `kafkajs@2.2.4`, proves TypeScript/CJS/ESM package surfaces, producer header injection without mutating caller records, single-message parent-child correlation, malformed propagation fallback, type-only processor failure spans, batch message counts and links, local 503-to-202 fake-intake retry, and no message key/value/header/error-message leakage.
- GREEN: `python3 scripts/check_js_sources.py`, `bash scripts/check_js_lint.sh`, `bash scripts/check_js_package.sh`, and `python3 scripts/check_release_metadata.py` passed for the touched JS/package metadata scope.

## Remaining Gaps

Sentry, Datadog, and OpenTelemetry remain stronger for automatic KafkaJS patching, automatic transaction wrapping, key/partition/offset diagnostics, data-stream monitoring, baggage/tracestate, metrics, and broader automatic broker integrations. The next LogBrew queue priorities are AMQP/RabbitMQ and SQS-style integration packages, followed by optional automatic framework-owned instrumentation only when installed-artifact proof and privacy limits justify the coupling.
