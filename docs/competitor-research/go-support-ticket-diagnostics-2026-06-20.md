# Go Support Ticket Diagnostics - Competitor Research - 2026-06-20

## Goal

Prepare Go developers and support agents for explicit support-ticket handoff without calling backend support routes that are not deployed yet. The SDK gap is a local, token-free payload draft that preserves useful install/runtime context while blocking accidental credential, local path, URL origin, raw propagation, and error-message leakage.

## Source Evidence

- Sentry Go SDK: [`getsentry/sentry-go@c299195fc44e4c637d24a6ba1f2b38e0ccedb816`](https://github.com/getsentry/sentry-go/tree/c299195fc44e4c637d24a6ba1f2b38e0ccedb816).
- Read paths/functions: `client.go` `EventProcessor`, `AddGlobalEventProcessor`, `ClientOptions.BeforeSend`, `BeforeSendLog`, `BeforeSendTransaction`, `BeforeBreadcrumb`, `BeforeSendMetric`; `scope.go` `Scope.AddEventProcessor`, `Scope.ApplyToEvent`; `sentry.go` `CaptureException`, `CaptureEvent`, `Flush`; `hub_test.go` before-breadcrumb tests.
- Datadog Go tracer: [`DataDog/dd-trace-go@86ab9adbd32890387da2df932f59a59a1552f588`](https://github.com/DataDog/dd-trace-go/tree/86ab9adbd32890387da2df932f59a59a1552f588).
- Read paths/functions: `internal/telemetry/log/safe.go` `SafeError`, `NewSafeError`, `LogValue`, `errorType`, `SafeSlice`; `internal/telemetry/log/log.go` secure telemetry logging model; `rules/telemetry_rules.go` `telemetryLogSmartSlogAny`, `telemetryLogConstantMessage`, `telemetryLogStringErrorCall`, `telemetryLogRawErrorUsage`.
- OpenTelemetry Go: [`open-telemetry/opentelemetry-go@6ccfa685fc23395d4717ec2018e5a388898cbcb2`](https://github.com/open-telemetry/opentelemetry-go/tree/6ccfa685fc23395d4717ec2018e5a388898cbcb2).
- Read paths/functions: `attribute/value.go` `Value`, `BoolValue`, `Int64Value`, `Float64Value`, `StringValue`, `SliceValue`, `MapValue`; `trace/span.go` `SpanContext`, `SetAttributes`.
- PostHog Go SDK: [`PostHog/posthog-go@4e2ddac87f0b580ace1d1dd79a94b481ae797315`](https://github.com/PostHog/posthog-go/tree/4e2ddac87f0b580ace1d1dd79a94b481ae797315).
- Read paths/functions: `config.go` `Config.BeforeSend`, `DefaultEventProperties`, `Callback`, retry/shutdown fields; `posthog.go` `Client`, `Enqueue`, `NewWithConfig`, `preparedMessage`; `properties.go` `Properties`, `NewProperties`, `Set`, `Merge`; `before_send_test.go` before-send mutation/drop/panic/original-properties tests.

## Patterns

- Sentry gives Go users broad event processors and `BeforeSend` hooks that can mutate or drop telemetry before transport. This is flexible for hosted telemetry, but too broad for support diagnostics because the hook runs inside the capture pipeline and can carry event/request context.
- Datadog is stricter around internal telemetry logging: constant messages, structured fields, and `SafeError` expose error type rather than raw error text. This is a useful privacy pattern for support diagnostics.
- OpenTelemetry's attribute model is typed and primitive-first. It supports maps/slices, but callers must explicitly choose values; this reinforces bounded, inspectable diagnostics rather than arbitrary object serialization.
- PostHog Go has a developer-friendly `BeforeSend` hook and verifies that hooks can mutate/drop messages without mutating original properties. It is useful for event shaping, but it still belongs to the event submission path rather than a local support handoff path.

## LogBrew Implementation

- Added `CreateSupportTicketDraft(...)` to `github.com/LogBrewCo/sdk/go/logbrew`.
- Added `SupportTicketDraftInput` and `SupportTicketDraft` with planned public support-ticket fields: `project_id`, `source`, `category`, `title`, `description`, `environment`, `runtime`, `framework`, `sdk_package`, `sdk_version`, `release`, `trace_id`, `event_id`, and `diagnostics`.
- The helper validates planned route-owned source/category enums, trims required text, validates/lowercases W3C trace IDs, and returns a local draft only.
- Diagnostics are bounded to JSON-like values, limited in depth/item count/string length, and sanitize sensitive keys, token-like strings, URL origins, local paths, unsupported values, and error messages. Errors retain type only.
- The helper intentionally does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, infer backend ownership, or treat planned routes as deployed.

## Comparison

- Better than broad Sentry/PostHog mutation hooks for support diagnostics because the LogBrew helper is narrow, local-only, typed, and explicit. It cannot silently enqueue a support ticket or mutate telemetry.
- Better than raw error/context upload for public SDK safety because Go error messages and stacks are not copied into diagnostics by default.
- Lighter than Datadog/OpenTelemetry patterns because it adds no tracer/exporter/agent dependency and no background telemetry channel.
- Worse than Sentry or Datadog for teams that want hosted feedback/support submission today. LogBrew should only add network ticket creation after backend reports deployed support-ticket storage/routes and only behind explicit user or agent action.

## Verification

- TDD red: `cd go/logbrew && go test ./...` failed with undefined `CreateSupportTicketDraft` and `SupportTicketDraftInput`.
- Green: `cd go/logbrew && go test ./...` passed, including payload shape, enum validation, trace ID validation, nested diagnostics redaction, URL-origin stripping, local-path redaction, error type-only capture, unsupported-value omission, and no hidden token/path/origin/raw propagation leakage.
- Installed proof: `bash scripts/real_user_go_support_ticket_smoke.sh` passed from a generated local Go proxy artifact, proving a temp module can `go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0`, call the packaged helper, inspect `go doc` for the new public API, and read packaged README support-ticket guidance.

## Remaining Gaps

- Go registry users need a new scoped module tag after CI is healthy; current public latest remains `go/logbrew/v0.1.1` until then.
- Java, .NET, Ruby, and PHP still lack equivalent local support-draft helpers.
- Backend ticket creation remains blocked until backend support storage/routes are deployed and explicit SDK/agent action is defined.
