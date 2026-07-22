# frozen_string_literal: true

require "json"
require_relative "../lib/logbrew"

def assert_worker_lifecycle(condition, message)
  raise message unless condition
end

def expect_worker_lifecycle_error(code)
  yield
  raise "expected #{code}"
rescue LogBrew::SdkError => error
  assert_worker_lifecycle(error.code == code, "expected #{code}, got #{error.code}")
  error
end

def worker_lifecycle_client(max_retries: 0)
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby-worker",
    sdk_version: "0.1.0",
    max_retries: max_retries
  )
end

def worker_lifecycle_log(client, id, message = "worker event")
  client.log(id, "2026-07-13T14:00:00Z", message: message, level: "info")
end

def worker_lifecycle_ids(body)
  JSON.parse(body).fetch("events").map { |event| event.fetch("id") }
end

def worker_lifecycle_nonlocal_return(lifecycle, client)
  lifecycle.run do
    worker_lifecycle_log(client, "evt_worker_nonlocal_return")
    return :returned_from_application
  end
end

class DelayingStateMutex
  def initialize
    @mutex = Mutex.new
    @gate_mutex = Mutex.new
    @entered = Queue.new
    @release = Queue.new
    @delay_next = true
  end

  def synchronize
    delay = @gate_mutex.synchronize do
      next false unless @delay_next

      @delay_next = false
      true
    end
    if delay
      @entered << true
      @release.pop
    end
    @mutex.synchronize { yield }
  end

  def wait_until_delayed
    @entered.pop
  end

  def release
    @release << true
  end
end

tests = 0

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
result = lifecycle.run do
  worker_lifecycle_log(client, "evt_worker_success")
  { "status" => "complete" }
end
assert_worker_lifecycle(result == { "status" => "complete" }, "run must preserve the application result")
assert_worker_lifecycle(worker_lifecycle_ids(transport.last_body) == ["evt_worker_success"], "run must flush one work boundary")
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
application_error = RuntimeError.new("private application failure")
caught_error = nil
begin
  lifecycle.run do
    worker_lifecycle_log(client, "evt_worker_error")
    raise application_error
  end
rescue RuntimeError => error
  caught_error = error
end
assert_worker_lifecycle(caught_error.equal?(application_error), "run must re-raise the exact application error")
assert_worker_lifecycle(worker_lifecycle_ids(transport.last_body) == ["evt_worker_error"], "run must flush after application failure")
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.new([503, 202, 202])
notices = []
lifecycle = LogBrew::WorkerLifecycle.create(
  client: client,
  transport: transport,
  on_delivery_failure: lambda do |notice|
    notices << notice
    raise "private diagnostic callback failure"
  end
)
result = lifecycle.run do
  worker_lifecycle_log(client, "evt_worker_retry_original", "private original event")
  :first_result
end
assert_worker_lifecycle(result == :first_result, "delivery failure must not replace the application result")
assert_worker_lifecycle(client.pending_events == 1, "failed work delivery must retain telemetry")
assert_worker_lifecycle(notices.length == 1, "failed work delivery must report once")
notice = notices.fetch(0)
assert_worker_lifecycle(notice.frozen?, "delivery notice must be immutable")
assert_worker_lifecycle(notice.stage == "work_boundary", "notice must expose a stable stage")
assert_worker_lifecycle(notice.code == "transport_error", "notice must expose an allowlisted code")
assert_worker_lifecycle(notice.pending_events == 1, "notice must expose only retained count")
assert_worker_lifecycle(notice.pending_event_bytes.positive?, "notice must expose retained bytes")
assert_worker_lifecycle(notice.dropped_events.zero?, "notice must expose dropped count")
assert_worker_lifecycle(
  notice.instance_variables.sort == %i[@code @dropped_events @pending_event_bytes @pending_events @stage],
  "delivery notice must not retain exceptions, bodies, or transport state"
)

lifecycle.run do
  worker_lifecycle_log(client, "evt_worker_retry_later", "private later event")
  :second_result
end
assert_worker_lifecycle(transport.sent_bodies.length == 3, "later work must retry retained telemetry before new capture")
assert_worker_lifecycle(transport.sent_bodies[0] == transport.sent_bodies[1], "retained retry body must stay byte-identical")
assert_worker_lifecycle(
  transport.sent_bodies.map { |body| worker_lifecycle_ids(body) } == [
    ["evt_worker_retry_original"],
    ["evt_worker_retry_original"],
    ["evt_worker_retry_later"]
  ],
  "later work must preserve the failed batch boundary"
)
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
inner_ran = false
nested_error = nil
lifecycle.run do
  begin
    lifecycle.run { inner_ran = true }
  rescue LogBrew::SdkError => error
    nested_error = error
  end
  worker_lifecycle_log(client, "evt_worker_outer")
end
assert_worker_lifecycle(nested_error&.code == "worker_lifecycle_error", "nested run must fail with a stable code")
assert_worker_lifecycle(!inner_ran, "nested run must fail before inner application work")
assert_worker_lifecycle(worker_lifecycle_ids(transport.last_body) == ["evt_worker_outer"], "outer work must remain deliverable")
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
entered = Queue.new
release = Queue.new
first_thread = Thread.new do
  lifecycle.run do
    entered << true
    release.pop
    worker_lifecycle_log(client, "evt_worker_thread_one")
  end
end
entered.pop
second_ran = false
thread_error = expect_worker_lifecycle_error("worker_lifecycle_error") do
  lifecycle.run { second_ran = true }
end
release << true
first_thread.join
assert_worker_lifecycle(thread_error.message.include?("already in progress"), "competing work must explain the boundary")
assert_worker_lifecycle(!second_ran, "competing work must fail before its callback")
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
state_mutex = DelayingStateMutex.new
lifecycle.instance_variable_set(:@state_mutex, state_mutex)
late_callback_ran = false
late_result = Queue.new
late_thread = Thread.new do
  begin
    lifecycle.run { late_callback_ran = true }
    late_result << :returned
  rescue LogBrew::SdkError => error
    late_result << error
  end
end
state_mutex.wait_until_delayed
shutdown_response = lifecycle.shutdown
state_mutex.release
late_thread.join
late_error = late_result.pop
assert_worker_lifecycle(late_error.is_a?(LogBrew::SdkError), "a delayed run must reject after shutdown wins")
assert_worker_lifecycle(late_error.code == "shutdown_error", "a delayed run must observe terminal shutdown atomically")
assert_worker_lifecycle(!late_callback_ran, "a delayed run must not execute application work after shutdown")
assert_worker_lifecycle(lifecycle.shutdown.equal?(shutdown_response), "shutdown success must remain cached after the race")
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
return_result = worker_lifecycle_nonlocal_return(lifecycle, client)
assert_worker_lifecycle(return_result == :returned_from_application, "run must preserve a nonlocal return")
assert_worker_lifecycle(
  worker_lifecycle_ids(transport.last_body) == ["evt_worker_nonlocal_return"],
  "nonlocal return must still flush its work boundary"
)

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
break_result = lifecycle.run do
  worker_lifecycle_log(client, "evt_worker_nonlocal_break")
  break :broken_from_application
end
assert_worker_lifecycle(break_result == :broken_from_application, "run must preserve a nonlocal break")
assert_worker_lifecycle(
  worker_lifecycle_ids(transport.last_body) == ["evt_worker_nonlocal_break"],
  "nonlocal break must still flush its work boundary"
)

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
throw_result = catch(:worker_complete) do
  lifecycle.run do
    worker_lifecycle_log(client, "evt_worker_nonlocal_throw")
    throw :worker_complete, :thrown_from_application
  end
end
assert_worker_lifecycle(throw_result == :thrown_from_application, "run must preserve a nonlocal throw")
assert_worker_lifecycle(
  worker_lifecycle_ids(transport.last_body) == ["evt_worker_nonlocal_throw"],
  "nonlocal throw must still flush its work boundary"
)
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
lifecycle.instance_variable_set(:@owner_process_id, Process.pid + 1)
precheck_ran = false
expect_worker_lifecycle_error("process_ownership_error") do
  lifecycle.run { precheck_ran = true }
end
expect_worker_lifecycle_error("process_ownership_error") { lifecycle.shutdown }
assert_worker_lifecycle(!precheck_ran, "inherited lifecycle must reject before application work")
assert_worker_lifecycle(transport.sent_bodies.empty?, "inherited lifecycle must not touch its transport")
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
postcheck_error = expect_worker_lifecycle_error("process_ownership_error") do
  lifecycle.run do
    worker_lifecycle_log(client, "evt_worker_changed_process")
    lifecycle.instance_variable_set(:@owner_process_id, Process.pid + 1)
  end
end
assert_worker_lifecycle(postcheck_error.message.include?("current process"), "post-work ownership must use a stable safe message")
assert_worker_lifecycle(transport.sent_bodies.empty?, "post-work ownership failure must not flush copied state")
assert_worker_lifecycle(client.pending_events == 1, "post-work ownership failure must retain copied state untouched")
tests += 1

client = worker_lifecycle_client
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
application_error = RuntimeError.new("private app error wins")
caught_error = nil
begin
  lifecycle.run do
    lifecycle.instance_variable_set(:@owner_process_id, Process.pid + 1)
    raise application_error
  end
rescue RuntimeError => error
  caught_error = error
end
assert_worker_lifecycle(caught_error.equal?(application_error), "application error must win over post-work ownership failure")
assert_worker_lifecycle(transport.sent_bodies.empty?, "combined failure must not touch transport")
tests += 1

client = worker_lifecycle_client
worker_lifecycle_log(client, "evt_worker_shutdown")
transport = LogBrew::RecordingTransport.always_accept
lifecycle = LogBrew::WorkerLifecycle.create(client: client, transport: transport)
first_shutdown = lifecycle.shutdown
second_shutdown = lifecycle.shutdown
assert_worker_lifecycle(first_shutdown.equal?(second_shutdown), "successful shutdown must be terminal-idempotent")
assert_worker_lifecycle(transport.sent_bodies.length == 1, "repeated shutdown must not send twice")
after_shutdown_ran = false
expect_worker_lifecycle_error("shutdown_error") do
  lifecycle.run { after_shutdown_ran = true }
end
assert_worker_lifecycle(!after_shutdown_ran, "work after shutdown must fail before its callback")
tests += 1

client = worker_lifecycle_client
worker_lifecycle_log(client, "evt_worker_shutdown_retry")
transport = LogBrew::RecordingTransport.new([503, 202])
notices = []
lifecycle = LogBrew::WorkerLifecycle.create(
  client: client,
  transport: transport,
  on_delivery_failure: ->(notice) { notices << notice }
)
shutdown_error = expect_worker_lifecycle_error("transport_error") { lifecycle.shutdown }
assert_worker_lifecycle(shutdown_error.message.include?("unexpected transport status"), "shutdown must preserve delivery failure")
assert_worker_lifecycle(notices.map(&:stage) == ["shutdown"], "failed shutdown must report the shutdown stage")
retried_shutdown = lifecycle.shutdown
cached_shutdown = lifecycle.shutdown
assert_worker_lifecycle(retried_shutdown.equal?(cached_shutdown), "successful shutdown retry must be cached")
assert_worker_lifecycle(transport.sent_bodies[0] == transport.sent_bodies[1], "shutdown retry body must stay byte-identical")
tests += 1

unsafe_error = Class.new(StandardError).new("sentinel value must stay local")
client = worker_lifecycle_client
worker_lifecycle_log(client, "evt_worker_unknown_error")
transport = Class.new do
  define_method(:send) { |_api_key, _body| raise unsafe_error }
end.new
notices = []
lifecycle = LogBrew::WorkerLifecycle.create(
  client: client,
  transport: transport,
  on_delivery_failure: ->(notice) { notices << notice }
)
lifecycle.run { :safe_result }
assert_worker_lifecycle(notices.fetch(0).code == "delivery_error", "unknown delivery errors must use a generic code")
assert_worker_lifecycle(!notices.fetch(0).inspect.include?(unsafe_error.message), "notice inspection must omit exception content")
tests += 1

expect_worker_lifecycle_error("validation_error") do
  LogBrew::WorkerLifecycle.create(
    client: worker_lifecycle_client,
    transport: LogBrew::RecordingTransport.always_accept,
    on_delivery_failure: Object.new
  )
end
tests += 1

puts "ruby worker lifecycle tests ok (#{tests} tests)"
