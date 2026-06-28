# Node SQS Tracing - 2026-06-26

## Sources Read

- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@eb98ccc85069304a1f0c2e6b33be1b2ca961b4be`.
- Read `packages/instrumentation-aws-sdk/src/services/MessageAttributes.ts`: `injectPropagationContext(...)`, `extractPropagationContext(...)`, `addPropagationFieldsToAttributeNames(...)`, `MAX_MESSAGE_ATTRIBUTES`, and SQS/SNS text-map getter/setter behavior.
- Read `packages/instrumentation-aws-sdk/src/services/sqs.ts`: `SqsServiceExtension`, `requestPreSpanHook(...)`, `requestPostSpanHook(...)`, `responseHook(...)`, `extractQueueUrl(...)`, and `extractQueueNameFromUrl(...)`.
- Read `packages/instrumentation-aws-sdk/src/services/sns.ts`: `SnsServiceExtension`, producer span classification, SNS destination metadata, and message-attribute propagation injection.
- Read `packages/instrumentation-aws-sdk/src/types.ts`: `sqsExtractContextPropagationFromPayload` opt-in payload extraction contract.
- Read `packages/instrumentation-aws-sdk/test/MessageAttributes.test.ts`, `test/aws-sdk-v3-sqs.test.ts`, and `test/sns.test.ts` for receive-link, message-attribute, and SNS publish behavior.
- Sentry JavaScript: `getsentry/sentry-javascript@54e995da76381f18f61f39b0ceecadf5a0b06b11`.
- Read `packages/aws-serverless/src/integration/aws/vendored/services/sqs.ts`: vendored `SqsServiceExtension`, request pre/post hooks, response hooks, producer/consumer span classification, receive span links, and send-message propagation injection.
- Read `packages/aws-serverless/src/integration/aws/vendored/services/MessageAttributes.ts`: vendored propagation field injection/extraction and SQS ten-attribute limit behavior.
- Read `packages/aws-serverless/src/integration/aws/vendored/services/sns.ts`: vendored SNS producer span classification, topic metadata, and message-attribute propagation injection.
- Datadog dd-trace-js: `DataDog/dd-trace-js@27dcc31908d9a6264b1536a2118534c8bc4da0f6`.
- Read `packages/datadog-plugin-aws-sdk/src/services/sqs.js`: `Sqs`, `getEventBridgeContext(...)`, `operationFromRequest(...)`, `isEnabled(...)`, `generateTags(...)`, `responseExtract(...)`, `parseMessageCarrier(...)`, `parseDatadogAttributes(...)`, `requestInject(...)`, `injectToMessage(...)`, and receive parent/link handling.
- Read `packages/datadog-plugin-aws-sdk/src/services/sns.js`: `Sns`, `requestInject(...)`, `injectToMessage(...)`, SNS batch propagation behavior, and message-attribute quota handling.
- Read `packages/datadog-plugin-aws-sdk/src/services/eventbridge.js`: `EventBridge`, `putEventEntrySize(...)`, `requestInject(...)`, JSON detail injection, and 1 MiB request-size guard.
- Read `packages/datadog-plugin-aws-sdk/test/sqs-inject-to-message.spec.js`: direct SQS, SNS-to-SQS, EventBridge-to-SQS, SNS-wrapped EventBridge, malformed body, and attribute-priority extraction cases.
- Read `packages/datadog-plugin-aws-sdk/test/eventbridge.spec.js`: EventBridge detail injection and request-size guard tests.
- AWS SDK JavaScript v3: `aws/aws-sdk-js-v3@b6d6a759f15f2c36745fb85905a90533998cae0e`.
- Read `clients/client-sqs/src/commands/SendMessageCommand.ts`, `SendMessageBatchCommand.ts`, `ReceiveMessageCommand.ts`, and `clients/client-sqs/src/models/models_0.ts` for command input shape, `MessageAttributes`, batch entries, receive `MessageAttributeNames`, and the ten-message-attribute service limit.

## Competitor Pattern

Sentry vendors the OpenTelemetry AWS SDK SQS instrumentation in its JavaScript serverless integration. It classifies SQS send calls as producer spans, receive calls as consumer spans, injects propagation into `MessageAttributes`, requests propagation fields during receive, and links received message contexts back to the receive span.

OpenTelemetry instruments AWS SDK SQS automatically through the AWS SDK instrumentation package. It injects propagation into `MessageAttributes` for `SendMessage`, `SendMessageBatch`, and SNS `Publish`, requests propagation fields during `ReceiveMessage`, and links received message contexts to the receive span. It respects SQS' ten-message-attribute limit before injection. It can optionally parse a message body to recover SNS-to-SQS propagation.

Datadog instruments SQS, SNS, and EventBridge automatically as part of its AWS SDK plugin. It creates producer and consumer operation spans, tags queue metadata, extracts propagation from direct message attributes, parses SNS notification bodies, parses EventBridge envelopes and SNS-wrapped EventBridge envelopes, handles batch receives by using the first propagated context as parent and later contexts as span links, and adds data-stream monitoring context. Its EventBridge producer path injects context into JSON `Detail` only when the full PutEvents request remains under the service size limit.

The tradeoff is broader hidden runtime coupling: AWS SDK patching, queue URL/resource metadata, optional body parsing, vendor propagation fields, data-stream metadata, EventBridge JSON mutation, and more runtime behavior that can surprise privacy-conscious applications.

## LogBrew Implementation

`@logbrew/aws-sqs` adds explicit app-owned SQS helpers:

- `instrumentLogBrewSqsClient(...)`
- `sqsSendMessageWithLogBrewSpan(...)`
- `sqsSendMessageBatchWithLogBrewSpan(...)`
- `sqsReceiveMessageWithLogBrewSpan(...)`
- `withLogBrewSqsMessageProcessor(...)`
- `createLogBrewSqsSendMessageInput(...)`
- `createLogBrewSqsSendMessageBatchInput(...)`
- `createLogBrewSqsReceiveMessageInput(...)`
- `createLogBrewSqsTraceLinks(...)`
- `extractLogBrewSqsTraceparent(...)`

Producer helpers clone AWS SDK v3 command inputs, add one normalized W3C `traceparent` message attribute when the ten-attribute SQS limit permits it, and call the app-owned `SQSClient.send()` with the command constructor supplied by the app. Receive helpers clone receive inputs, request the `traceparent` message attribute, and add bounded span links from returned messages. Message processors continue valid incoming `traceparent` values from `MessageAttributes`; malformed propagation falls back to a new trace.

The follow-up `instrumentLogBrewSqsClient(...)` helper narrows the automatic instrumentation gap without adopting global patching. Apps explicitly pass one owned SQS client plus the three AWS SDK v3 command constructors; LogBrew wraps only that client's `send()` method, detects `SendMessageCommand`, `SendMessageBatchCommand`, and `ReceiveMessageCommand`, reuses the same safe helper paths, passes unknown commands and AWS SDK send options through, blocks double-install, and reinstates the prior `send()` function on `uninstall()`.

The SNS/EventBridge follow-up adds explicit, bounded receive-side envelope extraction without hidden patching. `extractLogBrewSqsTraceparent(...)`, `createLogBrewSqsTraceLinks(...)`, `sqsReceiveMessageWithLogBrewSpan(...)`, `withLogBrewSqsMessageProcessor(...)`, and `instrumentLogBrewSqsClient(...)` now accept `extractSnsEnvelopeTraceparent`, `extractEventBridgeEnvelopeTraceparent`, and `maxEnvelopeBytes`. Direct SQS message attributes still win. When opted in, LogBrew parses only bounded JSON bodies, reads SNS `MessageAttributes.traceparent.Value`, or reads EventBridge `detail.traceparent` including SNS-wrapped EventBridge messages, normalizes the W3C traceparent, and drops malformed values. Extraction control flags are stripped before span capture so they do not become telemetry metadata.

The SNS/EventBridge producer follow-up narrows another Sentry/Datadog gap while staying explicit. `snsPublishWithLogBrewSpan(...)`, `snsPublishBatchWithLogBrewSpan(...)`, `eventBridgePutEventsWithLogBrewSpan(...)`, `createLogBrewSnsPublishInput(...)`, `createLogBrewSnsPublishBatchInput(...)`, and `createLogBrewEventBridgePutEventsInput(...)` clone app-owned AWS SDK v3 inputs, inject one normalized W3C `traceparent`, and call app-owned clients with command constructors supplied by the app. SNS uses the same ten-message-attribute guard as SQS. EventBridge injects into JSON `Detail` only when the cloned `PutEvents` request remains below the AWS request-size bound; non-JSON or oversized entries stay unchanged.

The package intentionally avoids hidden/global AWS SDK patching, queue URL capture, queue ARN/account/region capture, arbitrary message attributes, message bodies, SNS messages, EventBridge details, receipt handles, message IDs, event IDs, MD5 values, payload sizes, baggage, tracestate, data-stream monitoring, stack traces, exception messages, support-ticket calls, and hosted release-artifact claims. The opt-in body parsing and producer injection paths return or send only a normalized `traceparent` and never send body, SNS message, EventBridge detail, or malformed propagation bytes to LogBrew.

## Verification

- RED: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_node_queue_high_load_smoke` failed because no `SQS real-user smoke` existed after the AMQP smoke.
- GREEN: the same focused verifier test passed after wiring `bash scripts/real_user_aws_sqs_smoke.sh`.
- GREEN: `npm test --prefix js/logbrew-aws-sqs` passed.
- GREEN: `bash scripts/real_user_aws_sqs_smoke.sh` passed. It packs `@logbrew/sdk`, `@logbrew/node`, and `@logbrew/aws-sqs`, installs them in a temporary npm app with `@aws-sdk/client-sqs@3.1075.0`, proves TypeScript/CJS/ESM package surfaces, producer traceparent message-attribute injection without mutating caller command inputs, receive-input trace attribute requests, SQS ten-attribute limit behavior, receive span links, single-message parent-child processor correlation, type-only processor failure spans, local 503-to-202 fake-intake retry, and no queue URL/body/message-attribute/message-id/receipt-handle/error-detail leakage.
- GREEN high-load proof: the same installed smoke sends 1,200 traced SQS `SendMessageCommand` operations through a fake app-owned SQS client, verifies the 1,000-event in-memory queue bound, 200 `queue_overflow` drop callbacks, app result preservation, local 503-to-202 fake-intake retry, flushed-event count, and no message body, generated message ID, account-like QueueUrl segment, host, or dropped-event leakage.
- GREEN instrumentation proof: the installed smoke typechecks `instrumentLogBrewSqsClient(...)`, checks CommonJS/default exports, wraps a fake app-owned SQS client, proves automatic send/batch/receive tracing through normal `client.send(new Command(...))`, preserves AWS SDK send options, passes unknown commands through, rejects duplicate install, puts the prior `send()` function back on uninstall, and proves the instrumentation payload through local 503-to-202 fake-intake retry with the same redaction boundaries.
- RED SNS/EventBridge envelope proof: `bash scripts/real_user_aws_sqs_smoke.sh` failed in the installed temporary app with `SQS helper did not extract SNS envelope traceparent`.
- GREEN SNS/EventBridge envelope proof: the same installed smoke now proves default no-body-parse behavior, opt-in SNS notification traceparent extraction, opt-in EventBridge `detail.traceparent` extraction, SNS-wrapped EventBridge extraction, malformed JSON/value fallback, receive-span links from an SNS envelope, processor parent-child continuation from the SNS envelope, TypeScript option types, CommonJS/default exports, fake-intake retry, and no SNS payload, EventBridge detail, event id, queue URL/account/host, message body, message id, arbitrary attribute, or error-detail leakage.
- RED SNS/EventBridge producer proof: `bash scripts/real_user_aws_sqs_smoke.sh` failed after adding installed-app expectations for `snsPublishWithLogBrewSpan(...)` and `eventBridgePutEventsWithLogBrewSpan(...)` because the package README/API did not expose those helpers.
- GREEN SNS/EventBridge producer proof: the same installed smoke now packs `@logbrew/sdk`, `@logbrew/node`, and `@logbrew/aws-sqs`, installs them with `@aws-sdk/client-sns@3.1075.0`, `@aws-sdk/client-eventbridge@3.1075.0`, and `@aws-sdk/client-sqs@3.1075.0`, proves TypeScript/ESM/CommonJS exports, SNS publish and publish-batch traceparent injection without caller-input mutation, SNS ten-attribute guard behavior, EventBridge JSON `Detail` traceparent injection without caller-input mutation, non-JSON and oversized EventBridge no-op behavior, SNS/EventBridge producer spans with safe messaging metadata, local 503-to-202 fake-intake retry, the existing 1,200-operation queue pressure path, and no SNS/EventBridge payload, ARN, account-like value, event ID, message ID, source string, queue URL, host, or error-detail leakage.

## Remaining Gaps

Sentry, OpenTelemetry, and Datadog remain stronger for zero-code/global AWS SDK patching, data-stream monitoring, custom hooks, automatic cloud resource metadata, and broader AWS service coverage. LogBrew now has an opt-in one-client automatic SQS path plus explicit SNS/EventBridge receive and producer helpers, but should not add global AWS SDK patching or broader automatic AWS mutations unless source-backed proof shows they can stay privacy-bounded, predictable, and stable enough to justify the coupling.
