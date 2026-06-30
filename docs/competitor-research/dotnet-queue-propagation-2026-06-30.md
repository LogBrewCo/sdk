# .NET Queue Trace Propagation Comparison - 2026-06-30

## Scope

LogBrew .NET already had explicit database/cache/queue dependency spans, outbound `HttpClient` propagation, ASP.NET Core request helpers, Activity bridges, EF Core and Redis integrations, heavy logging backpressure, and installed-artifact proof. The remaining rich-trace gap for app-owned queue work was message propagation: producing one downstream `traceparent`, continuing one incoming message context, and linking consumed/batched messages without adding broker dependencies or capturing payloads.

## Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet@951d98f789ec6794a1bbd82149d900f06fde0cfa`.
- Searched public `src/` for `Kafka`, `RabbitMQ`, `MassTransit`, and `Confluent`; no first-party queue instrumentation was found. The only `RabbitMQ` hit was `src/Sentry/SentryOptions.cs` in an in-app exclude list.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@a2346ba4fa5455164534a8427e510acd877f00a9`.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Kafka/KafkaHelper.cs`: producer/consumer scope creation, Kafka topic/partition/offset/group tags, propagated context extraction/injection, and data-stream checkpoints.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Kafka/KafkaHeadersCollectionAdapter.cs`: string/binary Kafka header adapter, UTF-8 decode/encode, add/remove/get helpers.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Kafka/KafkaProduceAsyncIntegration.cs`: `Confluent.Kafka.Producer.ProduceAsync` wrapper, header injection, async close, and delivery metadata.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/RabbitMQ/RabbitMQIntegration.cs`: RabbitMQ producer/consumer scopes, headers extraction, queue/exchange/routing-key metadata, and message-size checkpoints.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/RabbitMQ/RabbitMQHeadersCollectionAdapter.cs`: binary header carrier for `IBasicProperties.Headers`.
- Read `tracer/src/Datadog.Trace/Configuration/Schema/MessagingSchema.cs`: inbound/outbound messaging operation names and service types.
- OpenTelemetry .NET contrib `open-telemetry/opentelemetry-dotnet-contrib@7e8040413042ee663a9ef4dd04ab52d1a17ed77b`.
- Read `src/OpenTelemetry.Instrumentation.ConfluentKafka/ConfluentKafkaCommon.cs`: ActivitySource, meter, and publish/receive/process operation names.
- Read `src/OpenTelemetry.Instrumentation.ConfluentKafka/InstrumentedProducer.cs`: publish Activity creation, status/error tagging, metrics, and `Propagators.DefaultTextMapPropagator.Inject(...)` into Kafka headers.
- Read `src/OpenTelemetry.Instrumentation.ConfluentKafka/InstrumentedConsumer.cs`: receive Activity creation, extraction from headers, Activity links, status/error tags, and metrics.
- Read `src/OpenTelemetry.Instrumentation.ConfluentKafka/OpenTelemetryConsumeResultExtensions.cs`: `TryExtractPropagationContext(...)`, `ConsumeAndProcessMessageAsync(...)`, process Activity creation, and `ActivityLink` use for message context.
- Read `src/OpenTelemetry.Instrumentation.ConfluentKafka/ConfluentKafkaInstrumentedProducerBuilderOptions.cs` and `ConfluentKafkaInstrumentedConsumerBuilderOptions.cs`: opt-in metrics/tracing builder flags.
- OpenTelemetry contrib `src/OpenTelemetry.Instrumentation.MassTransit` had no C# files in the inspected snapshot.
- PostHog .NET `PostHog/posthog-dotnet@8fad3ff84cda2c741f397e1152e58a7b96c98124`.
- Searched public `src/` for `Kafka`, `RabbitMQ`, `MassTransit`, and `Confluent`; no first-party queue instrumentation was found.

## Competitor Pattern

Datadog and OpenTelemetry are strongest for broker-specific queue tracing. Datadog uses profiler/CallTarget integrations and carrier adapters to instrument Kafka/RabbitMQ automatically. OpenTelemetry Confluent Kafka uses explicit instrumented builders/wrappers around producers and consumers, injects W3C propagation into headers, and uses Activity links for receive/process flows instead of always forcing an extracted message context as the parent.

Sentry .NET and PostHog .NET did not show public first-party Kafka/RabbitMQ/MassTransit queue instrumentation in the inspected snapshots. For this exact gap, LogBrew can become more useful than Sentry .NET with a small explicit helper, while Datadog/OpenTelemetry remain the richer automatic-instrumentation benchmark.

## LogBrew Change

- Added `SpanLinkSummary` and `SpanAttributes.WithLink(...)` / `WithLinks(...)` for bounded async/batch links. Link payloads serialize only `traceId`, `spanId`, `sampled`, and primitive metadata. They do not serialize raw `traceparent`, baggage, tracestate, headers, payloads, message bodies, broker URLs, or auth material.
- Added `QueueOperationOptions.WithTraceparentHeaderSetter(...)`. `LogBrewOperationTracing.QueueOperation(...)` now calls the app-owned setter exactly once after creating the queue child span and before the callback runs, so producers can attach one normalized `traceparent` to their message object.
- Added `QueueOperationOptions.WithIncomingTraceparent(...)`. Consumers can continue one valid incoming W3C message context; malformed values report through optional `OnError(...)` and fall back to the active trace or a new root without interrupting the queue operation.
- Added `QueueOperationOptions.WithLinkedMessageTraceparent(...)` for consumed/batched message links. Invalid linked contexts are dropped non-fatally through `OnError(...)`; more than eight links are capped.
- Updated packaged `DependencySpansTelemetry.cs`, README guidance, dependency payload verifier, and installed-artifact smoke proof.

## Where LogBrew Is Better

- Better than Sentry .NET and PostHog .NET for this inspected queue propagation gap: LogBrew now ships explicit queue `traceparent` injection, incoming continuation, and span links in the core package.
- Safer and lighter than Datadog/OpenTelemetry when an app wants app-owned queue instrumentation without a profiler, broker package dependency, global patching, payload/header capture, baggage, tracestate, or raw propagation serialization.
- More agent-readable for local verification: the temporary app proves package install, local payload shape, retry/failure/flush/shutdown, queue propagation, and privacy filtering without live broker infrastructure.

## Where LogBrew Is Still Worse

- Datadog and OpenTelemetry remain stronger for automatic Kafka/RabbitMQ/Confluent instrumentation, framework-specific semantic tags, metrics, data-stream context, broker delivery metadata, consumer group/offset handling, and transparent library wrapping.
- LogBrew still lacks dedicated Kafka/RabbitMQ/Azure Service Bus/AWS SQS integration packages, rich messaging metrics, baggage/tracestate, and full automatic outbound/DB/cache/queue instrumentation.
- Backend upload/symbolication and hosted trace views are separate contracts; this pass only improves SDK-side trace context and payload shape.

## Evidence

- RED test first: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` failed on missing `SpanLinkSummary`, `WithTraceparentHeaderSetter(...)`, `WithIncomingTraceparent(...)`, and `WithLinkedMessageTraceparent(...)`.
- GREEN focused test: same command passed with 69 tests.
- `bash scripts/check_dotnet_package.sh`: passed after updating the dependency-span payload verifier for the new fifth queue-process span and link summary.
- `bash scripts/real_user_dotnet_smoke.sh`: passed from packed NuGet packages installed into temporary apps; the smoke proves outgoing queue `traceparent`, incoming queue continuation, span link serialization, local HTTP 503-to-202 retry, auth/failure preservation, flush/shutdown, package metadata, and install/remove/reinstall.
- `bash scripts/real_user_dotnet_high_load_smoke.sh`: passed installed-artifact heavy logging pressure and bounded queue/drop behavior.
