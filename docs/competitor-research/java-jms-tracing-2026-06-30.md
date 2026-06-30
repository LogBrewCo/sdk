# Java JMS Tracing - 2026-06-30

## Goal

Close the Java SDK's JMS messaging trace gap without adding a `javax.jms` or
`jakarta.jms` dependency to core `co.logbrew:logbrew-sdk`. The target is explicit
app-owned producer and consumer code: inject one outgoing W3C `traceparent`,
continue one incoming `traceparent`, keep active trace correlation during app
work, and record privacy-bounded queue spans from packaged artifacts.

## Source Evidence

- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at
  `2c3db2130802ee4ec90e9eacbdb4cb7e90b021c6`.
- Datadog files/functions read:
  `dd-java-agent/instrumentation/jms/javax-jms-1.1/src/main/java/datadog/trace/instrumentation/jms/MessageInjectAdapter.java`
  (`set`, `injectTimeInQueue`),
  `MessageExtractAdapter.java` (`forEachKey`, `extractTimeInQueueStart`,
  `extractMessageBatchId`).
- OpenTelemetry Java Instrumentation:
  `https://github.com/open-telemetry/opentelemetry-java-instrumentation.git` at
  `3118b49eade43b82bac593a980cb83db1ee540b1`.
- OpenTelemetry files/functions read:
  `instrumentation/jms/jms-common-1.1/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/jms/common/v1_1/JmsInstrumenterFactory.java`
  (`createProducerInstrumenter`, `createConsumerReceiveInstrumenter`,
  `createConsumerProcessInstrumenter`, `PropagatorBasedSpanLinksExtractor`
  setup for receive/process spans),
  `MessagePropertyGetter.java` (`keys`, `get`), and
  `MessagePropertySetter.java` (`set`).
- Sentry Java `https://github.com/getsentry/sentry-java.git` at
  `307edcd968452d07d801c46362bf98f815fea808` was used as the comparison point
  for first-party Java messaging ergonomics through Kafka/Spring Kafka support;
  no comparable first-party JMS helper was used for this change.
- PostHog Java `https://github.com/PostHog/posthog-java.git` at
  `dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e` remains product-analytics/logging
  oriented in inspected server-side Java source and has no comparable JMS trace
  propagation path.

## Patterns Observed

Datadog and OpenTelemetry both use JMS message string properties as the
propagation carrier. Both account for JMS property-name limits by mapping header
keys with hyphens, and both treat property setter/getter failures as
instrumentation diagnostics rather than application failures. Their strength is
automatic producer/consumer breadth and richer messaging metadata. The tradeoff
is javaagent/runtime instrumentation, JMS-version-specific modules, destination
and lifecycle coupling, and a larger semantic surface.

LogBrew intentionally copied only the safe carrier idea: one string property for
`traceparent`, non-fatal read/write diagnostics, and child trace activation
around app-owned work. LogBrew did not copy automatic producer/consumer advice,
connection/session/listener patching, property enumeration, custom timing
properties, data-stream metadata, baggage/tracestate, destination inspection, or
message-body/property capture.

## LogBrew Change

Core Java now includes dependency-free `LogBrewJmsTracing`:

- `LogBrewJmsTracing.send(...)` reflects
  `setStringProperty(String, String)` on the app-owned message object, writes one
  normalized W3C `traceparent`, activates the child trace while the app send
  callback runs, and records a `queue:jms.produce` span.
- `LogBrewJmsTracing.process(...)` reflects
  `getStringProperty(String)` on the app-owned message object, continues one
  valid incoming traceparent, activates the child trace during app processing,
  and records a `queue:jms.process` span.
- `LogBrewJmsTracing.processBatch(...)` iterates only the app-supplied message
  objects, reflects only `getStringProperty(String)`, uses the first valid
  incoming traceparent as the parent, links later valid message traceparents up
  to the shared span-link cap, records a primitive `messageCount`, and emits one
  `queue:jms.process_batch` span.
- `ProducerConfig` and `ConsumerConfig` expose event ID prefix, deterministic
  span ID, safe destination label, primitive metadata, deterministic clock, and
  non-fatal diagnostic callback. `ConsumerConfig` also accepts primitive
  `messageCount` and `timeInQueueMs` values when the application already has
  them.
- Property read/write failures produce `jms_property_read_failed` or
  `jms_property_write_failed` diagnostics through `onError(...)` without
  replacing the app operation result or original app operation exception.
  Malformed batch propagation is reported as the existing redacted
  `validation_error` diagnostic and skipped.

The helper works with `javax.jms.Message`, `jakarta.jms.Message`, or compatible
message objects through reflection. It avoids new JMS dependencies, Java agents,
hidden Spring bean registration, connection/session/producer/consumer/listener
patching, destination inspection, message IDs, message bodies, payloads,
arbitrary property/header capture, broker addresses, raw propagation strings,
baggage, tracestate, exception messages, stacks, and support-ticket creation.

## Honest Comparison

LogBrew is now better than PostHog Java for JMS trace correlation and safer than
Datadog/OpenTelemetry for teams that want explicit app-owned JMS tracing without
an agent or JMS dependency in the base SDK. The batch helper now narrows the
message-link ergonomics gap by giving explicit batch consumers first-parent plus
bounded linked-message correlation. LogBrew is still worse than Datadog and
OpenTelemetry for automatic JMS breadth, receive-vs-process span separation,
messaging semantic conventions, exported metrics, destination-specific metadata,
baggage/tracestate, and full OTel processor/exporter interop. It is
intentionally not trying to match hidden agent coverage in core.

## Verification

- GREEN: `bash scripts/check_java_package.sh` passed with 3 JMS tests proving
  traceparent property injection, incoming continuation, active child trace
  scope, primitive `timeInQueueMs`, safe metadata filtering, and non-fatal
  property read/write diagnostics. A 2026-07-01 follow-up expanded this to 4
  JMS tests proving `processBatch(...)` first-parent continuation, bounded valid
  message links, malformed propagation diagnostics, computed `messageCount`, and
  raw propagation redaction.
- Installed artifact: `bash scripts/real_user_java_jms_smoke.sh` passed from a
  packaged jar/source jar, compiled a temp app against the installed jar, proved
  `LogBrewJmsTracing` class/source/README packaging, exercised send/process,
  batch process, malformed propagation, and property-failure paths, validated
  the emitted payload, and flushed through local fake intake.
- Public verifier contract: `python3 -m unittest tests.test_check_public_sdks`
  passed after adding the Java JMS installed-artifact smoke step and matching
  label-order contract.

## Remaining Gaps

Next Java messaging gaps are JMS receive-vs-process split ergonomics, richer
messaging semantic attributes, privacy-bounded messaging metrics, optional
Spring/JMS bean auto-registration only if privacy/runtime coupling is justified,
baggage/tracestate only if a real interoperability need justifies it, and OTel
exporter/processor interop.
