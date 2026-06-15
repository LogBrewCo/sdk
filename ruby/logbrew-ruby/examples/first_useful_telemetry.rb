# frozen_string_literal: true

require "json"
require "logbrew"

incoming_traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
trace_context = LogBrew::Traceparent.parse(incoming_traceparent)
child_span_id = "b7ad6b7169203331"
outgoing_headers = LogBrew::Traceparent.create_headers(
  trace_id: trace_context.trace_id,
  span_id: child_span_id,
  trace_flags: trace_context.trace_flags
)
session_id = "sess_checkout_123"
route_template = "/checkout/:cart_id"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "checkout-service",
  sdk_version: "1.2.3"
)
client.release(
  "evt_release_checkout",
  "2026-06-02T10:00:00Z",
  version: "1.2.3",
  commit: "abc123def456",
  metadata: { service: "checkout-service" }
)
client.environment(
  "evt_environment_checkout",
  "2026-06-02T10:00:01Z",
  name: "production",
  region: "global",
  metadata: { service: "checkout-service" }
)
client.log(
  "evt_log_checkout_started",
  "2026-06-02T10:00:02Z",
  message: "checkout request started",
  level: "info",
  logger: "checkout",
  metadata: {
    traceId: trace_context.trace_id,
    sessionId: session_id,
    routeTemplate: route_template
  }
)
client.action(
  "evt_action_checkout_submit",
  "2026-06-02T10:00:03Z",
  LogBrew::ProductTimeline.product_action(
    name: "checkout.submit",
    route_template: "https://shop.example/checkout/:cart_id?coupon=sample#review",
    session_id: session_id,
    trace_id: trace_context.trace_id,
    screen: "Checkout",
    funnel: "checkout",
    step: "submit",
    metadata: { cartTier: "gold" }
  )
)
client.action(
  "evt_action_payment_api",
  "2026-06-02T10:00:04Z",
  LogBrew::ProductTimeline.network_milestone(
    route_template: "https://api.example/payments/:payment_id?card=sample",
    method: "post",
    status_code: 202,
    duration_ms: 183.4,
    session_id: session_id,
    trace_id: trace_context.trace_id,
    metadata: { dependency: "payments" }
  )
)
client.metric(
  "evt_metric_http_server_duration",
  "2026-06-02T10:00:05Z",
  name: "http.server.duration",
  kind: "histogram",
  value: 183.4,
  unit: "ms",
  temporality: "delta",
  metadata: {
    method: "POST",
    routeTemplate: route_template,
    statusCode: 202,
    traceId: trace_context.trace_id
  }
)
client.span(
  "evt_span_checkout_request",
  "2026-06-02T10:00:06Z",
  LogBrew::Traceparent.span_attributes_from_traceparent(
    trace_context,
    LogBrew::TraceparentSpanInput.new(
      name: "POST /checkout/:cart_id",
      span_id: child_span_id,
      duration_ms: 183.4,
      metadata: {
        sampled: trace_context.sampled,
        routeTemplate: route_template,
        sessionId: session_id
      }
    )
  )
)

puts client.preview_json

transport = LogBrew::RecordingTransport.always_accept
response = client.shutdown(transport)
warn JSON.generate(
  ok: true,
  status: response.status_code,
  attempts: response.attempts,
  events: 7,
  outgoingTraceparent: outgoing_headers.fetch("traceparent")
)
