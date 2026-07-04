# Ruby Span Exception Events - Competitor Research - 2026-07-04

## Source Evidence

- Sentry Ruby `getsentry/sentry-ruby@a8a34e3ccf31839ac84dfba7f06a46862944c8bd`
  - `sentry-ruby/lib/sentry/span.rb`: `Span#with_child_span` finishes child spans and marks rescue paths as HTTP 500; `Span#set_status`, `Span#set_data`, and `Span#set_http_status` carry span status/data, not OpenTelemetry-style span events.
  - `sentry-ruby/lib/sentry/interfaces/single_exception.rb`: `SingleExceptionInterface` records exception type, message, module, thread, mechanism, and stacktrace, with optional local-variable capture.
  - `sentry-ruby/lib/sentry/client.rb`: `Client#event_from_exception` builds an error event from exception interfaces and threads.
  - `sentry-ruby/lib/sentry/rack/capture_exceptions.rb`, `sentry-sidekiq/lib/sentry/sidekiq/sentry_context_middleware.rb`, and `sentry-sidekiq/lib/sentry/sidekiq/error_handler.rb`: Rack and Sidekiq integrations create transactions/spans, capture exceptions, set status, and preserve framework context.
- Datadog Ruby `DataDog/dd-trace-rb@04f710c7af3d249615bb3381e734d0e9c9c1712f`
  - `lib/datadog/tracing/span_operation.rb`: `SpanOperation#set_error` marks error status/tags; `SpanOperation#record_exception` appends an `exception` span event with exception type, message, and stacktrace attributes.
  - `lib/datadog/tracing/span_event.rb`: `SpanEvent` validates scalar/array attributes and serializes both tag-based and native span-event formats.
  - `lib/datadog/tracing/transport/serializable_trace.rb`: writes native `span_events` when supported and falls back to serialized span event tags.
  - `lib/datadog/tracing/metadata/errors.rb` and `lib/datadog/tracing/metadata/ext.rb`: define error tags and OpenTelemetry-compatible exception attribute names.
- OpenTelemetry Ruby `open-telemetry/opentelemetry-ruby@30fb4fca60983094bad9281afdd0a1d5f9aa99ae`
  - `sdk/lib/opentelemetry/sdk/trace/span.rb`: `Span#add_event` appends bounded span events, and `Span#record_exception` adds an `exception` event with exception type, message, and stacktrace attributes before delegating to `add_event`.
- PostHog Ruby `PostHog/posthog-ruby@3a090d7fc896eb3ad24f4c0344c4c508c6f8b64a`
  - `lib/posthog/client.rb` and `lib/posthog/exception_capture.rb`: `Client#capture_exception` builds `$exception` events with chained exception payloads, mechanism, message, and stacktrace frames.
  - `posthog-rails/lib/posthog/rails/capture_exceptions.rb`, `error_subscriber.rb`, and `active_job.rb`: Rails middleware/error subscriber/ActiveJob capture exceptions as product events with request/job context; this is not a general span-event tracing model.
- Existing Ruby dependency-span source reads remain in `docs/competitor-research/ruby-dependency-spans-2026-06-19.md` for Sentry Ruby, Datadog Ruby tracer, and OpenTelemetry Ruby Contrib automatic DB/cache/queue instrumentation.

## Pattern And Tradeoffs

Sentry is stronger for automatic framework-owned exception capture, rich error events, and framework context around Rack/Sidekiq/Rails. Datadog and OpenTelemetry are stronger for true span-event APIs: they can put exception events directly on spans and include messages/stacks. PostHog is stronger than LogBrew for Rails exception product events, but it does not provide a tracing-first span-event model.

The shared competitor pattern is: preserve original application exception behavior, mark span/error state, and attach structured exception details for faster debugging. The tradeoff is payload breadth. Sentry/PostHog error events and Datadog/OpenTelemetry span events include exception messages and stack/source frames by default, which improves time-to-answer but can expose more application context than LogBrew's default SDK helper policy should collect.

## LogBrew Implementation

LogBrew now supports bounded span events on Ruby `Client#span` payloads and automatically attaches one sanitized `exception` span event to failed app-owned `database_operation`, `cache_operation`, and `queue_operation` spans.

- The event metadata is limited to `exceptionType` and `exceptionEscaped`.
- The original exception is re-raised unchanged.
- Exception messages, stacks, SQL/query text, cache keys/values, queue bodies, job IDs, headers, URLs, auth-like values, baggage, and tracestate remain omitted.
- Success spans remain unchanged and do not carry an empty events array.

## Honest Comparison

From a real-user debugging view, LogBrew improves Ruby dependency failure spans because the failure has structured exception-event shape, not only flat error metadata. LogBrew is more privacy-bounded by default than Datadog/OpenTelemetry/PostHog/Sentry exception payloads in this helper path because helper-created events do not include exception messages or stacks.

LogBrew is still worse than Sentry and Datadog for automatic framework breadth, full transaction/error joining, out-of-the-box Rails/Sidekiq capture depth, rich stack/source context, baggage/tracestate, links, and exporter/processor ecosystem support. Next Ruby priorities should target real-user time-to-answer: Rails/Sidekiq/Rack helper depth, optional opt-in stack/message capture with strong redaction controls, OpenTelemetry context ingestion, and installed fake-intake high-volume/failure proof.

## Verification

- RED: `ruby ruby/logbrew-ruby/tests/operation_tracing.rb` failed on missing span `events`.
- GREEN: `ruby -c ruby/logbrew-ruby/lib/logbrew.rb`.
- GREEN: `ruby -c ruby/logbrew-ruby/lib/logbrew/span_events.rb`.
- GREEN: `ruby -c ruby/logbrew-ruby/lib/logbrew/operation_tracing.rb`.
- GREEN: `ruby ruby/logbrew-ruby/tests/operation_tracing.rb`.
- GREEN: `ruby ruby/logbrew-ruby/tests/trace_correlation.rb`.
- GREEN: `ruby ruby/logbrew-ruby/tests/run.rb`.
- GREEN: `bash scripts/check_ruby_package.sh`.
- GREEN: `bash scripts/real_user_ruby_smoke.sh`.
- GREEN: `bash scripts/check_shell_static.sh`.
