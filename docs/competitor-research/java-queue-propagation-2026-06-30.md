# Java Queue Propagation - 2026-06-30

## Goal

Close a rich-tracing gap in the Java SDK where queue spans could record handler duration but could not propagate W3C context to app-owned message carriers, continue incoming message context, link batch messages, or show privacy-bounded time-in-queue. Then close the highest-value explicit Spring Kafka producer and consumer ergonomics gaps without turning the core SDK into an automatic broker-patching agent. Keep the core SDK safer than hidden instrumentation and prove behavior from packaged artifacts.

## Source Evidence

- Sentry Java: `https://github.com/getsentry/sentry-java.git` at `307edcd968452d07d801c46362bf98f815fea808`.
- Sentry files/functions read: `sentry-kafka/src/main/java/io/sentry/kafka/SentryKafkaProducer.java` (`wrap`, `instrumentedSend`, `maybeInjectHeaders`, `SENTRY_ENQUEUED_TIME_HEADER`, callback span finish), `sentry-kafka/src/main/java/io/sentry/kafka/SentryKafkaConsumerTracing.java` (`withTracing`, `startTransaction`, `continueTrace`), `sentry-spring/src/main/java/io/sentry/spring/kafka/SentryKafkaProducerBeanPostProcessor.java` (`postProcessAfterInitialization`, `SentryProducerPostProcessor.apply`), `sentry-spring/src/main/java/io/sentry/spring/kafka/SentryKafkaRecordInterceptor.java` (`intercept`, `continueTrace`, `startTransaction`, `finishSpan`), `sentry-spring/src/test/kotlin/io/sentry/spring/kafka/SentryKafkaRecordInterceptorTest.kt` (`sets receive latency from enqueued time in epoch seconds`), and `sentry-spring-boot/src/main/java/io/sentry/spring/boot/SentryAutoConfiguration.java` (`SentryKafkaQueueConfiguration`).
- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at `015a24fa8a0d526b1a71a5418564b47df1f98ece` for the Kafka producer follow-up, with earlier queue-agent notes from `04ea23af81f738f81dc0f75ecbd99e83f9ab1d6a` and Spring Kafka notes from `dd95ecc5f440436eda34ff94169cec85900abadd`.
- Datadog files/functions read: `dd-java-agent/instrumentation/kafka/kafka-clients-0.11/src/main/java/datadog/trace/instrumentation/kafka_clients/TextMapInjectAdapter.java` (`set`, `injectTimeInQueue`), `KafkaProducerInstrumentation.java` (`ProducerAdvice`, `ProducerRecordAdvice`, `ProducerRecordCallbackAdvice`, `ProducerContextPropagationAdvice`), `KafkaDecorator.java` (`onProduce`, `onConsume`, `beforeFinish`), `TextMapExtractAdapter.java` (`forEachKey`, `extractTimeInQueueStart`), `TracingIterator.java` (`startNewRecordSpan`), `dd-java-agent/instrumentation/jms/javax-jms-1.1/src/main/java/datadog/trace/instrumentation/jms/MessageInjectAdapter.java` (`set`, `injectTimeInQueue`), `MessageExtractAdapter.java` (`forEachKey`, `extractTimeInQueueStart`, `extractMessageBatchId`), `JMSMessageProducerInstrumentation.java` (`ProducerContextPropagationAdvice`), and `JMSMessageConsumerInstrumentation.java` (`ConsumerAdvice.afterReceive`).
- OpenTelemetry Java Instrumentation: `https://github.com/open-telemetry/opentelemetry-java-instrumentation.git` at `3118b49eade43b82bac593a980cb83db1ee540b1`.
- OpenTelemetry files/functions read: `instrumentation/kafka/kafka-clients/kafka-clients-common-0.11/library/src/main/java/io/opentelemetry/instrumentation/kafkaclients/common/v0_11/internal/KafkaInstrumenterFactory.java` (`createProducerInstrumenter`, `createConsumerReceiveInstrumenter`, `createConsumerProcessInstrumenter`, `createBatchProcessInstrumenter`), `KafkaPropagation.java` (`propagateContext`, `shouldPropagate`), `KafkaHeadersSetter.java` (`set`), `KafkaBatchProcessSpanLinksExtractor.java` (`extract`), `instrumentation/jms/jms-common-1.1/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/jms/common/v1_1/JmsInstrumenterFactory.java`, `MessagePropertyGetter.java`, and `MessagePropertySetter.java`.
- PostHog Java: `https://github.com/PostHog/posthog-java.git` at `dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e`.
- PostHog files/classes read: `posthog/src/main/java/com/posthog/java/QueueManager.java` (`QueuePtr`, `add`, `sendAll`, `run`) and `posthog/src/main/java/com/posthog/java/PostHog.java` (`capture`, `enqueue`, `startQueueManager`, `shutdown`). No comparable Java messaging trace propagation was found.

## Patterns Observed

Sentry is strongest for Spring Kafka developer ergonomics because it ships first-party Kafka producer wrapping, Spring Kafka producer post-processing, Spring Kafka record interception, producer header injection, enqueued-time header injection, receive-latency derivation, and consumer trace continuation. The tradeoff is Kafka/Spring-specific runtime coupling, Sentry-specific propagation/timing headers plus baggage, callback lifecycle wrapping, and more automatic behavior.

OpenTelemetry is strongest for standards-based Java messaging instrumentation. It builds producer, receive, process, and batch process instrumenters, injects propagation through Kafka headers and JMS properties, records messaging semantic attributes, and adds span links for batch processing. The tradeoff is an OpenTelemetry SDK/instrumentation stack, javaagent or library integration complexity, broader semantic-convention surface, optional header capture, and more dependency/runtime coupling.

Datadog is strongest for automatic breadth and data-stream/time-in-queue detail across Kafka and JMS. It injects/extracts propagation through broker carriers, records time-in-queue metadata, and instruments producer/consumer methods through the agent. The tradeoff is agent patching, vendor propagation behavior, data-stream metadata, broker-specific internals, and more hidden runtime behavior.

PostHog server-side Java remains product analytics and logs oriented in the inspected source and does not provide comparable Java messaging trace propagation.

## LogBrew Change

LogBrew Java now adds a lighter dependency-free queue propagation layer to the existing app-owned `LogBrewOperationTracing.queueOperation(...)` path:

- `QueueOperation.traceparentHeaderSetter(...)` writes exactly one normalized W3C `traceparent` to an app-owned carrier setter before the queue callback runs.
- `QueueOperation.incomingTraceparent(...)` continues one valid incoming message context for consumer/process spans.
- `QueueOperation.linkedMessageTraceparent(...)` records bounded batch-message span links with primitive metadata.
- `QueueOperation.enqueuedAt(...)` computes a primitive `timeInQueueMs` from the message enqueue timestamp to the handler start time.
- `QueueOperation.timeInQueueMs(...)` accepts an explicit broker-provided latency when the application already has one.
- `SpanLinkSummary` and `SpanAttributes.link(s)` provide reusable privacy-bounded span links for manual advanced spans.
- Malformed incoming/linked propagation, impossible negative time-in-queue, and setter failures are non-fatal diagnostics through `onError(...)`; the app callback result/error remains authoritative.

The generic implementation avoids Kafka/JMS/Rabbit/AMQP dependencies, Java agents, Spring/Kafka auto-registration, broker client patching, custom timing-header injection, arbitrary header capture, raw enqueue timestamps, message bodies, payloads, broker URLs, receipt/message IDs, baggage, tracestate, raw propagation metadata, exception messages, stacks, and support-ticket creation.

LogBrew Java now also adds `LogBrewSpringKafkaTracing.producer(...)`, `producerPostProcessor(...)`, `producerSend(...)`, and `recordInterceptor(...)` for apps that already use Spring Kafka:

- Apps that own a raw Kafka `Producer` can wrap it explicitly; the wrapper intercepts `send(...)`, clones record headers, injects one normalized W3C `traceparent`, keeps the child trace active during send and callback execution, returns the app-owned `Future<RecordMetadata>` or a failed future for immediate send failure, and emits one sanitized `spring.kafka.produce:<topic>` span when Kafka invokes the callback or an immediate failure is observed.
- Apps that own a Spring Kafka `ProducerFactory` can add the returned `ProducerPostProcessor` themselves; LogBrew does not auto-register a bean post-processor or mutate unrelated factories.
- Apps call `producerSend(...)` with their own `KafkaOperations` and `ProducerRecord`; the helper clones record headers, replaces exactly one W3C `traceparent`, sends through the app-owned operations object with the child trace active, returns the app-owned future or a failed future for immediate send failure, and emits one `spring.kafka.produce:<topic>` span when that future completes or the immediate failure is observed.
- Apps register the returned `RecordInterceptor` with their own listener container factory.
- The consumer helper continues one incoming W3C `traceparent`, makes the child trace active while listener code runs, and emits one `spring.kafka.process:<topic>` span on `success(...)`, `failure(...)`, or Spring Kafka thread-state clear.
- It derives primitive non-negative consumer `timeInQueueMs` from the Kafka record timestamp when available.
- Producer and consumer helpers filter configured metadata through the dependency-span privacy blocklist and record only primitive framework/source/topic/status/duration/sampled/error-type data.
- They preserve app-owned records, futures, callbacks, and delegate interceptors; treat malformed propagation as a non-fatal `onError(...)` diagnostic; and avoid hidden auto-configuration, record keys, values, offsets, arbitrary headers, broker addresses, consumer group IDs, baggage, tracestate, exception messages, and stack traces.

## Honest Comparison

LogBrew is now better than PostHog Java for queue trace propagation and safer/lighter than Sentry, Datadog, and OpenTelemetry for explicit app-owned queue carriers with installed-artifact proof. The Spring Kafka producer wrapper, `ProducerPostProcessor`, `KafkaOperations` helper, and record interceptor close the most direct Sentry ergonomics gap for applications that prefer explicit registration and privacy-bounded payloads. LogBrew is still worse than Sentry for automatic Spring bean post-processing, Sentry timing-header interop, and out-of-the-box Kafka setup depth; worse than OpenTelemetry for standard automatic Kafka/JMS instrumenters and batch span-link depth; and worse than Datadog for automatic broker breadth, data-stream metadata, agent-driven coverage, and automatic time-in-queue spans.

## Verification

- Focused package gate: `bash scripts/check_java_package.sh` passed with Java operation tracing tests plus 9 Spring Kafka producer and record-interceptor tests for outgoing traceparent injection without mutating the original record, producer wrapper callback correlation, explicit `ProducerPostProcessor` wrapping, raw producer and `KafkaOperations` immediate-send failed futures, incoming trace continuation, active trace scope during producer send and listener work, sanitized span capture, future-failure exception-type summaries, malformed propagation diagnostics, metadata redaction, and `clearThreadState(...)` completion.
- Spring Kafka installed-artifact gate: `bash scripts/real_user_java_spring_kafka_smoke.sh` passed from a packaged jar, sending a real `ProducerRecord` through an app-owned `KafkaOperations` proxy, wrapping an app-owned Kafka `Producer`, applying a Spring `ProducerPostProcessor`, registering the interceptor against real `ConsumerRecord`/`RecordHeaders`, validating W3C correlation, validating callback trace scope and `timeInQueueMs`, and proving key/value/header/metadata redaction.
- Queue installed-artifact gate: `bash scripts/real_user_java_queue_trace_smoke.sh` passed from packaged jar/source jar, proving generic queue traceparent injection, incoming continuation, span links, manual `SpanLinkSummary`, computed and explicit `timeInQueueMs`, flush behavior, and no private message/header/raw timestamp/propagation leakage.
- Spring Boot gate: `bash scripts/real_user_spring_boot_smoke.sh` passed with `spring-boot@4.1.0`.
- High-load installed-artifact gate: `bash scripts/real_user_java_high_load_smoke.sh` passed with 1,500 logs, 1,000 flushed events, 500 bounded local drops, and 5xx-to-2xx retry behavior.
- Release/static/hygiene gates passed: Java SpotBugs, ShellCheck, Maven Central bundle dry-run, payload fixture validation, release metadata, markdown links, backend contract reports, generated-artifact hygiene, diff hygiene, and public confidentiality scan.

## Remaining Gaps

Next useful Java trace improvements are JMS helper/package coverage, batch receive/process convenience helpers, richer messaging semantic attributes, baggage/tracestate only if explicitly justified, optional Spring bean auto-registration only if privacy/runtime coupling is justified, and OpenTelemetry processor/exporter interop. Do not add automatic broker/client patching to core `logbrew-sdk`.
