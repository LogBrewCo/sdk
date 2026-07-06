# Node BullMQ Tracing - 2026-06-25

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@3bfeb64e312fbafbd6fea4b2aafdb73ea94febec`.
- Read `packages/nestjs/src/integrations/helpers.ts`: `getBullMQProcessSpanOptions(...)`.
- Read `packages/nestjs/src/integrations/sentry-nest-bullmq-instrumentation.ts`: `SentryNestBullMQInstrumentation`, `_getProcessorFileInstrumentation(...)`, and `_createWrapProcessor()`.
- Datadog dd-trace-js: `DataDog/dd-trace-js@afbb68cf58da0cc997f35118c7f1a8a56385837d`.
- Read `packages/datadog-plugin-bullmq/src/producer.js`: `QueueAddPlugin`, `QueueAddBulkPlugin`, `injectTraceContext(...)`, `_injectIntoOpts(...)`, and `setProducerCheckpoint(...)`.
- Read `packages/datadog-plugin-bullmq/src/consumer.js`: `BullmqConsumerPlugin`, `bindStart(...)`, `setConsumerCheckpoint(...)`, and `_extractDatadog(...)`.
- Read `packages/datadog-plugin-bullmq/test/index.spec.js`: queue add, addBulk, worker process, and error-path span assertions.
- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039`; `git grep -i bullmq` found no first-party BullMQ instrumentation.
- BullMQ source: `taskforcesh/bullmq@d65a2b411e7a5dc31ce08faf6f646280f570cf5e`.
- Read `src/classes/queue.ts`: `Queue.add(...)` and `Queue.addBulk(...)`.
- Read `src/classes/worker.ts`: processor assignment and `callProcessJob(...)`.
- 2026-06-28 refresh: Sentry JavaScript `getsentry/sentry-javascript@54e995da76381f18f61f39b0ceecadf5a0b06b11`; re-read `packages/nestjs/src/integrations/sentry-nest-bullmq-instrumentation.ts` (`SentryNestBullMQInstrumentation`, `_getProcessorFileInstrumentation(...)`, `_createWrapProcessor()`) and `packages/nestjs/src/integrations/helpers.ts` (`getBullMQProcessSpanOptions(...)`).
- 2026-06-28 refresh: Datadog dd-trace-js `DataDog/dd-trace-js@27dcc31908d9a6264b1536a2118534c8bc4da0f6`; re-read `packages/datadog-plugin-bullmq/src/producer.js` (`QueueAddPlugin`, `QueueAddBulkPlugin`, `_injectIntoOpts(...)`, `setProducerCheckpoint(...)`) and `packages/datadog-plugin-bullmq/src/consumer.js` (`BullmqConsumerPlugin`, `_extractDatadog(...)`, `setConsumerCheckpoint(...)`).
- 2026-06-28 refresh: OpenTelemetry JS contrib `open-telemetry/opentelemetry-js-contrib@eb98ccc85069304a1f0c2e6b33be1b2ca961b4be`; `git grep -i bullmq` still found no first-party BullMQ instrumentation.
- 2026-06-28 processor-method follow-up: re-read the same Sentry NestJS BullMQ decorator wrapper and Datadog worker consumer plugin before adding LogBrew's explicit processor-object method instrumentation.
- 2026-07-06 FlowProducer refresh: Sentry JavaScript `getsentry/sentry-javascript@989396c8f4e390b02dd62bc1ad2c271c449bd79c`; re-read `packages/nestjs/src/integrations/sentry-nest-bullmq-instrumentation.ts` (`SentryNestBullMQInstrumentation`, `_createWrapProcessor()`) and `packages/nestjs/src/integrations/helpers.ts` (`getBullMQProcessSpanOptions(...)`).
- 2026-07-06 FlowProducer refresh: Datadog dd-trace-js `DataDog/dd-trace-js@02cb1a1fc744c4589385d91c674a6c5720a5d747`; read `packages/datadog-plugin-bullmq/src/producer.js` (`BaseBullmqProducerPlugin`, `QueueAddPlugin`, `QueueAddBulkPlugin`, `FlowProducerAddPlugin`, `_injectIntoOpts(...)`, `setProducerCheckpoint(...)`), `packages/datadog-plugin-bullmq/test/index.spec.js` (`FlowProducer.add()` span assertions), `packages/datadog-plugin-bullmq/test/producer-inject.spec.js` (`FlowProducerAdd.shouldInstrument(...)` filter cases), and `packages/datadog-plugin-bullmq/test/integration-test/server-flow-producer-add.mjs`.
- 2026-07-06 FlowProducer refresh: OpenTelemetry JS contrib `open-telemetry/opentelemetry-js-contrib@07607d0adab59f87c0e517075fa1fbd41c18f99e`; scoped search found no first-party BullMQ instrumentation.
- 2026-07-06 FlowProducer refresh: PostHog JS `PostHog/posthog-js@26b92fea20b9cf4c64ce251857aead8e859ed66c`; scoped search found no BullMQ or FlowProducer instrumentation.

## Competitor Pattern

Sentry supports BullMQ through NestJS instrumentation. It wraps the `@Processor` decorator, replaces the class `process` method, forks isolation scope per job, creates a `queue.process` span with `messaging.system = bullmq`, and captures thrown errors.

Datadog has a first-class BullMQ plugin. It instruments `Queue.add`, `Queue.addBulk`, `FlowProducer.add`, and worker processing, creates producer/consumer spans, records safe messaging tags, injects trace context into BullMQ `opts.telemetry.metadata`, extracts it on the worker side, and adds data-stream checkpoints. Its tests cover happy and error paths for add, addBulk, FlowProducer add, and processing.

The tradeoff is heavier hidden behavior: module patching, hook-prefix coupling, metadata mutation, data-stream metadata, and broader error payload behavior. OpenTelemetry JS contrib did not show a current BullMQ package in the public source checked.

## LogBrew Implementation

LogBrew now adds `@logbrew/bullmq` as a small explicit integration package.

- `bullMqQueueAddWithLogBrewSpan(...)` wraps app-owned `queue.add(...)`.
- `bullMqQueueAddBulkWithLogBrewSpan(...)` wraps app-owned `queue.addBulk(...)`.
- `withLogBrewBullMqProcessor(...)` wraps app-owned worker processors.
- `instrumentLogBrewBullMqProcessor(...)` optionally wraps one app-owned processor object's method, including NestJS-style `WorkerHost.process`, preserves `this` and extra method arguments, rejects duplicate LogBrew instrumentation, and supports clean `uninstall()`.
- `bullMqFlowProducerAddWithLogBrewSpan(...)` wraps app-owned `FlowProducer.add(...)` calls, emits one producer span, and recursively merges the same normalized LogBrew `traceparent` into the root flow job and child jobs.
- `instrumentLogBrewBullMqFlowProducer(...)` optionally wraps only one app-owned FlowProducer instance's `add()` method, preserves call options and extra arguments, rejects duplicate LogBrew instrumentation, and supports clean `uninstall()`.
- `createLogBrewBullMqFlowJob(...)` clones a flow tree before adding LogBrew trace metadata so application-owned flow objects are not mutated.
- `createLogBrewBullMqJobOptions(...)` merges one normalized LogBrew `traceparent` into BullMQ `opts.telemetry.metadata` when metadata is valid JSON.
- `extractLogBrewBullMqTraceparent(...)` reads only that LogBrew trace context for consumer spans.
- `instrumentLogBrewBullMqQueue(...)` optionally wraps only an app-owned queue instance's `add()` and `addBulk()` methods, rejects duplicate LogBrew instrumentation, and supports clean `uninstall()`.
- Malformed metadata is ignored for propagation instead of breaking queue work.
- The package avoids global BullMQ/NestJS patching, Redis connection capture, job payload capture, arbitrary headers, full URLs, baggage, tracestate, queue creation, Redis ownership, and support-ticket calls.

## Verification

- RED: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_node_queue_high_load_smoke` failed because no BullMQ real-user smoke ran after the Node queue high-load smoke.
- GREEN: the same focused verifier test passed after wiring `bash scripts/real_user_bullmq_smoke.sh`.
- GREEN: `npm test --prefix js/logbrew-bullmq` passed.
- GREEN: `python3 scripts/check_release_metadata.py` passed with `@logbrew/bullmq` included in public JS package metadata.
- GREEN: `bash scripts/real_user_bullmq_smoke.sh` passed after installing packed `@logbrew/sdk`, `@logbrew/node`, `@logbrew/bullmq`, and `bullmq@5.79.1` into a temporary app. It proves TypeScript declarations, CJS/ESM exports, producer traceparent injection, consumer parent-child trace correlation, malformed metadata fallback, type-only processor failure spans, `addBulk` message counts, local 503-to-202 retry, and no job payload or processor error message leakage.
- GREEN: `python3 scripts/check_js_sources.py`, `bash scripts/check_js_lint.sh`, `bash scripts/check_js_package.sh`, and `python3 -m unittest tests.test_check_public_sdks` passed.
- 2026-06-28 RED: `bash scripts/real_user_bullmq_smoke.sh` failed in installed TypeScript because `instrumentLogBrewBullMqQueue` was not exported.
- 2026-06-28 GREEN: the same installed smoke passed after adding queue-instance instrumentation. It now proves TypeScript/CJS/ESM exports, app-owned `this` binding preservation, `add()` and `addBulk()` traceparent injection, duplicate-install rejection, clean uninstall, local fake-intake flush, and no instrumented job payload leakage.
- 2026-06-28 RED: `bash scripts/real_user_bullmq_smoke.sh` failed in installed TypeScript because `instrumentLogBrewBullMqProcessor` was not exported.
- 2026-06-28 GREEN: the same installed smoke passed after adding processor-method instrumentation. It now proves TypeScript/CJS/ESM exports, NestJS-style processor object wrapping, `this` and extra argument preservation, parent-child trace correlation from BullMQ job metadata, duplicate-install rejection, clean uninstall, local fake-intake flush, and no job payload or error-message leakage.
- 2026-07-06 RED: `bash scripts/real_user_bullmq_smoke.sh` failed in installed TypeScript because `bullMqFlowProducerAddWithLogBrewSpan`, `createLogBrewBullMqFlowJob`, and `instrumentLogBrewBullMqFlowProducer` were not exported.
- 2026-07-06 GREEN: the same installed smoke passed after adding FlowProducer support. It now proves TypeScript/CJS/ESM exports, direct FlowProducer helper use, root and child flow traceparent propagation, existing flow metadata preservation, malformed flow metadata fallback, app-owned `this`/options/extra-argument preservation, duplicate-install rejection, clean uninstall, local fake-intake 503-to-202 retry/flush, and no flow job payload leakage.

## Remaining Gaps

- Sentry remains stronger for hidden automatic NestJS BullMQ decorator instrumentation.
- Datadog remains stronger for hidden automatic BullMQ worker and FlowProducer instrumentation, data-stream monitoring, producer filters, and deeper runtime hooks.
- LogBrew is now stronger for explicit app-owned queue, processor, and FlowProducer wrapping with clean uninstall, recursive child-flow propagation, and bounded telemetry, but still weaker for zero-code setup. Consider optional framework-owned NestJS decorators only if real-user evidence says the ergonomics outweigh the privacy and hidden-patching cost.
