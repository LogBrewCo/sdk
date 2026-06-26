# Node amqplib / RabbitMQ Tracing - 2026-06-26

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@b534db472f01f999f989d6ca96a037fa39ba47f0`.
- Read `packages/node/src/integrations/tracing/amqplib/index.ts`: `amqplibIntegration(...)` and `instrumentAmqplib(...)`.
- Read `packages/node/src/integrations/tracing/amqplib/vendored/instrumentation.ts`: module definitions for `amqplib/lib/channel_model.js`, `amqplib/lib/callback_model.js`, `amqplib/lib/connect.js`, and patches for `Channel.prototype.publish`, `Channel.prototype.consume`, and `ConfirmChannel.prototype.publish`.
- Read `packages/node/src/integrations/tracing/amqplib/vendored/patches.ts`: `getPublishPatch(...)`, `getConfirmedPublishPatch(...)`, and `getConsumePatch(...)`.
- Read `packages/node/src/integrations/tracing/amqplib/vendored/utils.ts`: `getHeaderAsString(...)`, `startPublishSpan(...)`, `startConsumeSpan(...)`, connection attribute parsing, exchange normalization, and Sentry trace propagation into AMQP headers.
- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039`.
- Read `packages/instrumentation-amqplib/src/amqplib.ts`: `AmqplibInstrumentation`, `getPublishPatch(...)`, `getConfirmedPublishPatch(...)`, `getConsumePatch(...)`, `createPublishSpan(...)`, `endConsumerSpan(...)`, propagation injection/extraction, optional consume links, and ack/nack span ending.
- Read `packages/instrumentation-amqplib/src/types.ts`: publish/consume hooks, consume-end hooks, `consumeTimeoutMs`, and `useLinksForConsume`.
- Datadog dd-trace-js: `DataDog/dd-trace-js@0194454747cc0c2ddbefaeeb4f37d4866bb006c4`.
- Read `packages/datadog-plugin-amqplib/src/producer.js`: `AmqplibProducerPlugin.start(...)` and `bindStart(...)`.
- Read `packages/datadog-plugin-amqplib/src/consumer.js`: `AmqplibConsumerPlugin.start(...)`, `bindStart(...)`, and header extraction.
- Read `packages/datadog-plugin-amqplib/src/client.js`: command span metadata and header injection.
- amqplib: `amqp-node/amqplib@f7503e571a80dacfc863c2690ab797d31667b868`.
- Read `lib/channel_model.js`: `publish(...)`, `sendToQueue(...)`, and `consume(...)`.
- Read `lib/callback_model.js`: callback-channel `publish(...)`, `sendToQueue(...)`, and `consume(...)`.
- Read `lib/api_args.js`: `Args.publish(...)`, including the user-provided `options.headers` cloning behavior used by amqplib itself.

## Competitor Pattern

Sentry vendors OpenTelemetry AMQP instrumentation and automatically patches `amqplib`. It creates producer spans for `publish`, consumer spans for `consume`, confirm-channel spans that end on broker confirmation callbacks, and continues producer traces from AMQP message headers. Sentry uses Sentry trace headers and baggage, emits connection and messaging semantic attributes, and stores spans on messages until ack/nack/timeout.

OpenTelemetry patches the same `amqplib` internals, injects and extracts propagation through message headers, supports hooks for custom attributes, can link consumed messages instead of continuing traces, and tracks ack/nack/channel-close span endings. Datadog instruments AMQP producer, consumer, and client commands, injects trace context into headers, extracts from `message.properties.headers`, tags queue/exchange/routing metadata, and adds data-stream checkpoints.

The tradeoff is broad runtime coupling: hidden module patching, version-specific internals, message/header mutation, broker URL or host/port metadata, consumer-tag and message ID/correlation ID capture, payload-size data-stream monitoring, baggage/tracestate or vendor propagation, and ack/nack lifecycle tracking that can retain message references until timeout.

## LogBrew Implementation

`@logbrew/amqplib` adds explicit app-owned RabbitMQ helpers:

- `amqplibPublishWithLogBrewSpan(...)`
- `amqplibSendToQueueWithLogBrewSpan(...)`
- `withLogBrewAmqplibConsumer(...)`
- `createLogBrewAmqplibPublishOptions(...)`
- `extractLogBrewAmqplibTraceparent(...)`

Producer helpers run through the existing `@logbrew/node` queue span path, clone publish options and headers, add exactly one normalized W3C `traceparent`, and then call the app-owned channel. Consumer helpers continue a valid `traceparent` from `message.properties.headers`; malformed propagation falls back to a new trace without failing message processing. `null` consumer-cancel notifications pass through without creating telemetry.

Spans include privacy-bounded metadata such as `messaging.system=rabbitmq`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, `amqpExchange`, and `amqpRoutingKey`.

The package intentionally avoids hidden `amqplib` patching, connection/channel/ack/nack/confirm ownership, broker URLs, host names, ports, consumer tags, arbitrary headers, message bodies, message IDs, correlation IDs, payload sizes, baggage, tracestate, stack traces, exception messages, support-ticket calls, and backend-owned release-artifact behavior.

## Verification

- RED: `bash scripts/real_user_amqplib_smoke.sh` failed because `js/logbrew-amqplib` did not exist.
- GREEN: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_node_queue_high_load_smoke` passed after adding the public verifier step.
- GREEN: `npm test --prefix js/logbrew-amqplib` passed.
- GREEN: `bash scripts/real_user_amqplib_smoke.sh` passed. It packs `@logbrew/sdk`, `@logbrew/node`, and `@logbrew/amqplib`, installs them in a temporary npm app with `amqplib@2.0.1`, proves TypeScript/CJS/ESM package surfaces, producer `traceparent` injection without mutating caller publish options, single-message parent-child consumer correlation, `null` consumer-cancel passthrough without telemetry, malformed propagation fallback, type-only processor failure spans, local 503-to-202 fake-intake retry, and no message body/header/correlation/message-id/error-message leakage.

## Remaining Gaps

Sentry, Datadog, and OpenTelemetry remain stronger for automatic `amqplib` patching, confirm-channel lifecycle spans, ack/nack/reject/channel-close ending, custom hooks, consume span links, baggage/tracestate, broker command spans, data-stream monitoring, and automatic connection metadata. The next LogBrew queue priorities are SQS-style helpers and optional heavier automatic broker instrumentation only if source-backed proof shows the user value outweighs privacy/runtime coupling.
