# Node KafkaJS Tracing - 2026-06-25

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@54e995da76381f18f61f39b0ceecadf5a0b06b11`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/instrumentation.ts`: `KafkaJsInstrumentation`, `_getProducerPatch()`, `_getConsumerPatch()`, `_getSendPatch()`, `_getSendBatchPatch()`, `_getConsumerEachMessagePatch()`, and `_getConsumerEachBatchPatch()`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/utils.ts`: `getHeaderAsString(...)`, `getLinksFromHeaders(...)`, `startConsumerSpan(...)`, `startProducerSpan(...)`, and `endSpansOnPromise(...)`.
- Read `packages/node/src/integrations/tracing/kafka/vendored/semconv.ts` for Kafka messaging semantic keys.
- Datadog dd-trace-js: `DataDog/dd-trace-js@27dcc31908d9a6264b1536a2118534c8bc4da0f6`.
- Read `packages/datadog-plugin-kafkajs/src/producer.js`, `consumer.js`, `batch-consumer.js`, and `utils.js`: producer/consumer plugins inject and extract trace headers, set topic/batch metadata, track partition/offset commit details, and add data-stream checkpoints.
- Read `packages/datadog-plugin-kafkajs/test/index.spec.js`: tests cover producer/consumer spans, mutation boundaries, older broker header-injection behavior, error tagging, offsets, and batch behavior.
- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@eb98ccc85069304a1f0c2e6b33be1b2ca961b4be`.
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

### 2026-06-28 Follow-Up: Owned Instance Instrumentation

The first LogBrew pass was safer than competitors but still weaker for setup
ergonomics because every send and callback had to be wrapped manually. Current
Sentry/OpenTelemetry source still wraps producer and consumer factory results;
Datadog still provides producer, consumer, and batch-consumer plugin layers with
automatic header propagation and richer offset/data-stream metadata.

LogBrew now adds explicit instance-level helpers:

- `instrumentLogBrewKafkaJsProducer(producer, options)`
- `instrumentLogBrewKafkaJsConsumer(consumer, options)`

Apps pass owned KafkaJS objects. LogBrew wraps only those objects, preserves
method `this` plus call arguments, clones producer records/batches before
injecting one normalized W3C `traceparent`, clones `consumer.run(...)` config
before wrapping `eachMessage`/`eachBatch`, rejects duplicate installs, and
returns `uninstall()`. This closes most real-user setup friction versus hidden
patching while keeping LogBrew's privacy boundary: no global module patching,
no broker URLs, no offsets/partitions, no arbitrary header capture, no message
payloads, no baggage/tracestate, and no data-stream monitoring.

## Verification

- RED: focused public verifier test failed because no `KafkaJS real-user smoke` existed after the BullMQ smoke.
- GREEN: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_node_queue_high_load_smoke` passed after adding the verifier step.
- GREEN: `npm test --prefix js/logbrew-kafkajs` passed.
- GREEN: `bash scripts/real_user_kafkajs_smoke.sh` passed. It packs `@logbrew/sdk`, `@logbrew/node`, and `@logbrew/kafkajs`, installs them in a temporary npm app with `kafkajs@2.2.4`, proves TypeScript/CJS/ESM package surfaces, producer header injection without mutating caller records, single-message parent-child correlation, malformed propagation fallback, type-only processor failure spans, batch message counts and links, local 503-to-202 fake-intake retry, and no message key/value/header/error-message leakage.
- GREEN: `python3 scripts/check_js_sources.py`, `bash scripts/check_js_lint.sh`, `bash scripts/check_js_package.sh`, and `python3 scripts/check_release_metadata.py` passed for the touched JS/package metadata scope.
- GREEN: 2026-06-28 follow-up `bash scripts/real_user_kafkajs_smoke.sh` passed after a RED TypeScript failure for missing `instrumentLogBrewKafkaJsProducer` and `instrumentLogBrewKafkaJsConsumer` exports. The smoke proves packed-tarball README docs, TypeScript/CJS/ESM exports, owned producer `send` instrumentation, owned consumer `run` instrumentation, config cloning, method `this` and extra argument preservation, duplicate install rejection, clean uninstall, trace-log/span correlation through fake KafkaJS messages, local 503-to-202 fake-intake retry, and no message payload/header/error-detail leakage.

## Remaining Gaps

Sentry, Datadog, and OpenTelemetry remain stronger for hidden automatic KafkaJS
patching, transaction wrapping, key/partition/offset diagnostics, data-stream
monitoring, baggage/tracestate, metrics, and broader automatic broker
integrations. LogBrew is now simpler and safer for explicit owned-object setup,
but not yet better for zero-code KafkaJS instrumentation or broker-depth
diagnostics.
