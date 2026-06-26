# Node SQS Tracing - 2026-06-26

## Sources Read

- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039`.
- Read `packages/instrumentation-aws-sdk/src/services/MessageAttributes.ts`: `injectPropagationContext(...)`, `extractPropagationContext(...)`, `addPropagationFieldsToAttributeNames(...)`, `MAX_MESSAGE_ATTRIBUTES`, and SQS/SNS text-map getter/setter behavior.
- Read `packages/instrumentation-aws-sdk/src/services/sqs.ts`: `SqsServiceExtension`, `requestPreSpanHook(...)`, `requestPostSpanHook(...)`, `responseHook(...)`, `extractQueueUrl(...)`, and `extractQueueNameFromUrl(...)`.
- Sentry JavaScript: `getsentry/sentry-javascript@b534db472f01f999f989d6ca96a037fa39ba47f0`.
- Read `packages/aws-serverless/src/integration/aws/vendored/services/sqs.ts`: vendored `SqsServiceExtension`, request pre/post hooks, response hooks, producer/consumer span classification, receive span links, and send-message propagation injection.
- Read `packages/aws-serverless/src/integration/aws/vendored/services/MessageAttributes.ts`: vendored propagation field injection/extraction and SQS ten-attribute limit behavior.
- Datadog dd-trace-js: `DataDog/dd-trace-js@0194454747cc0c2ddbefaeeb4f37d4866bb006c4`.
- Read `packages/datadog-plugin-aws-sdk/src/services/sqs.js`: `Sqs`, `operationFromRequest(...)`, `isEnabled(...)`, `generateTags(...)`, `responseExtract(...)`, `parseMessageCarrier(...)`, `parseDatadogAttributes(...)`, and receive span-link handling.
- AWS SDK JavaScript v3: `aws/aws-sdk-js-v3@b6d6a759f15f2c36745fb85905a90533998cae0e`.
- Read `clients/client-sqs/src/commands/SendMessageCommand.ts`, `SendMessageBatchCommand.ts`, `ReceiveMessageCommand.ts`, and `clients/client-sqs/src/models/models_0.ts` for command input shape, `MessageAttributes`, batch entries, receive `MessageAttributeNames`, and the ten-message-attribute service limit.

## Competitor Pattern

Sentry vendors the OpenTelemetry AWS SDK SQS instrumentation in its JavaScript serverless integration. It classifies SQS send calls as producer spans, receive calls as consumer spans, injects propagation into `MessageAttributes`, requests propagation fields during receive, and links received message contexts back to the receive span.

OpenTelemetry instruments AWS SDK SQS automatically through the AWS SDK instrumentation package. It injects propagation into `MessageAttributes` for `SendMessage` and every `SendMessageBatch` entry, requests propagation fields during `ReceiveMessage`, and links received message contexts to the receive span. It respects SQS' ten-message-attribute limit before injection. It can optionally parse a message body to recover SNS-to-SQS propagation.

Datadog instruments SQS automatically as part of its AWS SDK plugin. It creates producer and consumer operation spans, tags queue metadata, extracts propagation from message attributes, handles batch receives by using the first propagated context as parent and later contexts as span links, and adds data-stream monitoring context.

The tradeoff is broader hidden runtime coupling: AWS SDK patching, queue URL/resource metadata, optional body parsing, vendor propagation, data-stream metadata, and more runtime behavior that can surprise privacy-conscious applications.

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

The package intentionally avoids hidden/global AWS SDK patching, queue URL capture, queue ARN/account/region capture, arbitrary message attributes, message bodies, receipt handles, message IDs, MD5 values, payload sizes, baggage, tracestate, body parsing, data-stream monitoring, stack traces, exception messages, support-ticket calls, and backend-owned release-artifact behavior.

## Verification

- RED: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_node_queue_high_load_smoke` failed because no `SQS real-user smoke` existed after the AMQP smoke.
- GREEN: the same focused verifier test passed after wiring `bash scripts/real_user_aws_sqs_smoke.sh`.
- GREEN: `npm test --prefix js/logbrew-aws-sqs` passed.
- GREEN: `bash scripts/real_user_aws_sqs_smoke.sh` passed. It packs `@logbrew/sdk`, `@logbrew/node`, and `@logbrew/aws-sqs`, installs them in a temporary npm app with `@aws-sdk/client-sqs@3.1075.0`, proves TypeScript/CJS/ESM package surfaces, producer traceparent message-attribute injection without mutating caller command inputs, receive-input trace attribute requests, SQS ten-attribute limit behavior, receive span links, single-message parent-child processor correlation, type-only processor failure spans, local 503-to-202 fake-intake retry, and no queue URL/body/message-attribute/message-id/receipt-handle/error-detail leakage.
- GREEN high-load proof: the same installed smoke sends 1,200 traced SQS `SendMessageCommand` operations through a fake app-owned SQS client, verifies the 1,000-event in-memory queue bound, 200 `queue_overflow` drop callbacks, app result preservation, local 503-to-202 fake-intake retry, flushed-event count, and no message body, generated message ID, account-like QueueUrl segment, host, or dropped-event leakage.
- GREEN instrumentation proof: the installed smoke typechecks `instrumentLogBrewSqsClient(...)`, checks CommonJS/default exports, wraps a fake app-owned SQS client, proves automatic send/batch/receive tracing through normal `client.send(new Command(...))`, preserves AWS SDK send options, passes unknown commands through, rejects duplicate install, puts the prior `send()` function back on uninstall, and proves the instrumentation payload through local 503-to-202 fake-intake retry with the same redaction boundaries.

## Remaining Gaps

Sentry, OpenTelemetry, and Datadog remain stronger for zero-code/global AWS SDK patching, SNS-to-SQS/EventBridge body propagation recovery, data-stream monitoring, custom hooks, and automatic cloud resource metadata. LogBrew now has an opt-in one-client automatic path, but should not add global AWS SDK patching unless source-backed proof shows it can stay privacy-bounded and stable enough to justify the coupling.
