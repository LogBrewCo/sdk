# frozen_string_literal: true

require "json"
require "logger"
require "stringio"
require_relative "../lib/logbrew"

def trace_assert(condition, message)
  raise message unless condition
end

def trace_sample_client
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0"
  )
end

trace_tests = 0

context = LogBrew::Trace.from_traceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
trace_assert(context.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736", "expected active trace id")
trace_assert(context.parent_span_id == "00f067aa0ba902b7", "expected active parent span id")
trace_assert(context.span_id.length == 16, "expected generated span id")
trace_assert(context.trace_flags == "01", "expected active trace flags")
trace_assert(context.sampled == true, "expected active sampled flag")
trace_tests += 1

outer = LogBrew::Trace.create(trace_id: "11111111111111111111111111111111", span_id: "2222222222222222")
inner = LogBrew::Trace.create(trace_id: "33333333333333333333333333333333", span_id: "4444444444444444")
outer_scope = LogBrew::Trace.activate(outer)
inner_scope = LogBrew::Trace.activate(inner)
outer_scope.close
trace_assert(LogBrew::Trace.current.trace_id == inner.trace_id, "out-of-order close should preserve active inner scope")
inner_scope.close
trace_assert(LogBrew::Trace.current.nil?, "closing final trace scope should clear active context")
trace_tests += 1

client = trace_sample_client
logger_output = StringIO.new
logger = LogBrew::Logger.new(
  client: client,
  logdev: logger_output,
  logger_name: "checkout",
  event_id_prefix: "trace_logger",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 1) }
)
rack_app = lambda do |env|
  active = LogBrew::Trace.current
  trace_assert(active.is_a?(LogBrew::TraceContext), "expected active trace in Rack app")
  trace_assert(active.trace_id == context.trace_id, "expected Rack app to continue incoming trace")
  trace_assert(active.parent_span_id == context.parent_span_id, "expected Rack app parent span id")

  logger.warn("checkout slow")
  client.issue(
    "evt_trace_issue",
    "2026-06-02T10:00:02Z",
    title: "PaymentWarning",
    level: "warning",
    message: "payment provider slow",
    metadata: { routeTemplate: "/checkout/:cart_id" }
  )
  client.action(
    "evt_trace_action",
    "2026-06-02T10:00:03Z",
    LogBrew::ProductTimeline.product_action(
      name: "checkout.submit",
      route_template: "/checkout/:cart_id?coupon=sample#review",
      status: "running",
      metadata: { cartId: "cart_123" }
    )
  )
  client.metric(
    "evt_trace_metric",
    "2026-06-02T10:00:04Z",
    name: "http.server.duration",
    kind: "histogram",
    value: 31.5,
    unit: "ms",
    temporality: "delta",
    metadata: { routeTemplate: "/checkout/:cart_id", statusCode: 202 }
  )
  env["logbrew.outgoing_traceparent"] = LogBrew::Trace.create_headers(active).fetch("traceparent")
  [202, { "content-type" => "text/plain" }, ["accepted"]]
end
rack = LogBrew::RackMiddleware.new(
  rack_app,
  client: client,
  event_id_prefix: "trace_rack",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 5) }
)
env = {
  "REQUEST_METHOD" => "POST",
  "PATH_INFO" => "/checkout/:cart_id",
  "QUERY_STRING" => "coupon=sample",
  "HTTP_TRACEPARENT" => "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
}
response = rack.call(env)
trace_assert(response[0] == 202, "expected Rack response")
events = JSON.parse(client.preview_json).fetch("events")
trace_assert(events.length == 5, "expected correlated log/issue/action/metric/span events")
by_id = events.each_with_object({}) { |event, index| index[event.fetch("id")] = event }
span = by_id.fetch("trace_rack_span_1").fetch("attributes")
span_id = span.fetch("spanId")
trace_assert(span.fetch("traceId") == context.trace_id, "expected request span trace id")
trace_assert(span.fetch("parentSpanId") == context.parent_span_id, "expected request span parent span id")
trace_assert(span.fetch("name") == "POST /checkout/:cart_id", "expected route-based span name")
trace_assert(env.fetch("logbrew.outgoing_traceparent") == "00-#{context.trace_id}-#{span_id}-01", "expected outgoing traceparent")
%w[trace_logger_1 evt_trace_issue evt_trace_action evt_trace_metric trace_rack_span_1].each do |event_id|
  metadata = by_id.fetch(event_id).fetch("attributes").fetch("metadata")
  trace_assert(metadata.fetch("traceId") == context.trace_id, "expected #{event_id} trace id")
  trace_assert(metadata.fetch("spanId") == span_id, "expected #{event_id} span id")
  trace_assert(metadata.fetch("traceFlags") == "01", "expected #{event_id} trace flags")
  trace_assert(metadata.fetch("traceSampled") == true, "expected #{event_id} sampled flag")
  trace_assert(!metadata.key?("ignored"), "expected #{event_id} to omit non-primitive metadata")
end
trace_assert(!client.preview_json.include?("traceparent"), "raw traceparent must not be serialized")
trace_assert(!client.preview_json.include?("coupon=sample"), "query string must not be serialized")
trace_tests += 1

fallback_client = trace_sample_client
fallback_rack = LogBrew::RackMiddleware.new(
  lambda { |_env| [200, {}, ["ok"]] },
  client: fallback_client,
  event_id_prefix: "fallback_rack",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 6) }
)
fallback_rack.call("REQUEST_METHOD" => "GET", "PATH_INFO" => "/fallback", "HTTP_TRACEPARENT" => "malformed")
fallback_span = JSON.parse(fallback_client.preview_json).fetch("events")[0].fetch("attributes")
trace_assert(fallback_span.fetch("traceId").length == 32, "malformed propagation should create local trace")
trace_assert(fallback_span.fetch("spanId").length == 16, "malformed propagation should create local span")
trace_assert(!fallback_span.key?("parentSpanId"), "malformed propagation should not set parent span")
trace_tests += 1

rails_client = trace_sample_client
subscriber = LogBrew::RailsErrorSubscriber.new(
  client: rails_client,
  event_id_prefix: "trace_rails",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 7) }
)
LogBrew::Trace.with_context(context) do
  subscriber.report(
    RuntimeError.new("handled checkout failure"),
    handled: true,
    severity: :warning,
    context: { route: "checkout#create" },
    source: "checkout.subscriber"
  )
end
rails_metadata = JSON.parse(rails_client.preview_json).fetch("events")[0].fetch("attributes").fetch("metadata")
trace_assert(rails_metadata.fetch("traceId") == context.trace_id, "expected Rails subscriber trace id")
trace_assert(rails_metadata.fetch("spanId") == context.span_id, "expected Rails subscriber span id")
trace_assert(rails_metadata.fetch("parentSpanId") == context.parent_span_id, "expected Rails subscriber parent span id")
trace_tests += 1

puts "ruby trace correlation tests ok (#{trace_tests} tests)"
