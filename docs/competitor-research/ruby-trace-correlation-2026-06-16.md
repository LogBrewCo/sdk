# Ruby Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority. Ruby already had dependency-free W3C `Traceparent` helpers, first-useful telemetry, `Net::HTTP` delivery, standard-library `Logger` support, Rack middleware, and a Rails error subscriber. It still lacked the Sentry-competitive active request context where one request trace links Ruby logs, handled issues, product actions, metrics, request spans, and outgoing propagation without passing IDs manually at every call.

## Source Reviewed

- Sentry Ruby `getsentry/sentry-ruby` at commit `b53bfe12a0e36eeb085d35f2c71403e0248403b2`.
- Read `sentry-ruby/lib/sentry/rack/capture_exceptions.rb`: `call`, `start_transaction`, `capture_exception`, and `finish_transaction`.
- Read `sentry-ruby/lib/sentry/hub.rb`: `with_scope`, `with_child_span`, `capture_exception`, and current scope/span handling.
- Read `sentry-ruby/lib/sentry/std_lib_logger.rb`: `add` and the `Logger.prepend` log capture pattern.
- Read `sentry-ruby/lib/sentry/propagation_context.rb`: `get_trace_context` and `get_traceparent`.
- OpenTelemetry Ruby `open-telemetry/opentelemetry-ruby` at commit `fd3b31c6480d7c03e31f97d071a0f90e0de8a632`.
- Read `api/lib/opentelemetry/context.rb`: `current`, `attach`, `detach`, `with_current`, and stack handling.
- Read `api/lib/opentelemetry/trace.rb`: `current_span`, `context_with_span`, and `with_span`.
- Read `api/lib/opentelemetry/trace/propagation/trace_context/text_map_propagator.rb`: `inject`, `extract`, and malformed extraction fallback.
- Read `examples/http/server.rb`: Rack extraction, active context, server span, and HTTP route attributes.
- Datadog Ruby tracer `DataDog/dd-trace-rb` at commit `9f17636537642d3209b065c52faa08cbbe3738ed`.
- Read `lib/datadog/tracing.rb`: `active_trace`, `active_span`, `correlation`, and `log_correlation`.
- Read `lib/datadog/tracing/correlation.rb`: `Identifier`, `to_h`, `to_log_format`, and trace-id formatting.
- Read `lib/datadog/tracing/contrib/rack/middlewares.rb`: `call`, distributed extraction, request span creation, env attachment, route/status tagging, and URL quantization.

## Competitor Patterns

- Sentry Rack opens a request transaction, sets the active span on the current scope, captures errors against that scope, and finishes the transaction after status is known.
- Sentry’s logger support uses a global prepend to capture standard logger calls, which is convenient but wider than LogBrew’s app-owned adapter goal.
- OpenTelemetry Ruby uses current context stacks plus W3C text-map extraction/injection; malformed propagation returns the original context instead of failing the app.
- Datadog exposes `active_trace`, `active_span`, and a stable log-correlation API, then Rack middleware attaches request spans to the Rack environment for framework layers.
- Mature competitors are stronger for automatic Rails/Sinatra/Rack, DB, cache, queue, outbound HTTP, baggage, and OTel interop, but their defaults and packages are heavier.

## LogBrew Improvement From This Pass

- Added `LogBrew::TraceContext`, `LogBrew::Trace`, and `LogBrew::TraceScope` for request-local active trace access, W3C `traceparent` continuation, local root fallback, outgoing propagation, sampled flags, and scope-safe close handling.
- `LogBrew::RackMiddleware` now reads only W3C `traceparent` or explicit W3C-shaped `logbrew.*` env fields, activates one request-local trace while the app runs, emits the request span with that same span ID, and handles malformed propagation non-fatally.
- `LogBrew::Logger`, direct `client.log`, `client.issue`, `client.action`, `client.metric`, and `LogBrew::RailsErrorSubscriber` now add active trace metadata automatically when a request trace is active.
- Added packaged `examples/http_trace_correlation.rb` and installed-gem validation for one W3C trace spanning logger output, issue, action, `http.server.duration`, request span, and outgoing `traceparent`.

## Where LogBrew Is Better Today

- Lighter and more explicit for Ruby services that want request trace-log-error-action-metric correlation without a Rails dependency, OpenTelemetry setup, Datadog native extension stack, global logger patching, HTTP client patching, payload capture, arbitrary header capture, or raw propagation serialization.
- `RackMiddleware` keeps route paths query-free and metadata primitive-only, and malformed propagation falls back to a valid local root trace without interrupting the request.
- The standard-library logger adapter preserves app-owned logger configuration and failure behavior while still adding active trace IDs.

## Where LogBrew Is Still Worse

- No dedicated Rails/Sinatra middleware package, Rails controller/view/ActiveRecord spans, Sidekiq/job spans, outbound HTTP spans, database/cache/queue spans, baggage, tracestate, rich span events, or exception-span modeling.
- No OpenTelemetry Ruby context bridge yet, so apps already using OTel must explicitly pass W3C `traceparent` or use LogBrew’s Rack middleware as the active context source.
- The latest competitor footprint comparison still needs a Ruby 3.3+ benchmark because local Ruby 2.6.10 only proved install friction.

## Updated Evidence

- `ruby ruby/logbrew-ruby/tests/run.rb`: 35 existing package tests plus 5 trace-correlation tests for W3C continuation, out-of-order scope close handling, Rack active context, logger/client/action/metric/span metadata correlation, malformed propagation fallback, and Rails subscriber correlation.
- `bash scripts/check_ruby_package.sh`: validates Ruby syntax, package tests, gem build/unpack, README/package needles, and direct `http_trace_correlation.rb` payload validation.
- `bash scripts/real_user_ruby_smoke.sh`: builds the gem, unpacks it, installs/removes/reinstalls it into a temporary app, and validates `http_trace_correlation.rb` from unpacked and installed artifacts.
- `python3 scripts/check_ruby_http_trace_payload.py`: verifies one trace/span pair across logger, issue, action, metric, request span, and outgoing W3C `traceparent`, while rejecting raw propagation, query strings, and non-primitive metadata leakage.
