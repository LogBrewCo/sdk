# frozen_string_literal: true

require "json"
require "logbrew"

incoming_traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
route_template = "/checkout/:cart_id"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "checkout-rack-app",
  sdk_version: "1.2.3"
)
client.release(
  "evt_release_checkout_trace",
  "2026-06-02T10:00:00Z",
  version: "1.2.3",
  commit: "abc123def456",
  metadata: { service: "checkout" }
)
client.environment(
  "evt_environment_checkout_trace",
  "2026-06-02T10:00:01Z",
  name: "production",
  region: "global",
  metadata: { service: "checkout" }
)

logger = LogBrew::Logger.new(
  client: client,
  logger_name: "checkout",
  event_id_prefix: "ruby_http_trace",
  metadata: { service: "checkout", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 2) }
)

app = lambda do |env|
  trace = LogBrew::Trace.current
  raise "missing active trace" unless trace

  logger.warn("checkout request is slow")
  client.issue(
    "evt_issue_checkout_trace",
    "2026-06-02T10:00:03Z",
    title: "PaymentProviderWarning",
    level: "warning",
    message: "payment provider latency crossed threshold",
    metadata: { routeTemplate: route_template }
  )
  client.action(
    "evt_action_checkout_trace",
    "2026-06-02T10:00:04Z",
    LogBrew::ProductTimeline.product_action(
      name: "checkout.submit",
      status: "running",
      route_template: "https://shop.example/checkout/:cart_id?coupon=sample#review",
      metadata: { cartTier: "gold" }
    )
  )
  client.metric(
    "evt_metric_checkout_trace",
    "2026-06-02T10:00:05Z",
    name: "http.server.duration",
    kind: "histogram",
    value: 183.4,
    unit: "ms",
    temporality: "delta",
    metadata: { routeTemplate: route_template, statusCode: 202 }
  )
  env["logbrew.outgoing_traceparent"] = LogBrew::Trace.create_headers(trace).fetch("traceparent")
  [202, { "content-type" => "text/plain" }, ["accepted"]]
end

rack = LogBrew::RackMiddleware.new(
  app,
  client: client,
  event_id_prefix: "ruby_http_trace",
  metadata: { service: "checkout", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 6) }
)
env = {
  "REQUEST_METHOD" => "POST",
  "PATH_INFO" => route_template,
  "QUERY_STRING" => "coupon=sample",
  "HTTP_TRACEPARENT" => incoming_traceparent
}
response = rack.call(env)
raise "unexpected Rack response" unless response[0] == 202

puts client.preview_json
transport = LogBrew::RecordingTransport.always_accept
flush_response = client.shutdown(transport)
warn JSON.generate(
  ok: true,
  status: flush_response.status_code,
  attempts: flush_response.attempts,
  events: 7,
  outgoingTraceparent: env.fetch("logbrew.outgoing_traceparent")
)
