# frozen_string_literal: true

require "json"
require "open3"
require_relative "../lib/logbrew/sidekiq"

def assert_sidekiq(condition, message)
  raise message unless condition
end

def sidekiq_client
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby-sidekiq",
    sdk_version: "0.1.0"
  )
end

def sidekiq_events(client)
  JSON.parse(client.preview_json).fetch("events")
end

def sidekiq_parent
  LogBrew::Trace.create(
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
    trace_flags: "01"
  )
end

def sidekiq_job(overrides = {})
  {
    "class" => "InvoiceWorker",
    "args" => ["opaque-argument"],
    "jid" => "opaque-job-reference",
    "queue" => "mailers",
    "retry" => 2,
    "enqueued_at" => Time.now.to_f
  }.merge(overrides)
end

class SidekiqTestChain
  Entry = Struct.new(:klass, :arguments)

  attr_reader :entries

  def initialize
    @entries = []
  end

  def exists?(klass)
    @entries.any? { |entry| entry.klass == klass }
  end

  def add(klass, *arguments)
    @entries.reject! { |entry| entry.klass == klass }
    @entries << Entry.new(klass, arguments)
  end

  def remove(klass)
    before = @entries.length
    @entries.reject! { |entry| entry.klass == klass }
    before != @entries.length
  end

  def invoke(*arguments, &application)
    invocation = @entries.reverse_each.inject(application) do |next_invocation, entry|
      proc { entry.klass.new(*entry.arguments).call(*arguments, &next_invocation) }
    end
    invocation.call
  end
end

class SidekiqTestConfig
  attr_reader :client_chain, :server_chain

  def initialize
    @client_chain = SidekiqTestChain.new
    @server_chain = SidekiqTestChain.new
  end

  def client_middleware
    yield @client_chain
  end

  def server_middleware
    yield @server_chain
  end
end

class SidekiqCancellation < Interrupt; end

sidekiq_tests = 0

core_stdout, core_stderr, core_status = Open3.capture3(
  RbConfig.ruby,
  "-I",
  File.expand_path("../lib", __dir__),
  "-e",
  'require "logbrew/sidekiq"; abort "unexpected framework load" if defined?(::Sidekiq); print "ok"'
)
assert_sidekiq(core_status.success?, "optional integration failed without Sidekiq: #{core_stderr}")
assert_sidekiq(core_stdout == "ok", "optional integration subprocess output changed")
sidekiq_tests += 1

client = sidekiq_client
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client)
config = SidekiqTestConfig.new
assert_sidekiq(instrumentation.register_client(config), "first client registration must install")
assert_sidekiq(!instrumentation.register_client(config), "duplicate client registration must be idempotent")
assert_sidekiq(instrumentation.register_server(config), "first server registration must install")
assert_sidekiq(!instrumentation.register_server(config), "duplicate server registration must be idempotent")
assert_sidekiq(config.client_chain.entries.length == 1, "client middleware duplicated")
assert_sidekiq(config.server_chain.entries.length == 1, "server middleware duplicated")
other_instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: sidekiq_client)
assert_sidekiq(!other_instrumentation.register_client(config), "second owner replaced client middleware")
assert_sidekiq(!other_instrumentation.unregister_client(config), "non-owner removed client middleware")
assert_sidekiq(config.client_chain.entries.length == 1, "non-owner changed client middleware")
assert_sidekiq(instrumentation.unregister_client(config), "client removal did not report a change")
assert_sidekiq(!instrumentation.unregister_client(config), "client removal must be idempotent")
assert_sidekiq(instrumentation.unregister_server(config), "server removal did not report a change")
assert_sidekiq(!instrumentation.unregister_server(config), "server removal must be idempotent")
sidekiq_tests += 1

if Process.respond_to?(:fork)
  client = sidekiq_client
  child_errors = []
  instrumentation = LogBrew::Sidekiq::Instrumentation.create(
    client: client,
    on_capture_error: proc { |error| child_errors << error }
  )
  reader, writer = IO.pipe
  child_pid = fork do
    reader.close
    child_job = sidekiq_job
    child_result = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation).call(nil, child_job, nil, nil) { :child }
    writer.write(JSON.generate("result" => child_result.to_s, "carrier" => child_job.key?("logbrew"), "errors" => child_errors.length))
    writer.close
    exit! 0
  end
  writer.close
  child_payload = JSON.parse(reader.read)
  reader.close
  _waited_pid, child_status = Process.wait2(child_pid)
  assert_sidekiq(child_status.success?, "fork ownership child failed")
  assert_sidekiq(child_payload == { "result" => "child", "carrier" => false, "errors" => 1 }, "fork ownership changed")
  sidekiq_tests += 1
end

client = sidekiq_client
capture_errors = []
instrumentation = LogBrew::Sidekiq::Instrumentation.create(
  client: client,
  max_retries: 2,
  on_capture_error: proc { |error| capture_errors << error }
)
client_middleware = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation)
job = sidekiq_job
original_job = Marshal.load(Marshal.dump(job))
parent = sidekiq_parent
application_result = Object.new
observed_context = nil
result = LogBrew::Trace.with_context(parent) do
  client_middleware.call("InvoiceWorker", job, "mailers", nil) do
    observed_context = LogBrew::Trace.current
    application_result
  end
end
assert_sidekiq(result.equal?(application_result), "client middleware changed the app result")
assert_sidekiq(LogBrew::Trace.current.nil?, "client middleware leaked trace context")
assert_sidekiq(observed_context.trace_id == parent.trace_id, "enqueue trace did not continue the parent")
assert_sidekiq(observed_context.parent_span_id == parent.span_id, "enqueue parent span changed")
carrier = job.fetch("logbrew")
assert_sidekiq(carrier.keys.sort == %w[enqueuedAtMs traceparent version], "carrier keys are not bounded")
assert_sidekiq(carrier.fetch("version") == 1, "carrier version changed")
assert_sidekiq(carrier.fetch("traceparent") == LogBrew::Trace.create_headers(observed_context).fetch("traceparent"), "carrier traceparent mismatch")
assert_sidekiq(carrier.fetch("enqueuedAtMs").is_a?(Integer), "carrier enqueue time must be integral")
original_job.each { |key, value| assert_sidekiq(job.fetch(key) == value, "client middleware changed #{key}") }
events = sidekiq_events(client)
assert_sidekiq(events.length == 1 && events[0].fetch("type") == "span", "enqueue span count changed")
enqueue_attributes = events[0].fetch("attributes")
assert_sidekiq(enqueue_attributes.fetch("name") == "sidekiq.enqueue", "enqueue span name changed")
assert_sidekiq(enqueue_attributes.fetch("traceId") == parent.trace_id, "enqueue span trace changed")
assert_sidekiq(enqueue_attributes.fetch("parentSpanId") == parent.span_id, "enqueue span parent changed")
serialized = JSON.generate(events)
%w[opaque-argument opaque-job-reference InvoiceWorker mailers].each do |forbidden|
  assert_sidekiq(!serialized.include?(forbidden), "enqueue telemetry leaked job content")
end
assert_sidekiq(capture_errors.empty?, "successful enqueue reported capture failure")
sidekiq_tests += 1

retry_carrier = Marshal.load(Marshal.dump(job.fetch("logbrew")))
retry_result = client_middleware.call("InvoiceWorker", job, "mailers", nil) { :retried_enqueue }
assert_sidekiq(retry_result == :retried_enqueue, "retry enqueue changed the app result")
assert_sidekiq(job.fetch("logbrew") == retry_carrier, "retry enqueue changed the existing carrier")
assert_sidekiq(sidekiq_events(client).length == 1, "retry enqueue emitted a duplicate span")
sidekiq_tests += 1

server_middleware = LogBrew::Sidekiq::ServerMiddleware.new(instrumentation)
outer = LogBrew::Trace.create_root
worker_context = nil
worker_result = Object.new
result = LogBrew::Trace.with_context(outer) do
  server_middleware.call(Object.new, job, "mailers") do
    worker_context = LogBrew::Trace.current
    worker_result
  end
end
assert_sidekiq(result.equal?(worker_result), "server middleware changed the app result")
assert_sidekiq(LogBrew::Trace.current.nil?, "server middleware leaked trace context")
assert_sidekiq(worker_context.trace_id == observed_context.trace_id, "worker trace did not continue enqueue")
assert_sidekiq(worker_context.parent_span_id == observed_context.span_id, "worker parent span changed")
events = sidekiq_events(client)
assert_sidekiq(events.count { |event| event.fetch("type") == "span" } == 2, "worker span count changed")
worker_span = events.reverse.find { |event| event.fetch("type") == "span" }
worker_metadata = worker_span.fetch("attributes").fetch("metadata")
assert_sidekiq(worker_metadata.fetch("source") == "sidekiq.server", "worker source changed")
assert_sidekiq(worker_metadata.fetch("retryCount") == 0, "worker retry count changed")
assert_sidekiq(worker_metadata.fetch("queueWaitMs").between?(0, 604_800_000), "queue wait is unbounded")
sidekiq_tests += 1

client = sidekiq_client
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client)
malformed_job = sidekiq_job("logbrew" => { "version" => 1, "traceparent" => "invalid", "enqueuedAtMs" => -1 })
root_context = nil
ambient_context = LogBrew::Trace.create_root
result = LogBrew::Trace.with_context(ambient_context) do
  worker_result = LogBrew::Sidekiq::ServerMiddleware.new(instrumentation).call(Object.new, malformed_job, "mailers") do
    root_context = LogBrew::Trace.current
    :malformed_fallback
  end
  assert_sidekiq(LogBrew::Trace.current.equal?(ambient_context), "malformed carrier changed the caller trace")
  worker_result
end
assert_sidekiq(result == :malformed_fallback, "malformed carrier changed app result")
assert_sidekiq(root_context.parent_span_id.nil?, "malformed carrier did not fall back to a root")
assert_sidekiq(malformed_job.fetch("logbrew").fetch("traceparent") == "invalid", "server changed malformed carrier")
malformed_metadata = sidekiq_events(client).first.fetch("attributes").fetch("metadata")
assert_sidekiq(!malformed_metadata.key?("queueWaitMs"), "malformed carrier reported a queue wait")
sidekiq_tests += 1

client = sidekiq_client
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client)
mixed_key_carrier = {
  "version" => 1,
  "traceparent" => LogBrew::Trace.create_headers(sidekiq_parent).fetch("traceparent"),
  "enqueuedAtMs" => 0,
  unexpected: "opaque"
}
mixed_key_job = sidekiq_job("logbrew" => mixed_key_carrier)
mixed_context = nil
LogBrew::Sidekiq::ServerMiddleware.new(instrumentation).call(nil, mixed_key_job, nil) do
  mixed_context = LogBrew::Trace.current
  :mixed_key
end
assert_sidekiq(mixed_context && mixed_context.parent_span_id.nil?, "mixed-key carrier did not use a safe root")
assert_sidekiq(sidekiq_events(client).length == 1, "mixed-key carrier skipped the worker span")
assert_sidekiq(mixed_key_job.fetch("logbrew").equal?(mixed_key_carrier), "mixed-key carrier was replaced")
sidekiq_tests += 1

client = sidekiq_client
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client, max_retries: 2)
client_middleware = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation)
server_middleware = LogBrew::Sidekiq::ServerMiddleware.new(instrumentation)
retry_job = sidekiq_job
LogBrew::Trace.with_context(sidekiq_parent) { client_middleware.call(nil, retry_job, nil, nil) { true } }
retry_error = RuntimeError.new("opaque retry detail")
[nil, 0].each do |retry_count|
  retry_job["retry_count"] = retry_count
  raised = nil
  begin
    server_middleware.call(nil, retry_job, nil) { raise retry_error }
  rescue RuntimeError => error
    raised = error
  end
  assert_sidekiq(raised.equal?(retry_error), "retry exception identity changed")
end
assert_sidekiq(sidekiq_events(client).none? { |event| event.fetch("type") == "issue" }, "retryable failure emitted an issue")
retry_job["retry_count"] = 1
raised = nil
begin
  server_middleware.call(nil, retry_job, nil) { raise retry_error }
rescue RuntimeError => error
  raised = error
end
assert_sidekiq(raised.equal?(retry_error), "terminal exception identity changed")
issues = sidekiq_events(client).select { |event| event.fetch("type") == "issue" }
assert_sidekiq(issues.length == 1, "terminal failure issue count changed")
issue_attributes = issues[0].fetch("attributes")
assert_sidekiq(issue_attributes.fetch("title") == "Sidekiq job failed", "terminal issue title changed")
assert_sidekiq(issue_attributes.fetch("metadata").fetch("retryCount") == 2, "terminal retry context changed")
assert_sidekiq(!JSON.generate(issues).include?(retry_error.message), "terminal issue leaked exception text")
begin
  server_middleware.call(nil, retry_job, nil) { raise retry_error }
rescue RuntimeError
  nil
end
issues = sidekiq_events(client).select { |event| event.fetch("type") == "issue" }
assert_sidekiq(issues.length == 1, "terminal failure issue was not deduplicated")
sidekiq_tests += 1

client = sidekiq_client
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client)
client_middleware = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation)
server_middleware = LogBrew::Sidekiq::ServerMiddleware.new(instrumentation)
parents = [
  LogBrew::Trace.create(trace_id: "1" * 32, span_id: "2" * 16, trace_flags: "01"),
  LogBrew::Trace.create(trace_id: "3" * 32, span_id: "4" * 16, trace_flags: "01")
]
jobs = parents.map do |parent_context|
  sidekiq_job.tap do |concurrent_job|
    LogBrew::Trace.with_context(parent_context) do
      client_middleware.call(nil, concurrent_job, nil, nil) { true }
    end
  end
end
ready = Queue.new
releases = [Queue.new, Queue.new]
observations = Array.new(2)
threads = jobs.each_with_index.map do |concurrent_job, index|
  Thread.new do
    outer_context = LogBrew::Trace.create_root
    worker_result = LogBrew::Trace.with_context(outer_context) do
      result = server_middleware.call(nil, concurrent_job, nil) do
        observations[index] = LogBrew::Trace.current
        ready << index
        releases[index].pop
        index
      end
      assert_sidekiq(LogBrew::Trace.current.equal?(outer_context), "worker did not return its caller context")
      result
    end
    worker_result
  end
end
2.times { ready.pop }
releases[1] << true
releases[0] << true
assert_sidekiq(threads.map(&:value).sort == [0, 1], "concurrent worker result changed")
assert_sidekiq(LogBrew::Trace.current.nil?, "concurrent workers changed the caller context")
observations.each_with_index do |worker_trace, index|
  enqueue_trace = LogBrew::Traceparent.parse(jobs[index].fetch("logbrew").fetch("traceparent"))
  assert_sidekiq(worker_trace.trace_id == parents[index].trace_id, "concurrent worker trace crossed requests")
  assert_sidekiq(worker_trace.parent_span_id == enqueue_trace.parent_span_id, "concurrent worker parent crossed requests")
end
assert_sidekiq(observations.map(&:span_id).uniq.length == 2, "concurrent workers reused a child span")
sidekiq_tests += 1

client = sidekiq_client
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client)
client_middleware = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation)
job = sidekiq_job("retry" => false)
LogBrew::Trace.with_context(sidekiq_parent) { client_middleware.call(nil, job, nil, nil) { true } }
cancellation = SidekiqCancellation.new("opaque cancellation detail")
raised = nil
begin
  LogBrew::Sidekiq::ServerMiddleware.new(instrumentation).call(nil, job, nil) { raise cancellation }
rescue SidekiqCancellation => error
  raised = error
end
assert_sidekiq(raised.equal?(cancellation), "cancellation identity changed")
events = sidekiq_events(client)
assert_sidekiq(events.none? { |event| event.fetch("type") == "issue" }, "cancellation emitted a failure issue")
cancelled_span = events.reverse.find { |event| event.fetch("type") == "span" }
assert_sidekiq(cancelled_span.fetch("attributes").fetch("metadata").fetch("cancelled"), "cancellation was not classified")
sidekiq_tests += 1

client = sidekiq_client
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client)
client_middleware = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation)
instrumentation.disable
disabled_job = sidekiq_job
disabled_result = client_middleware.call(nil, disabled_job, nil, nil) { :disabled }
assert_sidekiq(disabled_result == :disabled, "disabled integration changed app result")
assert_sidekiq(!disabled_job.key?("logbrew"), "disabled integration changed the job")
assert_sidekiq(sidekiq_events(client).empty?, "disabled integration emitted telemetry")
instrumentation.enable
client_middleware.call(nil, sidekiq_job, nil, nil) { :enabled }
assert_sidekiq(sidekiq_events(client).length == 1, "re-enabled integration did not capture")
instrumentation.quiet
quiet_job = sidekiq_job
quiet_result = client_middleware.call(nil, quiet_job, nil, nil) { :quiet }
assert_sidekiq(quiet_result == :quiet && !quiet_job.key?("logbrew"), "quiet integration was not pass-through")
sidekiq_tests += 1

transport = LogBrew::RecordingTransport.always_accept
client = LogBrew::Client.create_automatic(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby-sidekiq",
  sdk_version: "0.1.0",
  transport: transport,
  flush_interval: 60,
  flush_threshold: 100
)
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client)
client.log("evt_sidekiq_shutdown", Time.now.utc.iso8601, message: "worker stopped", level: "info")
first_shutdown = instrumentation.shutdown
second_shutdown = instrumentation.shutdown
assert_sidekiq(first_shutdown.equal?(second_shutdown), "shutdown must be idempotent")
assert_sidekiq(first_shutdown.status_code == 202, "shutdown did not drain through the owned transport")
assert_sidekiq(client.pending_events.zero?, "shutdown left accepted work pending")
sidekiq_tests += 1

client = sidekiq_client
capture_errors = []
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client, on_capture_error: proc { |error| capture_errors << error })
instrumentation.instance_variable_set(:@owner_process_id, Process.pid + 1)
job = sidekiq_job
result = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation).call(nil, job, nil, nil) { :inherited }
assert_sidekiq(result == :inherited, "inherited middleware changed app behavior")
assert_sidekiq(!job.key?("logbrew"), "inherited middleware changed the job")
assert_sidekiq(sidekiq_events(client).empty?, "inherited middleware emitted telemetry")
assert_sidekiq(capture_errors.length == 1, "inherited middleware did not report one advisory failure")
begin
  instrumentation.shutdown
  raise "expected process ownership failure"
rescue LogBrew::SdkError => error
  assert_sidekiq(error.code == "process_ownership_error", "shutdown ownership code changed")
end
sidekiq_tests += 1

client = sidekiq_client
capture_errors = []
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client, on_capture_error: proc { |error| capture_errors << error })
trace_singleton = LogBrew::Trace.singleton_class
original_create_root = LogBrew::Trace.method(:create_root)
trace_singleton.send(:define_method, :create_root) { raise "opaque setup detail" }
begin
  calls = 0
  result = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation).call(nil, sidekiq_job, nil, nil) do
    calls += 1
    :advisory
  end
  assert_sidekiq(result == :advisory && calls == 1, "setup failure changed app execution")
ensure
  trace_singleton.send(:define_method, :create_root, original_create_root)
end
assert_sidekiq(capture_errors.length == 1, "setup failure callback count changed")
assert_sidekiq(sidekiq_events(client).empty?, "setup failure emitted partial telemetry")
sidekiq_tests += 1

puts "ruby sidekiq tests ok (#{sidekiq_tests} tests)"
