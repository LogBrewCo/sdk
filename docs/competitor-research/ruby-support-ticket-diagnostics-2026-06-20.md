# Ruby Support Ticket Diagnostics - Competitor Research - 2026-06-20

## Goal

Prepare Ruby developers and support agents for explicit support-ticket handoff without calling backend support routes that are not deployed yet. The SDK gap is a local, token-free payload draft that preserves useful install/runtime context while blocking credential, local path, URL origin, raw propagation, and exception-message leakage.

## Source Evidence

- Sentry Ruby: [`getsentry/sentry-ruby@3f3a9214e0639b61581ede8a697ca57804e6b96b`](https://github.com/getsentry/sentry-ruby/tree/3f3a9214e0639b61581ede8a697ca57804e6b96b).
- Read paths/functions: `sentry-ruby/sentry-ruby/lib/sentry/client.rb` `capture_event(...)`, `event_from_exception(...)`, `event_from_log(...)`, `send_event(...)`; `sentry-ruby/sentry-ruby/lib/sentry/configuration.rb` `before_send=`; `sentry-ruby/sentry-ruby/lib/sentry/interfaces/request.rb` `initialize(...)` and `filter_and_format_headers(...)`.
- Datadog Ruby tracer: [`DataDog/dd-trace-rb@20f8b9bd600e2f3ce621f6ff03cf649111018ea3`](https://github.com/DataDog/dd-trace-rb/tree/20f8b9bd600e2f3ce621f6ff03cf649111018ea3).
- Read paths/functions: `lib/datadog/opentelemetry/sdk/trace/span.rb` `record_exception(...)`; `lib/datadog/tracing/contrib/rack/middlewares.rb` request exception handling and request tag setup; `lib/datadog/tracing/contrib/utils/quantization/http.rb` query obfuscation constants and patterns; `lib/datadog/core/utils/url.rb` URL password removal.
- OpenTelemetry Ruby: [`open-telemetry/opentelemetry-ruby@cbcdaf57c253b6c2bd390ddc39f11cadbe940f6d`](https://github.com/open-telemetry/opentelemetry-ruby/tree/cbcdaf57c253b6c2bd390ddc39f11cadbe940f6d).
- Read paths/functions: `api/lib/opentelemetry/trace/span_context.rb` `valid?`, `hex_trace_id`, and `hex_span_id`; `sdk/lib/opentelemetry/sdk/internal.rb` primitive attribute validation helpers; `sdk/lib/opentelemetry/sdk/trace/span.rb` `record_exception(...)`.
- PostHog Ruby: [`PostHog/posthog-ruby@eaf0ba5fdd0d768fa0a1a509abee7bec53de8987`](https://github.com/PostHog/posthog-ruby/tree/eaf0ba5fdd0d768fa0a1a509abee7bec53de8987).
- Read paths/functions: `lib/posthog/client.rb` `initialize(...)`, `capture(...)`, `capture_exception(...)`, and `flush`; `lib/posthog/exception_capture.rb` `build_parsed_exception(...)`, `build_single_exception_from_data(...)`, and backtrace parsing helpers.

## Patterns

- Sentry Ruby provides broad event processors and `before_send` mutation hooks, with request PII controlled by `send_default_pii`. This is useful for hosted telemetry but too broad for support diagnostics because it runs in the capture pipeline and can carry request/event context.
- Datadog Ruby keeps strong HTTP/query and URL sanitization patterns, but normal trace exception paths still preserve exception message and stack details for telemetry.
- OpenTelemetry Ruby is the clean reference for trace/span validity and primitive attribute shapes. It also records exception message and stacktrace as span event attributes, which is too much for a support draft by default.
- PostHog Ruby keeps event and exception capture explicit and queues/shuts down predictably. Its exception helper builds rich exception payloads, which is useful for product analytics but too detailed for local support handoff unless explicitly requested.

## LogBrew Implementation

- Added `LogBrew::SupportTicketDraft.create(...)` in a separate `lib/logbrew/support_ticket.rb` file so `lib/logbrew.rb` stays below the 1k-line threshold.
- The helper validates planned source/category enums, trims required title/description, accepts optional planned create-payload fields, and validates/lowercases non-zero W3C trace IDs.
- Diagnostics are bounded to JSON-like values, limited in depth/item count/string length, and sanitize sensitive keys, token-like strings, URL origins, local paths, unsupported values, and exception messages. Ruby exceptions retain type only.
- The helper intentionally does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, infer backend ownership, or treat planned routes as deployed.

## Comparison

- Better than broad Sentry/PostHog mutation hooks for support diagnostics because the LogBrew helper is narrow, local-only, explicit, and separate from telemetry capture.
- Safer than raw Ruby exception upload because exception messages, backtraces, local paths, URL origins, and token-shaped values are omitted or redacted by default.
- Lighter than Datadog/OpenTelemetry patterns because it adds no tracer, exporter, agent, background thread, or support network channel.
- Worse than Sentry or Datadog for teams that want hosted support/feedback submission today. LogBrew should only add network ticket creation after backend reports deployed support-ticket storage/routes and only behind explicit user or agent action.

## Verification

- TDD red: `ruby ruby/logbrew-ruby/tests/run.rb` failed with `uninitialized constant LogBrew::SupportTicketDraft`; the follow-up map-bound regression test failed with `expected support diagnostic map item bound`.
- Green: `ruby ruby/logbrew-ruby/tests/run.rb` passed with support draft payload shape, enum validation, trace ID validation, nested diagnostics map/array bounds, URL-origin stripping, local-path redaction, exception type-only capture, unsupported-value omission, and no hidden token/path/origin/raw propagation leakage.
- Packaged proof: `bash scripts/check_ruby_package.sh` passed with Ruby syntax checks, RDoc surface for `LogBrew::SupportTicketDraft`, gem file inclusion, README guidance, canonical fixture parity, HTTP trace proof, and real-user smoke `supportDraftRedacted:true`.
- Installed proof: `bash scripts/real_user_ruby_smoke.sh` passed after installing the locally built gem into an isolated `GEM_HOME`, proving API availability, packaged README/source files, installed example output, support draft trace normalization, token/URL/path/exception redaction, diagnostic map bounds, uninstall failure, reinstall success, HTTP 503-to-202 retry, flush/shutdown behavior, logger/Rack/Rails integrations, and dependency-span helpers.

## Remaining Gaps

- RubyGems users need a future changed-package or repo-wide release for the helper to be publicly installable from the registry.
- PHP still lacks the equivalent local support-draft helper.
- Backend ticket creation remains blocked until backend support storage/routes are deployed and explicit SDK/agent action is defined.
