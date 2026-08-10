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
exception_chain = attributes.fetch("exceptionChain")
reported_exception = exception_chain.fetch("entries").fetch(0)
issue_assert(exception_chain.fetch("entries").length == 1, "expected one reported Ruby exception")
issue_assert(exception_chain.fetch("truncated") == false, "unexpected Ruby exception-chain truncation")
issue_assert(reported_exception.fetch("relationship") == "reported", "expected reported Ruby exception")
issue_assert(reported_exception.fetch("type") == "RuntimeError", "expected matching Ruby exception type")
issue_assert(reported_exception.fetch("messageState") == "redacted", "expected explicit Ruby message redaction state")
issue_assert(reported_exception.fetch("stackFramesState") == "captured", "expected Ruby stack capture state")
issue_assert(reported_exception.fetch("stackFrames") == attributes.fetch("stackFrames"), "expected matching legacy Ruby stack")
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

cause_error = begin
  raise ArgumentError, "private cause message"
rescue ArgumentError => error
  error
end
wrapped_error = begin
  raise RuntimeError.new("private wrapper message"), cause: cause_error
rescue RuntimeError => error
  error
end
wrapped_attributes = LogBrew::IssueDiagnostics.from_exception(wrapped_error)
wrapped_entries = wrapped_attributes.fetch("exceptionChain").fetch("entries")
issue_assert(wrapped_entries.length == 2, "expected reported and causal Ruby exceptions")
cause_entry = wrapped_entries.fetch(1)
issue_assert(cause_entry.fetch("parentId") == 0, "expected Ruby cause parent")
issue_assert(cause_entry.fetch("relationship") == "cause", "expected Ruby cause relationship")
issue_assert(cause_entry.fetch("type") == "ArgumentError", "expected typed Ruby cause")
issue_assert(cause_entry.fetch("messageState") == "redacted", "expected Ruby cause redaction")
issue_assert(cause_entry.fetch("stackFramesState") == "captured", "expected per-cause Ruby stack")
issue_assert(cause_entry.fetch("mechanism").fetch("type") == "ruby.cause", "expected Ruby cause mechanism")
wrapped_json = JSON.generate(wrapped_attributes)
issue_assert(!wrapped_json.include?(cause_error.message), "Ruby cause message leaked")
issue_assert(!wrapped_json.include?(wrapped_error.message), "Ruby wrapper message leaked")

deep_cause = RuntimeError.new("private depth 9")
8.downto(0) do |depth|
  deep_cause = begin
    raise RuntimeError.new("private depth #{depth}"), cause: deep_cause
  rescue RuntimeError => error
    error
  end
end
deep_chain_attributes = LogBrew::IssueDiagnostics.from_exception(deep_cause)
deep_chain = deep_chain_attributes.fetch("exceptionChain")
issue_assert(deep_chain.fetch("entries").length == 8, "expected Ruby exception-chain node cap")
issue_assert(deep_chain.fetch("truncated") == true, "expected Ruby exception-chain truncation receipt")
issue_assert(!JSON.generate(deep_chain_attributes).include?("private depth"), "deep Ruby chain leaked a message")

manual_frame = LogBrew::IssueDiagnostics.stack_frame(filename: "checkout.rb", line: 42, function: "submit")
manual_attributes = LogBrew::IssueDiagnostics.validate_issue_attributes(
  "title" => "Checkout failed",
  "level" => "error",
  "exception" => {
    "type" => "CheckoutFailure",
    "mechanism" => { "type" => "ruby.manual", "handled" => true }
  },
  "exceptionChain" => {
    "entries" => [
      {
        "id" => 0,
        "relationship" => "reported",
        "type" => "CheckoutFailure",
        "message" => "approved summary",
        "messageState" => "truncated",
        "mechanism" => { "type" => "ruby.manual", "handled" => true },
        "stackFrames" => [manual_frame],
        "stackFramesState" => "captured"
      },
      {
        "id" => 1,
        "parentId" => 0,
        "relationship" => "context",
        "type" => "RequestContextFailure",
        "messageState" => "redacted",
        "stackFramesState" => "not_captured"
      }
    ],
    "truncated" => true
  },
  "stackFrames" => [manual_frame]
)
issue_assert(
  manual_attributes.fetch("exceptionChain").fetch("entries").fetch(0).fetch("messageState") == "truncated",
  "expected manual Ruby truncated message state"
)
issue_assert(
  manual_attributes.fetch("exceptionChain").fetch("entries").fetch(1).fetch("relationship") == "context",
  "expected manual Ruby context relationship"
)
expect_issue_error("issue exceptionChain entry 0 must be the parentless reported exception") do
  LogBrew::IssueDiagnostics.validate_issue_attributes(
    "title" => "Bad chain",
    "level" => "error",
    "exception" => { "type" => "CheckoutFailure" },
    "exceptionChain" => {
      "entries" => [{
        "id" => 0,
        "relationship" => "cause",
        "type" => "CheckoutFailure",
        "messageState" => "not_captured",
        "stackFramesState" => "not_captured"
      }],
      "truncated" => false
    }
  )
end

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby",
  sdk_version: "0.1.0",
  capture_runtime_context: false
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
issue_assert(
  LogBrew::IssueDiagnostics.from_exception(deep_error).fetch("exceptionChain").fetch("entries").fetch(0)
    .fetch("stackFramesState") == "truncated",
  "expected Ruby stack truncation state"
)

anonymous_error = Class.new(StandardError).new("private anonymous detail")
anonymous_attributes = LogBrew::IssueDiagnostics.from_exception(anonymous_error, include_stack_frames: false)
issue_assert(
  anonymous_attributes.fetch("exception").fetch("type") == "anonymous_exception",
  "expected stable anonymous exception identity"
)
issue_assert(!anonymous_attributes.key?("stackFrames"), "explicit frame exclusion was ignored")
issue_assert(
  anonymous_attributes.fetch("exceptionChain").fetch("entries").fetch(0).fetch("stackFramesState") == "not_captured",
  "expected explicit Ruby omitted-stack state"
)

unraised_attributes = LogBrew::IssueDiagnostics.from_exception(RuntimeError.new("private unraised detail"))
unraised_reported = unraised_attributes.fetch("exceptionChain").fetch("entries").fetch(0)
issue_assert(!unraised_attributes.key?("stackFrames"), "unraised Ruby exception invented legacy frames")
issue_assert(!unraised_reported.key?("stackFrames"), "unraised Ruby exception invented chain frames")
issue_assert(
  unraised_reported.fetch("stackFramesState") == "not_captured",
  "expected unraised Ruby exception stack absence"
)

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
