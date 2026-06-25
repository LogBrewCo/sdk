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

## Competitor Pattern

Sentry supports BullMQ through NestJS instrumentation. It wraps the `@Processor` decorator, replaces the class `process` method, forks isolation scope per job, creates a `queue.process` span with `messaging.system = bullmq`, and captures thrown errors.

Datadog has a first-class BullMQ plugin. It instruments `Queue.add`, `Queue.addBulk`, and worker processing, creates producer/consumer spans, records safe messaging tags, injects trace context into BullMQ `opts.telemetry.metadata`, extracts it on the worker side, and adds data-stream checkpoints. Its tests cover happy and error paths for add, addBulk, and processing.

The tradeoff is heavier hidden behavior: module patching, hook-prefix coupling, metadata mutation, data-stream metadata, and broader error payload behavior. OpenTelemetry JS contrib did not show a current BullMQ package in the public source checked.

## LogBrew Implementation

LogBrew now adds `@logbrew/bullmq` as a small explicit integration package.

- `bullMqQueueAddWithLogBrewSpan(...)` wraps app-owned `queue.add(...)`.
- `bullMqQueueAddBulkWithLogBrewSpan(...)` wraps app-owned `queue.addBulk(...)`.
- `withLogBrewBullMqProcessor(...)` wraps app-owned worker processors.
- `createLogBrewBullMqJobOptions(...)` merges one normalized LogBrew `traceparent` into BullMQ `opts.telemetry.metadata` when metadata is valid JSON.
- `extractLogBrewBullMqTraceparent(...)` reads only that LogBrew trace context for consumer spans.
- Malformed metadata is ignored for propagation instead of breaking queue work.
- The package avoids hidden BullMQ/NestJS patching, Redis connection capture, job payload capture, arbitrary headers, full URLs, baggage, tracestate, and support-ticket calls.

## Verification

- RED: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_node_queue_high_load_smoke` failed because no BullMQ real-user smoke ran after the Node queue high-load smoke.
- GREEN: the same focused verifier test passed after wiring `bash scripts/real_user_bullmq_smoke.sh`.
- GREEN: `npm test --prefix js/logbrew-bullmq` passed.
- GREEN: `python3 scripts/check_release_metadata.py` passed with `@logbrew/bullmq` included in public JS package metadata.
- GREEN: `bash scripts/real_user_bullmq_smoke.sh` passed after installing packed `@logbrew/sdk`, `@logbrew/node`, `@logbrew/bullmq`, and `bullmq@5.79.1` into a temporary app. It proves TypeScript declarations, CJS/ESM exports, producer traceparent injection, consumer parent-child trace correlation, malformed metadata fallback, type-only processor failure spans, `addBulk` message counts, local 503-to-202 retry, and no job payload or processor error message leakage.
- GREEN: `python3 scripts/check_js_sources.py`, `bash scripts/check_js_lint.sh`, `bash scripts/check_js_package.sh`, and `python3 -m unittest tests.test_check_public_sdks` passed.

## Remaining Gaps

- Sentry remains stronger for automatic NestJS BullMQ instrumentation.
- Datadog remains stronger for hidden automatic BullMQ instrumentation, data-stream monitoring, and deeper runtime hooks.
- LogBrew should keep the core package explicit, then consider optional framework-owned auto wrappers for NestJS BullMQ after more popular rich-trace gaps are closed and source-backed evidence shows the ergonomics are worth the extra surface.
