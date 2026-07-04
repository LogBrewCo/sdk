# Ruby Span Exception Events - Competitor Research - 2026-07-04

## Source Evidence

- OpenTelemetry Ruby `open-telemetry/opentelemetry-ruby@30fb4fca60983094bad9281afdd0a1d5f9aa99ae`
  - `sdk/lib/opentelemetry/sdk/trace/span.rb`: `Span#add_event` appends bounded span events, and `Span#record_exception` adds an `exception` event with exception type, message, and stacktrace attributes before delegating to `add_event`.
- OpenTelemetry Ruby docs
  - `https://opentelemetry.io/docs/languages/ruby/instrumentation/`: documents span events and recommends recording exceptions on spans, creating an exception span event on the current span.
- Existing Ruby dependency-span source reads remain in `docs/competitor-research/ruby-dependency-spans-2026-06-19.md` for Sentry Ruby, Datadog Ruby tracer, and OpenTelemetry Ruby Contrib automatic DB/cache/queue instrumentation.

## Pattern And Tradeoffs

OpenTelemetry gives Ruby users a standard exception-event shape on spans, but it records message and stacktrace by default. That is useful for debugging and source context, but too broad for LogBrew's default privacy posture in app-owned dependency helpers.

## LogBrew Implementation

LogBrew now supports bounded span events on Ruby `Client#span` payloads and automatically attaches one sanitized `exception` span event to failed app-owned `database_operation`, `cache_operation`, and `queue_operation` spans.

- The event metadata is limited to `exceptionType` and `exceptionEscaped`.
- The original exception is re-raised unchanged.
- Exception messages, stacks, SQL/query text, cache keys/values, queue bodies, job IDs, headers, URLs, auth-like values, baggage, and tracestate remain omitted.
- Success spans remain unchanged and do not carry an empty events array.

## Honest Comparison

LogBrew is now closer to OpenTelemetry for failure time-to-answer because a failed Ruby dependency span has a structured exception event, not only flat metadata. OpenTelemetry remains stronger for full provider/exporter ownership, automatic instrumentation, semantic conventions, links, baggage/tracestate, and richer exception details. LogBrew intentionally keeps the default safer and explicit.

## Verification

- RED: `ruby ruby/logbrew-ruby/tests/operation_tracing.rb` failed on missing span `events`.
- GREEN: `ruby -c ruby/logbrew-ruby/lib/logbrew.rb && ruby -c ruby/logbrew-ruby/lib/logbrew/span_events.rb && ruby -c ruby/logbrew-ruby/lib/logbrew/operation_tracing.rb && ruby ruby/logbrew-ruby/tests/operation_tracing.rb`.
- GREEN: `bash scripts/check_ruby_package.sh`.
- GREEN: `bash scripts/real_user_ruby_smoke.sh`.
