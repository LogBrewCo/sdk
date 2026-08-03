# frozen_string_literal: true

require "json"
require "tmpdir"
require_relative "../lib/logbrew"

def context_assert(condition, message)
  raise message unless condition
end

def expect_context_error(message_fragment)
  yield
  raise "expected telemetry context validation error containing #{message_fragment}"
rescue LogBrew::SdkError => error
  context_assert(error.code == "validation_error", "expected validation_error, got #{error.code}")
  context_assert(
    error.message.include?(message_fragment),
    "expected telemetry context error containing #{message_fragment}, got #{error.message}"
  )
  error
end

def context_client(context: nil, capture_runtime_context: false, persistent_queue_path: nil)
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0",
    context: context,
    capture_runtime_context: capture_runtime_context,
    persistent_queue_path: persistent_queue_path
  )
end

def contextual_attributes(attributes, context)
  return attributes if context.nil?

  attributes.merge(context: context)
end

def enqueue_context_signals(client, prefix:, context: nil)
  timestamp = "2026-08-03T10:00:00Z"
  client.release(
    "#{prefix}_release",
    timestamp,
    contextual_attributes({ version: "checkout@1.4.0", commit: "abc1234" }, context)
  )
  client.environment(
    "#{prefix}_environment",
    timestamp,
    contextual_attributes({ name: "production", region: "global" }, context)
  )
  client.issue(
    "#{prefix}_issue",
    timestamp,
    contextual_attributes({ title: "Checkout failed", level: "error" }, context)
  )
  client.log(
    "#{prefix}_log",
    timestamp,
    contextual_attributes({ message: "checkout started", level: "info", logger: "checkout" }, context)
  )
  client.span(
    "#{prefix}_span",
    timestamp,
    contextual_attributes(
      {
        name: "POST /checkout/:cart_id",
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        status: "ok",
        durationMs: 12.5
      },
      context
    )
  )
  client.metric(
    "#{prefix}_metric",
    timestamp,
    contextual_attributes(
      {
        name: "checkout.duration",
        kind: "histogram",
        value: 12.5,
        unit: "ms",
        temporality: "delta"
      },
      context
    )
  )
  client.action(
    "#{prefix}_action",
    timestamp,
    contextual_attributes({ name: "checkout.submit", status: "success" }, context)
  )
end

def context_events(client)
  JSON.parse(client.preview_json).fetch("events")
end

def event_context(event)
  event.fetch("attributes").fetch("context")
end

tests = 0

source = {
  schemaVersion: 1,
  resource: {
    service: { name: " checkout-api ", version: "1.4.0" },
    deployment: { environment: "production", release: "checkout@1.4.0" },
    runtime: { name: "ruby", version: "3.3.0" },
    framework: { name: "rails", version: "8.1.3" },
    operatingSystem: { name: "linux", version: "6.8" },
    device: { family: "server", architecture: "arm64" },
    application: { name: "checkout", version: "1.4.0", build: "140" }
  },
  trace: {
    traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
    spanId: "00F067AA0BA902B7",
    sampled: true
  },
  session: { id: "session_checkout", previousId: "session_cart" },
  subject: { id: "subject_42", kind: "user" },
  tags: { journey: " checkout ", region: "eu" }
}
detached = LogBrew::TelemetryContext.from_hash(source)
source[:resource][:service][:name] = "mutated"
source[:tags][:journey] = "mutated"
detached_copy = detached.to_h
detached_copy.fetch("resource").fetch("service")["name"] = "mutated-again"
detached_copy.fetch("tags")["journey"] = "mutated-again"
detached_value = detached.to_h
context_assert(detached_value.dig("resource", "service", "name") == "checkout-api", "context did not detach resource input")
context_assert(detached_value.dig("tags", "journey") == "checkout", "context did not detach tag input")
context_assert(detached_value.dig("trace", "traceId") == "4bf92f3577b34da6a3ce929d0e0e4736", "context did not normalize trace id")
context_assert(detached_value.dig("trace", "spanId") == "00f067aa0ba902b7", "context did not normalize span id")
tests += 1

client_resource = LogBrew::TelemetryResource.create
  .with_service(name: "checkout-api", version: "1.4.0")
  .with_deployment(environment: "production", release: "checkout@1.4.0")
  .with_runtime(name: "ruby", version: "3.3.0")
  .with_framework(name: "rails", version: "8.1.3")
  .with_operating_system(name: "linux", version: "6.8")
  .with_device(family: "server", architecture: "arm64")
  .with_application(name: "checkout", version: "1.4.0", build: "140")
  .build
client_context = LogBrew::TelemetryContext.create
  .with_resource(client_resource)
  .with_session(id: "session_client", previous_id: "session_previous")
  .with_subject(id: "subject_client", kind: "user")
  .with_tags("journey" => "checkout", "region" => "eu")
  .build
event_resource = LogBrew::TelemetryResource.create
  .with_service(name: "checkout-api", version: "1.4.1")
  .with_deployment(release: "checkout@1.4.1")
  .with_framework(name: "rails", version: "8.1.4")
  .build
event_override = LogBrew::TelemetryContext.create
  .with_resource(event_resource)
  .with_trace_ids(
    trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    span_id: "bbbbbbbbbbbbbbbb",
    parent_span_id: "cccccccccccccccc",
    sampled: false
  )
  .with_session(id: "session_event")
  .with_subject(id: "subject_event", kind: "anonymous")
  .with_tags("journey" => "recovery", "step" => "payment")
  .build
client = context_client(context: client_context)
enqueue_context_signals(client, prefix: "merged", context: event_override)
events = context_events(client)
context_assert(events.length == 7, "expected shared context on all seven Ruby signals")
events.each do |event|
  context = event_context(event)
  context_assert(context.fetch("schemaVersion") == 1, "expected schema version 1")
  context_assert(context.dig("resource", "service", "name") == "checkout-api", "expected client service name")
  context_assert(context.dig("resource", "service", "version") == "1.4.1", "expected event service version")
  context_assert(context.dig("resource", "deployment", "environment") == "production", "expected client environment")
  context_assert(context.dig("resource", "deployment", "release") == "checkout@1.4.1", "expected event release")
  context_assert(context.dig("resource", "framework", "version") == "8.1.4", "expected event framework")
  context_assert(context.dig("resource", "application", "build") == "140", "expected client application")
  context_assert(context.dig("trace", "traceId") == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expected event trace replacement")
  context_assert(context.dig("session", "id") == "session_event", "expected event session replacement")
  context_assert(!context.fetch("session").key?("previousId"), "event session must replace client session")
  context_assert(context.dig("subject", "id") == "subject_event", "expected event subject replacement")
  context_assert(context.dig("tags", "journey") == "recovery", "expected event tag override")
  context_assert(context.dig("tags", "region") == "eu", "expected retained client tag")
  context_assert(context.dig("tags", "step") == "payment", "expected event tag addition")
end
tests += 1

ambient_context = LogBrew::TelemetryContext.create
  .with_session(id: "session_ambient")
  .with_tag("scope", "outer")
  .build
nested_context = LogBrew::TelemetryContext.create
  .with_tag("scope", "inner")
  .with_tag("step", "confirm")
  .build
active_trace = LogBrew::Trace.create(
  trace_id: "dddddddddddddddddddddddddddddddd",
  span_id: "eeeeeeeeeeeeeeee",
  parent_span_id: "ffffffffffffffff",
  trace_flags: "01"
)
ambient_client = context_client(
  context: LogBrew::TelemetryContext.create.with_tag("client", "ruby").build
)
context_assert(LogBrew::Telemetry.current_context.nil?, "expected no ambient context before activation")
LogBrew::Telemetry.with_context(ambient_context) do
  LogBrew::Trace.with_context(active_trace) do
    enqueue_context_signals(ambient_client, prefix: "ambient")
    LogBrew::Telemetry.with_context(nested_context) do
      ambient_client.log(
        "ambient_nested",
        "2026-08-03T10:00:01Z",
        message: "nested",
        level: "info"
      )
    end
    ambient_client.log(
      "ambient_after_nested",
      "2026-08-03T10:00:02Z",
      message: "after nested",
      level: "info"
    )
  end
end
context_assert(LogBrew::Telemetry.current_context.nil?, "ambient context did not unwind")
ambient_events = context_events(ambient_client)
ambient_events.first(7).each do |event|
  context = event_context(event)
  context_assert(context.dig("session", "id") == "session_ambient", "expected ambient session on every signal")
  context_assert(context.dig("trace", "traceId") == active_trace.trace_id, "expected active trace on every signal")
  context_assert(context.dig("trace", "spanId") == active_trace.span_id, "expected active span on every signal")
  context_assert(context.dig("tags", "client") == "ruby", "expected client tag under ambient context")
end
nested_event = ambient_events.find { |event| event.fetch("id") == "ambient_nested" }
after_nested_event = ambient_events.find { |event| event.fetch("id") == "ambient_after_nested" }
context_assert(event_context(nested_event).dig("tags", "scope") == "inner", "expected nested scope override")
context_assert(event_context(nested_event).dig("tags", "step") == "confirm", "expected nested scope tag")
context_assert(event_context(after_nested_event).dig("tags", "scope") == "outer", "expected exact outer scope after nesting")
context_assert(!event_context(after_nested_event).fetch("tags").key?("step"), "nested scope remained after unwind")
application_error = RuntimeError.new("application failure")
raised_error = nil
begin
  LogBrew::Telemetry.with_context(ambient_context) { raise application_error }
rescue RuntimeError => error
  raised_error = error
end
context_assert(raised_error.equal?(application_error), "context wrapper changed the application error")
context_assert(LogBrew::Telemetry.current_context.nil?, "context remained after application failure")
manual_scope = LogBrew::Telemetry.activate_context(ambient_context)
context_assert(LogBrew::Telemetry.current_context.to_h == ambient_context.to_h, "manual activation did not expose context")
manual_scope.close
manual_scope.close
context_assert(LogBrew::Telemetry.current_context.nil?, "idempotent manual close left context active")
tests += 1

isolation_client = context_client
LogBrew::Telemetry.with_context(ambient_context) do
  thread = Thread.new do
    isolation_client.log(
      "isolated_thread",
      "2026-08-03T10:00:03Z",
      message: "thread",
      level: "info"
    )
  end
  thread.join
  isolation_client.log(
    "owning_thread",
    "2026-08-03T10:00:04Z",
    message: "owner",
    level: "info"
  )
end
isolated = context_events(isolation_client).to_h { |event| [event.fetch("id"), event] }
context_assert(!isolated.fetch("isolated_thread").fetch("attributes").key?("context"), "ambient context leaked across threads")
context_assert(event_context(isolated.fetch("owning_thread")).dig("session", "id") == "session_ambient", "owning thread lost ambient context")
fiber_client = context_client
fiber_a = Fiber.new do
  LogBrew::Telemetry.with_context(
    LogBrew::TelemetryContext.create.with_session(id: "session_fiber_a").build
  ) do
    Fiber.yield
    fiber_client.log("fiber_a", "2026-08-03T10:00:04Z", message: "fiber a", level: "info")
  end
end
fiber_b = Fiber.new do
  LogBrew::Telemetry.with_context(
    LogBrew::TelemetryContext.create.with_session(id: "session_fiber_b").build
  ) do
    Fiber.yield
    fiber_client.log("fiber_b", "2026-08-03T10:00:04Z", message: "fiber b", level: "info")
  end
end
fiber_a.resume
fiber_b.resume
fiber_b.resume
fiber_a.resume
fiber_events = context_events(fiber_client).to_h { |event| [event.fetch("id"), event] }
context_assert(event_context(fiber_events.fetch("fiber_a")).dig("session", "id") == "session_fiber_a", "fiber A context changed")
context_assert(event_context(fiber_events.fetch("fiber_b")).dig("session", "id") == "session_fiber_b", "fiber B context changed")
tests += 1

privacy_marker = "private-runtime-marker-#{Process.pid}"
ENV["LOGBREW_RUBY_RUNTIME_PRIVATE_MARKER"] = privacy_marker
runtime_client = context_client(capture_runtime_context: true)
runtime_client.log("runtime_default", "2026-08-03T10:00:05Z", message: "runtime", level: "info")
runtime_event = context_events(runtime_client).fetch(0)
runtime_context = event_context(runtime_event)
runtime_name = defined?(RUBY_ENGINE) ? RUBY_ENGINE : "ruby"
context_assert(runtime_context.dig("resource", "runtime", "name") == runtime_name, "expected Ruby runtime name")
context_assert(runtime_context.dig("resource", "runtime", "version") == RUBY_VERSION, "expected Ruby runtime version")
context_assert(!runtime_context.dig("resource", "operatingSystem", "name").to_s.empty?, "expected OS family")
context_assert(!runtime_context.dig("resource", "device", "architecture").to_s.empty?, "expected architecture")
runtime_resource = runtime_context.fetch("resource")
context_assert(runtime_resource.keys.sort == %w[device operatingSystem runtime], "runtime context captured an unexpected resource section")
context_assert(runtime_resource.fetch("runtime").keys.sort == %w[name version], "runtime context captured unexpected runtime identity")
context_assert((runtime_resource.fetch("operatingSystem").keys - %w[name version]).empty?, "runtime context captured unexpected OS identity")
context_assert(runtime_resource.fetch("device").keys == ["architecture"], "runtime context captured unexpected device identity")
serialized_runtime = JSON.generate(runtime_context)
context_assert(!serialized_runtime.include?(privacy_marker), "runtime context leaked environment data")
opt_out_client = context_client(capture_runtime_context: false)
opt_out_client.log("runtime_opt_out", "2026-08-03T10:00:06Z", message: "opted out", level: "info")
context_assert(!context_events(opt_out_client).fetch(0).fetch("attributes").key?("context"), "runtime context opt-out was ignored")
explicit_runtime = LogBrew::TelemetryContext.create
  .with_resource(LogBrew::TelemetryResource.create.with_runtime(name: "custom-ruby", version: "9.9.9").build)
  .build
override_client = context_client(context: explicit_runtime, capture_runtime_context: true)
override_client.log("runtime_override", "2026-08-03T10:00:07Z", message: "override", level: "info")
override_runtime = event_context(context_events(override_client).fetch(0)).dig("resource", "runtime")
context_assert(override_runtime == { "name" => "custom-ruby", "version" => "9.9.9" }, "explicit runtime did not win")
ENV.delete("LOGBREW_RUBY_RUNTIME_PRIVATE_MARKER")
tests += 1

expect_context_error("telemetry context must include") do
  LogBrew::TelemetryContext.from_hash(schemaVersion: 1)
end
expect_context_error("schemaVersion must be 1") do
  LogBrew::TelemetryContext.from_hash(schemaVersion: 2, tags: { journey: "checkout" })
end
expect_context_error("unknown field") do
  LogBrew::TelemetryContext.from_hash(schemaVersion: 1, extra: { value: "no" })
end
expect_context_error("telemetry resource must not be empty") do
  LogBrew::TelemetryResource.from_hash({})
end
expect_context_error("runtime name is required") do
  LogBrew::TelemetryResource.from_hash(runtime: { version: "3.3.0" })
end
expect_context_error("traceId must be 32 non-zero hex characters") do
  LogBrew::TelemetryContext.create.with_trace_ids(trace_id: "0" * 32).build
end
expect_context_error("session previousId must differ from id") do
  LogBrew::TelemetryContext.create.with_session(id: "same", previous_id: "same").build
end
expect_context_error("subject kind must be anonymous or user") do
  LogBrew::TelemetryContext.create.with_subject(id: "subject", kind: "email").build
end
expect_context_error("tag key") do
  LogBrew::TelemetryContext.create.with_tag("bad key", "value").build
end
expect_context_error("tag key") do
  LogBrew::TelemetryContext.create.with_tag(" padded", "value").build
end
expect_context_error("at most 32 tags") do
  LogBrew::TelemetryContext.create.with_tags((0...33).to_h { |index| ["tag#{index}", "value"] }).build
end
expect_context_error("must not contain control characters") do
  LogBrew::TelemetryResource.create.with_service(name: "bad\nservice").build
end
expect_context_error("must contain at most 256 characters") do
  LogBrew::TelemetryResource.create.with_service(name: "x" * 257).build
end
expect_context_error("must be valid UTF-8") do
  LogBrew::TelemetryResource.create.with_service(name: "bad\xFF".dup.force_encoding(Encoding::UTF_8)).build
end
expect_context_error("client context must be a LogBrew::TelemetryContext") do
  context_client(context: { schemaVersion: 1, tags: { journey: "checkout" } })
end
expect_context_error("capture_runtime_context must be a boolean") do
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0",
    capture_runtime_context: "yes"
  )
end
expect_context_error("event context must be a LogBrew::TelemetryContext") do
  context_client.log(
    "invalid_event_context",
    "2026-08-03T10:00:08Z",
    message: "invalid",
    level: "info",
    context: { schemaVersion: 1, tags: { journey: "checkout" } }
  )
end
tests += 1

issue_context = LogBrew::TelemetryContext.create
  .with_session(id: "session_issue")
  .with_tag("journey", "recovery")
  .build
issue_attributes = LogBrew::IssueDiagnostics.from_exception(
  RuntimeError.new("private issue text"),
  title: "Checkout failed",
  context: issue_context,
  include_stack_frames: false
)
context_assert(issue_attributes.fetch("context").equal?(issue_context), "issue helper did not preserve typed context")
issue_client = context_client
issue_client.issue("issue_context", "2026-08-03T10:00:09Z", issue_attributes)
captured_issue_context = event_context(context_events(issue_client).fetch(0))
context_assert(captured_issue_context.dig("session", "id") == "session_issue", "issue helper session context was lost")
context_assert(captured_issue_context.dig("tags", "journey") == "recovery", "issue helper tags were lost")
tests += 1

Dir.mktmpdir("logbrew-ruby-context") do |root|
  File.chmod(0o700, root)
  queue_path = File.join(root, "queue")
  reader, writer = IO.pipe
  pid = Process.fork do
    reader.close
    persisted_context = LogBrew::TelemetryContext.create
      .with_session(id: "session_persisted")
      .with_tag("journey", "recovery")
      .build
    persisted_client = context_client(
      context: persisted_context,
      capture_runtime_context: false,
      persistent_queue_path: queue_path
    )
    persisted_client.log(
      "persisted_context",
      "2026-08-03T10:00:10Z",
      message: "persisted",
      level: "info"
    )
    writer.write(persisted_client.preview_json)
    writer.close
    exit! 0
  end
  writer.close
  before_restart = reader.read
  reader.close
  _waited_pid, status = Process.wait2(pid)
  context_assert(status.success?, "context persistence child failed")

  reopened = context_client(capture_runtime_context: false, persistent_queue_path: queue_path)
  context_assert(reopened.preview_json == before_restart, "restart rewrote admitted telemetry context")
  recovered = event_context(context_events(reopened).fetch(0))
  context_assert(recovered.dig("session", "id") == "session_persisted", "restart lost session context")
  context_assert(recovered.dig("tags", "journey") == "recovery", "restart lost tag context")
  context_assert(!recovered.dig("resource").to_h.key?("runtime"), "restart added runtime context to admitted event")
  reopened.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

puts "ruby telemetry context tests passed (#{tests} groups)"
