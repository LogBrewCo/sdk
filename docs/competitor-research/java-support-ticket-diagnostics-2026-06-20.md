# Java Support Ticket Diagnostics - Competitor Research - 2026-06-20

## Goal

Prepare Java developers and support agents for explicit support-ticket handoff without calling backend support routes that are not deployed yet. The SDK gap is a local, token-free payload draft that preserves useful install/runtime context while blocking accidental credential, local path, URL origin, raw propagation, and exception-message leakage.

## Source Evidence

- Sentry Java SDK: [`getsentry/sentry-java@05aa61daa3d25b2c82424779b5dec47c2c37556b`](https://github.com/getsentry/sentry-java/tree/05aa61daa3d25b2c82424779b5dec47c2c37556b).
- Read paths/functions: `sentry/src/main/java/io/sentry/SentryOptions.java` `addEventProcessor(...)`, `getEventProcessors()`, `setBeforeSend(...)`, `setBeforeSendFeedback(...)`, `BeforeSendCallback.execute(...)`; `sentry/src/main/java/io/sentry/SentryClient.java` `captureEvent(...)`, `processEvent(...)`, `executeBeforeSend(...)`, `executeBeforeSendFeedback(...)`.
- Datadog Java tracer: [`DataDog/dd-trace-java@0fdd9c262717bb03c2c871f84455be04b3c04460`](https://github.com/DataDog/dd-trace-java/tree/0fdd9c262717bb03c2c871f84455be04b3c04460).
- Read paths/functions: `dd-trace-api/src/main/java/datadog/trace/api/ConfigDefaults.java` `DEFAULT_IAST_REDACTION_NAME_PATTERN`, `DEFAULT_IAST_REDACTION_VALUE_PATTERN`; `dd-trace-api/src/main/java/datadog/trace/api/DDTags.java` `ERROR_MSG`.
- OpenTelemetry Java: [`open-telemetry/opentelemetry-java@824334c552cd800d6b89512f20225b2025fd5d16`](https://github.com/open-telemetry/opentelemetry-java/tree/824334c552cd800d6b89512f20225b2025fd5d16).
- Read paths/functions: `api/all/src/main/java/io/opentelemetry/api/trace/TraceId.java` `isValid(...)`; `api/all/src/main/java/io/opentelemetry/api/common/AttributeKey.java` primitive `stringKey`, `booleanKey`, `longKey`, and `doubleKey`.
- PostHog Java SDK: [`PostHog/posthog-java@dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e`](https://github.com/PostHog/posthog-java/tree/dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e).
- Read paths/functions: `posthog/src/main/java/com/posthog/java/PostHog.java` `Builder`, `capture(...)`, `enqueue(...)`, `getEventJson(...)`; `posthog/src/main/java/com/posthog/java/QueueManager.java` `sendAll()`, `run()`.

## Patterns

- Sentry Java gives developers broad `EventProcessor` and `BeforeSend` hooks that can mutate or drop events before transport. It also drops events when a before-send callback throws because of PII risk. This is useful for hosted telemetry, but too broad for support diagnostics because it runs inside the capture pipeline.
- Datadog Java keeps explicit redaction patterns for sensitive names and values. It also has normal span error-message fields, which is useful for tracing but too risky for local support-ticket drafts unless the user explicitly copies message text.
- OpenTelemetry Java validates trace IDs as 32-character non-zero lowercase hex and models attributes through typed primitive keys. That supports keeping correlation and diagnostics small, explicit, and inspectable.
- PostHog Java's current SDK is explicit event capture plus queue/shutdown. It does not expose a Java before-send hook in the inspected source snapshot, so LogBrew should not model support diagnostics as automatic event mutation.

## LogBrew Implementation

- Added `SupportTicketDraft` to `co.logbrew:logbrew-sdk`.
- Added `SupportTicketDraft.Input.create(...)` with planned public support-ticket fields: `project_id`, `source`, `category`, `title`, `description`, `environment`, `runtime`, `framework`, `sdk_package`, `sdk_version`, `release`, `trace_id`, `event_id`, and `diagnostics`.
- The helper validates planned route-owned source/category enums, trims required text, validates/lowercases W3C trace IDs, and returns a local draft only.
- Diagnostics are bounded to JSON-like values, limited in depth/item count/string length, and sanitize sensitive keys, token-like strings, URL origins, local paths, unsupported values, and exception messages. Exceptions retain type only.
- The helper intentionally does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, infer backend ownership, or treat planned routes as deployed.

## Comparison

- Better than broad Sentry mutation hooks for support diagnostics because the LogBrew helper is narrow, local-only, explicit, and separate from telemetry capture.
- Better than copying raw Java exception objects into support context because the helper keeps exception type and omits message/stack text by default.
- Lighter than Datadog/OpenTelemetry patterns because it adds no Java agent, exporter, tracer dependency, or background support channel.
- Worse than Sentry or Datadog for teams that want hosted feedback/support submission today. LogBrew should only add network ticket creation after backend reports deployed support-ticket storage/routes and only behind explicit user or agent action.

## Verification

- TDD red: `bash scripts/check_java_package.sh` failed with missing `SupportTicketDraft` and `SupportTicketDraft.Input`.
- Green: `bash scripts/check_java_package.sh` passed, including payload shape, enum validation, trace ID validation, nested diagnostics redaction, URL-origin stripping, local-path redaction, exception type-only capture, unsupported-value omission, javadoc/source/runtime jar inclusion, and installed-jar smoke proof through `RealUserSmoke`.

## Remaining Gaps

- Java registry users need a future repo-wide Maven Central release for the helper to be publicly installable from Maven Central; current local artifact proof is ready.
- .NET, Ruby, and PHP still lack equivalent local support-draft helpers.
- Backend ticket creation remains blocked until backend support storage/routes are deployed and explicit SDK/agent action is defined.
