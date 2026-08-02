# frozen_string_literal: true

require "json"
require_relative "../lib/logbrew"

def issue_assert(condition, message)
  raise message unless condition
end

def expect_issue_error(message_fragment)
  yield
rescue LogBrew::SdkError => error
  issue_assert(error.code == "validation_error", "expected validation_error, got #{error.code}")
  issue_assert(error.message.include?(message_fragment), "expected error containing #{message_fragment}")
  return error
end

module RubyIssueDiagnosticsFixture
  def self.fail_checkout
    raise RuntimeError, "private payment-provider response"
  end
end

captured_error = begin
  RubyIssueDiagnosticsFixture.fail_checkout
rescue RuntimeError => error
  error
end

breadcrumb_data = { attempt: 2, retryable: false }
breadcrumbs = [
  LogBrew::IssueDiagnostics.breadcrumb(
    timestamp: "2026-08-02T12:00:00Z",
    category: "checkout.navigation",
    type: "navigation",
    message: "Checkout opened",
    data: { screen: "Checkout" }
  ),
  LogBrew::IssueDiagnostics.breadcrumb(
    timestamp: "2026-08-02T12:00:01.250+00:00",
    category: "payment.request",
    level: "warn",
    data: breadcrumb_data
  )
]

attributes = LogBrew::IssueDiagnostics.from_exception(
  captured_error,
  title: "Checkout payment failed",
  message: "The payment dependency rejected checkout.",
  mechanism_type: "ruby.exception",
  handled: true,
  metadata: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" },
  breadcrumbs: breadcrumbs,
  breadcrumbs_truncated: true
)
breadcrumb_data[:attempt] = 99
breadcrumbs[0]["category"] = "mutated"

issue_assert(
  attributes.fetch("exception") == {
    "type" => "RuntimeError",
    "mechanism" => { "type" => "ruby.exception", "handled" => true }
  },
  "expected typed Ruby exception mechanism"
)
frames = attributes.fetch("stackFrames")
issue_assert(frames.length.between?(1, 32), "expected bounded Ruby exception frames")
first_frame = frames.fetch(0)
issue_assert(first_frame.fetch("filename") == "issue_diagnostics.rb", "expected basename-only throw frame")
issue_assert(first_frame.fetch("line").positive?, "expected positive throw-frame line")
issue_assert(first_frame.fetch("column") == 1, "expected generated frame column")
issue_assert(first_frame.fetch("function") == "fail_checkout", "expected generated function identity")
issue_assert(!first_frame.fetch("filename").include?(File::SEPARATOR), "expected no absolute frame path")
issue_assert(attributes.fetch("breadcrumbs").fetch(0).fetch("category") == "checkout.navigation", "expected detached breadcrumb copy")
issue_assert(attributes.fetch("breadcrumbs").fetch(1).fetch("level") == "warning", "expected breadcrumb level normalization")
issue_assert(attributes.fetch("breadcrumbs").fetch(1).fetch("data").fetch("attempt") == 2, "expected detached breadcrumb data")
issue_assert(attributes.fetch("breadcrumbsTruncated") == true, "expected explicit breadcrumb truncation")

serialized = JSON.generate(attributes)
issue_assert(!serialized.include?(captured_error.message), "default exception projection leaked exception text")
issue_assert(!serialized.include?(File.expand_path("..", __dir__)), "default exception projection leaked an absolute path")

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby",
  sdk_version: "0.1.0"
)
client.issue("evt_ruby_diagnostics", "2026-08-02T12:00:02Z", attributes)
queued_attributes = JSON.parse(client.preview_json).fetch("events").fetch(0).fetch("attributes")
issue_assert(queued_attributes == attributes, "client changed validated issue diagnostics")

private_default = LogBrew::IssueDiagnostics.from_exception(captured_error)
issue_assert(!private_default.key?("message"), "exception message should require explicit capture")
issue_assert(private_default.fetch("exception").fetch("mechanism").fetch("type") == "ruby.exception", "expected default Ruby mechanism")

deep_error = RuntimeError.new("private deep stack")
deep_error.set_backtrace(
  40.times.map { |index| "/opt/example/app/frame#{index}.rb:#{index + 1}:in `step#{index}'" }
)
bounded_frames = LogBrew::IssueDiagnostics.from_exception(deep_error).fetch("stackFrames")
issue_assert(bounded_frames.length == 32, "expected generated Ruby frame cap")
issue_assert(bounded_frames.fetch(0).fetch("filename") == "frame0.rb", "expected newest generated frame first")
issue_assert(bounded_frames.fetch(31).fetch("filename") == "frame31.rb", "expected generated frame cap order")
issue_assert(!JSON.generate(bounded_frames).include?("/opt/example"), "generated Ruby frames leaked an absolute path")

anonymous_error = Class.new(StandardError).new("private anonymous detail")
anonymous_attributes = LogBrew::IssueDiagnostics.from_exception(anonymous_error, include_stack_frames: false)
issue_assert(
  anonymous_attributes.fetch("exception").fetch("type") == "anonymous_exception",
  "expected stable anonymous exception identity"
)
issue_assert(!anonymous_attributes.key?("stackFrames"), "explicit frame exclusion was ignored")

explicit_frame = LogBrew::IssueDiagnostics.stack_frame(
  filename: "file:///opt/example/app/services/checkout.rb?mode=sample#source",
  line: 91,
  column: 7,
  function: "charge",
  module_name: "Checkout::PaymentService",
  in_app: true,
  debug_id: "ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF"
)
issue_assert(
  explicit_frame == {
    "filename" => "checkout.rb",
    "line" => 91,
    "column" => 7,
    "function" => "charge",
    "module" => "Checkout::PaymentService",
    "inApp" => true,
    "debugId" => "abcdefab-1234-5678-90ab-abcdefabcdef"
  },
  "expected normalized explicit Ruby frame"
)

expect_issue_error("issue exception mechanism type must be a stable machine name") do
  LogBrew::IssueDiagnostics.exception(type: "RuntimeError", mechanism_type: "bad mechanism", handled: false)
end
expect_issue_error("issue stackFrames must contain 1-32 frames") do
  client.issue(
    "evt_too_many_frames",
    "2026-08-02T12:00:03Z",
    title: "failure",
    level: "error",
    stackFrames: Array.new(33, explicit_frame)
  )
end
expect_issue_error("issue breadcrumbs must contain 1-64 entries") do
  client.issue(
    "evt_too_many_breadcrumbs",
    "2026-08-02T12:00:04Z",
    title: "failure",
    level: "error",
    breadcrumbs: Array.new(65, attributes.fetch("breadcrumbs").fetch(0))
  )
end
expect_issue_error("issue breadcrumb data must contain at most 8 fields") do
  LogBrew::IssueDiagnostics.breadcrumb(
    timestamp: "2026-08-02T12:00:05Z",
    category: "checkout",
    data: Hash[(0...9).map { |index| ["item#{index}", index] }]
  )
end
expect_issue_error("issue breadcrumb timestamp must be RFC 3339 with an explicit timezone") do
  LogBrew::IssueDiagnostics.breadcrumb(timestamp: "2026-08-02 12:00:05", category: "checkout")
end
expect_issue_error("issue stack frame line must be a positive integer") do
  LogBrew::IssueDiagnostics.stack_frame(filename: "checkout.rb", line: 0)
end

puts "ruby issue diagnostics tests passed"
