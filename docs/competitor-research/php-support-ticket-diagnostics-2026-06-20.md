# PHP Support-Ticket Diagnostics - Competitor Research - 2026-06-20

This pass compared PHP support and diagnostic handoff behavior against current public SDK source for Sentry, Datadog, OpenTelemetry, and PostHog, then added a local-only LogBrew draft helper. The goal is agent-ready diagnostics without calling undeployed support-ticket routes, using account/session credentials, or leaking tokens, exception messages, local paths, or URL origins.

## Sources Read

- Sentry PHP `getsentry/sentry-php@406b5cd69a4e87ea6bb9d0869b5954bf0dacf03f`
  - `src/Client.php`: `captureMessage`, `captureException`, `captureEvent`, event preparation, event processors, and `applyBeforeSendCallback(...)` path.
  - `src/Options.php`: `before_send`, `before_send_transaction`, `before_send_log`, `before_send_metric`, `send_default_pii`, and default PII behavior.
- Datadog PHP tracer `DataDog/dd-trace-php@8f132ce022333c8f5d30cacfe4cdc2e802526053`
  - `src/api/Http/Urls.php`: `Urls::sanitize(...)` URL query/user-info stripping.
  - `src/DDTrace/Util/Normalizer.php`: `urlSanitize(...)`, query-string cleaning, and POST-field redaction paths.
  - `src/DDTrace/OpenTelemetry/Span.php`: `recordException(...)` and exception event attributes.
- OpenTelemetry PHP `open-telemetry/opentelemetry-php@056b9390c95b6f6bb7c0fe842743df8f36540dfd`
  - `src/API/Trace/SpanContextValidator.php`: valid 32-char non-zero lowercase trace ID and valid span ID rules.
  - `src/API/Trace/SpanContext.php`: invalid context fallback.
  - `src/API/Trace/Propagation/TraceContextPropagator.php`: W3C traceparent extraction and validation.
  - `src/API/Logs/LogRecordBuilderInterface.php`: primitive attributes plus exception message/type/stacktrace semantics.
- PostHog PHP `PostHog/posthog-php@cd9d840814647d64459b2c1acc630e18c6ea62d5`
  - `lib/Client.php`: `capture(...)`, `captureException(...)`, and `flush(...)`.
  - `lib/ExceptionPayloadBuilder.php`: throwable/string exception payload construction with message and frame data.
  - `lib/HttpClient.php`: `maskTokensInUrl(...)`.
  - `lib/QueueConsumer.php`: queue and explicit flush behavior.

## Competitor Pattern

Sentry PHP has mature event capture, ignored-exception handling, event processors, and `before_send`-style hooks that can drop or mutate events before transport. Datadog PHP invests in broad automatic instrumentation, URL/query/user-info sanitization, and exception span events. OpenTelemetry PHP is the strongest source for strict W3C trace ID validity and primitive attribute boundaries. PostHog PHP is explicit and queue/flush oriented, and its exception capture intentionally builds rich message and frame payloads for error tracking.

The useful LogBrew subset is narrower: validate a planned support-ticket create payload, normalize trace IDs, bound diagnostics, redact risky diagnostic fields, and return a local array that a user or agent may explicitly hand off later. LogBrew intentionally does not copy Sentry/PostHog exception payload richness, Datadog automatic hooks, OpenTelemetry exporter behavior, or any ticket creation side effect.

## LogBrew Change

- Added `LogBrew\SupportTicketDraft::create(...)` in `php/logbrew-php/src/SupportTicketDraft.php`.
- Validates planned source/category enums, trims required text, and emits snake_case create-payload fields.
- Validates/lowercases W3C 32-character non-zero trace IDs.
- Bounds diagnostic depth, list length, and string length.
- Redacts sensitive keys and strings, `lbw_*` token shapes, bearer values, URL origins/query/fragment, local filesystem paths, embedded URL/path text, and exception message/stack data.
- Keeps exception type only and omits unsupported objects or non-finite floats.
- Never opens tickets, calls support-ticket routes, sends telemetry, uses account/session credentials, derives usage/quota/history, or writes local setup markers.

## Verification

Focused red/green sequence started by adding PHP tests for the missing `SupportTicketDraft` class and then implementing the helper. Current focused evidence after implementation:

- `php php/logbrew-php/tests/run.php`
- `python3 scripts/check_php_sources.py`
- `bash scripts/check_php_static.sh`
- `bash scripts/real_user_php_smoke.sh`

The installed Composer smoke verifies archive inclusion, README guidance, optimized autoload behavior, generated installed app usage, direct and `make` example output, remove/reinstall behavior, and support-draft redaction, including embedded URL/path text, from the shipped `examples/real_user_smoke.php`.

Thermo review split support-draft tests into `php/logbrew-php/tests/support_ticket.php`, keeping `tests/run.php` below the 1k-line threshold and matching the existing focused `operation_tracing.php` pattern.

## Honest Status

LogBrew PHP is now better for a developer or agent that needs a small, explicit, token-safe local support diagnostic draft before backend support-ticket routes are live. Sentry, Datadog, OpenTelemetry, and PostHog remain stronger for mature automatic PHP error capture, framework/runtime instrumentation, rich exception frames, and hosted backend support workflows. LogBrew still should not claim backend-created support tickets, backend symbolication, automatic PDO/Doctrine/Redis/Laravel Queue coverage, baggage/tracestate, or rich span events from PHP core.
