# Ruby Dependency Spans - Competitor Research - 2026-06-19

## Source Evidence

- Sentry Ruby `getsentry/sentry-ruby@3f3a9214e0639b61581ede8a697ca57804e6b96b`
  - `sentry-rails/lib/sentry/rails/tracing/active_record_subscriber.rb`: `ActiveRecordSubscriber.subscribe!` listens to `sql.active_record`, creates child DB spans, records SQL text, adapter, database, host, port, socket, cache flag, and optional source location.
  - `sentry-rails/lib/sentry/rails/tracing/abstract_subscriber.rb`: `record_on_current_span` wraps ActiveSupport events in `Sentry.with_child_span`.
  - `sentry-sidekiq/lib/sentry/sidekiq/sentry_context_middleware.rb`: server/client middleware creates Sidekiq process/publish spans, propagates trace headers, and records queue, job ID, latency, retry count, tags, and job context.
- Datadog Ruby tracer `DataDog/dd-trace-rb@e458e5e8daa906671479a626dd1e8f6cea028ce3`
  - `lib/datadog/tracing/contrib/active_record/events/sql.rb`: ActiveRecord SQL event spans, adapter/service/resource, DB name, cache flag, host, and port tags.
  - `lib/datadog/tracing/contrib/redis/trace_middleware.rb` and `redis/instrumentation.rb`: Redis command and pipeline spans, quantized command resources, service config, and common Redis tags.
  - `lib/datadog/tracing/contrib/sidekiq/server_tracer.rb` and `client_tracer.rb`: Sidekiq server/client spans, distributed propagation, queue/job metadata, retry/delay metrics, and optional argument quantization.
- OpenTelemetry Ruby Contrib `open-telemetry/opentelemetry-ruby-contrib@a407830531cd06da5ee6fc5ff5129c1751ded938`
  - `instrumentation/redis/lib/opentelemetry/instrumentation/redis/patches/redis_v4_client.rb`: prepends Redis client calls, creates client spans, can serialize or obfuscate command statements, records host/port/db index, and records command errors.
  - `instrumentation/redis/lib/opentelemetry/instrumentation/redis/middlewares/redis_client.rb`: Redis 5 middleware span pattern for single and pipelined commands.
  - `instrumentation/active_record/lib/opentelemetry/instrumentation/active_record/patches/persistence.rb`: wraps persistence methods in spans through the instrumentation tracer.

## Pattern And Tradeoffs

Mature Ruby observability SDKs win on broad automatic coverage: Rails notifications, Redis client prepends/middleware, Sidekiq middleware, trace propagation, and richer semantic attributes. The cost is heavier runtime patching, framework dependencies, wider metadata capture, and more ways to record SQL, host, job IDs, args, or command text unless users configure filtering carefully.

## LogBrew Implementation

LogBrew now ships dependency-free `LogBrew::OperationTracing.database_operation(...)`, `cache_operation(...)`, and `queue_operation(...)`.

- The app passes an owned block; LogBrew does not import or patch ActiveRecord, Redis, Sidekiq, Resque, Delayed Job, or OpenTelemetry.
- The block runs under a child `LogBrew::Trace` context so logs, issues, metrics, actions, and the dependency span can share one trace.
- The helper emits exactly one span, preserves the block return value or original exception, and isolates span-capture failures through optional `on_error:`.
- Metadata is primitive-only and drops SQL/query/statement/params, connection details, host, cache keys/values, command text, message bodies, job IDs, broker/header/cookie/url/auth-like fields, and exception messages/stacks.

## Honest Comparison

LogBrew is now better for teams that want a small, explicit, safe Ruby core API with installed-gem proof and obvious privacy boundaries. Sentry, Datadog, and OpenTelemetry remain better for automatic Rails/Redis/Sidekiq coverage, richer semantic conventions, distributed queue propagation, baggage/tracestate, and span events/exceptions.

## Verification

- Focused TDD added `ruby/logbrew-ruby/tests/operation_tracing.rb`.
- Installed-gem proof in `scripts/real_user_ruby_smoke.sh` verifies packaged helper files, README docs, public API availability, trace correlation, result preservation, and unsafe metadata dropping.

## Remaining Ruby Gaps

- Optional framework-owned ActiveRecord/Redis/Sidekiq/Resque/Delayed Job integrations.
- Richer semantic conventions, baggage/tracestate, span events/exceptions/links, and queue propagation only in opt-in packages with separate dependency and privacy proof.
