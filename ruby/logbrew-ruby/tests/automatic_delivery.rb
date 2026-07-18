# frozen_string_literal: true

require "digest"
require "json"
require "tmpdir"
require_relative "../lib/logbrew"

def assert_automatic(condition, message)
  raise message unless condition
end

def wait_for_automatic(message, timeout: 3)
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
  until yield
    raise message if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

    sleep(0.005)
  end
end

def automatic_ids(body)
  JSON.parse(body).fetch("events").map { |event| event.fetch("id") }
end

def automatic_log(client, id, message = "automatic event")
  client.log(id, "2026-07-18T10:00:00Z", message: message, level: "info")
end

def automatic_client(transport:, **options)
  LogBrew::Client.create_automatic(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby-automatic",
    sdk_version: "0.1.0",
    transport: transport,
    max_retries: 0,
    flush_interval: 0.05,
    flush_threshold: 2,
    retry_base_delay: 0.02,
    retry_max_delay: 0.02,
    **options
  )
end

class AutomaticScriptedTransport
  attr_reader :sent_bodies

  def initialize(statuses = [202], &before_response)
    @statuses = statuses.dup
    @before_response = before_response
    @sent_bodies = []
    @mutex = Mutex.new
  end

  def send(_api_key, body)
    index = nil
    status = @mutex.synchronize do
      @sent_bodies << body
      index = @sent_bodies.length - 1
      @statuses.empty? ? 202 : @statuses.shift
    end
    @before_response&.call(index, body)
    raise status if status.is_a?(LogBrew::TransportError)

    LogBrew::TransportResponse.new(status, 1)
  end
end

class AutomaticBlockingTransport
  attr_reader :sent_bodies

  def initialize(status: 202, block_requests: 1)
    @status = status
    @remaining_blocks = block_requests
    @entered = Queue.new
    @release = Queue.new
    @sent_bodies = []
    @mutex = Mutex.new
  end

  def send(_api_key, body)
    should_block = @mutex.synchronize do
      @sent_bodies << body
      next false unless @remaining_blocks.positive?

      @remaining_blocks -= 1
      true
    end
    if should_block
      @entered << true
      @release.pop
    end
    LogBrew::TransportResponse.new(@status, 1)
  end

  def wait_until_entered
    @entered.pop
  end

  def release
    @release << true
  end
end

automatic_tests = 0

manual = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby-manual",
  sdk_version: "0.1.0"
)
manual_health = manual.delivery_health
assert_automatic(manual_health.state == "manual", "manual clients must keep manual delivery")
assert_automatic(manual_health.to_h.fetch("state") == "manual", "manual health must be JSON serializable")
transport = AutomaticScriptedTransport.new
lazy_client = automatic_client(transport: transport, flush_interval: 60)
assert_automatic(lazy_client.delivery_health.state == "idle", "automatic clients must start without a worker")
assert_automatic(
  Thread.list.none? { |thread| thread.name == "logbrew-delivery" },
  "automatic delivery must create its worker lazily"
)
lazy_client.stop_automatic_delivery
automatic_tests += 1

thread_singleton = Thread.singleton_class
original_thread_new = Thread.method(:new)
thread_singleton.send(:define_method, :new) do |*_arguments, &_block|
  raise ThreadError, "private scheduler allocation detail"
end
begin
  transport = AutomaticScriptedTransport.new
  unavailable_worker_client = automatic_client(transport: transport, flush_interval: 60)
  automatic_log(unavailable_worker_client, "evt_worker_unavailable")
  unavailable_health = unavailable_worker_client.delivery_health
  assert_automatic(unavailable_worker_client.pending_events == 1, "scheduler failure must retain queued work")
  assert_automatic(transport.sent_bodies.empty?, "scheduler failure must not create another delivery path")
  assert_automatic(unavailable_health.state == "stopped", "scheduler failure must stop automatic delivery")
  assert_automatic(unavailable_health.last_outcome == "terminal_failure", "scheduler failure outcome changed")
  assert_automatic(unavailable_health.pause_reason == "nonretryable", "scheduler failure reason changed")
  assert_automatic(
    !JSON.generate(unavailable_health.to_h).include?("private scheduler allocation detail"),
    "scheduler failure leaked exception text"
  )
ensure
  thread_singleton.send(:define_method, :new, original_thread_new)
end
unavailable_worker_client.stop_automatic_delivery
automatic_tests += 1

empty_shutdown_client = automatic_client(transport: AutomaticScriptedTransport.new, flush_interval: 60)
empty_shutdown_response = empty_shutdown_client.shutdown
empty_shutdown_health = empty_shutdown_client.delivery_health
assert_automatic(empty_shutdown_response.status_code == 204, "empty shutdown response changed")
assert_automatic(empty_shutdown_health.state == "closed", "empty shutdown must close delivery")
assert_automatic(empty_shutdown_health.last_outcome == "empty", "empty shutdown must not report accepted work")
assert_automatic(empty_shutdown_health.successful_flushes.zero?, "empty shutdown must not count a successful batch")
automatic_tests += 1

transport = AutomaticScriptedTransport.new
threshold_client = automatic_client(transport: transport, flush_interval: 60)
automatic_log(threshold_client, "evt_threshold_1")
sleep(0.02)
assert_automatic(transport.sent_bodies.empty?, "a partial queue must wait for its interval")
automatic_log(threshold_client, "evt_threshold_2")
wait_for_automatic("threshold delivery did not run") { transport.sent_bodies.length == 1 }
assert_automatic(
  automatic_ids(transport.sent_bodies.fetch(0)) == %w[evt_threshold_1 evt_threshold_2],
  "threshold delivery must preserve queue order"
)
threshold_client.shutdown
automatic_tests += 1

transport = AutomaticScriptedTransport.new
interval_client = automatic_client(transport: transport, flush_interval: 0.03, flush_threshold: 10)
started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
automatic_log(interval_client, "evt_interval")
wait_for_automatic("interval delivery did not run") { transport.sent_bodies.length == 1 }
elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started_at
assert_automatic(elapsed >= 0.02, "interval delivery must not hot-loop")
assert_automatic(automatic_ids(transport.sent_bodies.fetch(0)) == ["evt_interval"], "interval delivery lost work")
interval_client.shutdown
automatic_tests += 1

first_attempt = Queue.new
transport = AutomaticScriptedTransport.new([503, 202, 202]) do |index, _body|
  first_attempt << true if index.zero?
end
retry_client = automatic_client(transport: transport, flush_threshold: 1)
automatic_log(retry_client, "evt_retry_original", "private original")
first_attempt.pop
automatic_log(retry_client, "evt_retry_later", "private later")
wait_for_automatic("retry delivery did not drain") { transport.sent_bodies.length == 3 }
assert_automatic(transport.sent_bodies[0] == transport.sent_bodies[1], "retry body must be byte-identical")
assert_automatic(
  transport.sent_bodies.map { |body| automatic_ids(body) } == [
    ["evt_retry_original"],
    ["evt_retry_original"],
    ["evt_retry_later"]
  ],
  "later capture must remain behind the failed prefix"
)
assert_automatic(retry_client.delivery_health.last_outcome == "accepted", "retry success must update health")
retry_client.shutdown
automatic_tests += 1

attempt_times = []
transport = AutomaticScriptedTransport.new([503, 202, 202]) do |_index, _body|
  attempt_times << Process.clock_gettime(Process::CLOCK_MONOTONIC)
end
backoff_client = automatic_client(
  transport: transport,
  flush_interval: 0.005,
  flush_threshold: 1,
  retry_base_delay: 0.1,
  retry_max_delay: 0.1
)
automatic_log(backoff_client, "evt_backoff_original")
wait_for_automatic("backoff failure did not run") { transport.sent_bodies.length == 1 }
automatic_log(backoff_client, "evt_backoff_later")
sleep(0.03)
assert_automatic(transport.sent_bodies.length == 1, "later capture must not bypass retry backoff")
wait_for_automatic("bounded backoff retry did not drain") { transport.sent_bodies.length == 3 }
assert_automatic(attempt_times[1] - attempt_times[0] >= 0.045, "equal-jitter retry ran before its safety floor")
assert_automatic(backoff_client.delivery_health.retry_delay_ms.zero?, "accepted retry must clear health delay")
backoff_client.shutdown
automatic_tests += 1

terminal_entered = Queue.new
terminal_release = Queue.new
transport = AutomaticScriptedTransport.new([401, 202, 202]) do |index, _body|
  next unless index.zero?

  terminal_entered << true
  terminal_release.pop
end
stale_terminal_client = automatic_client(transport: transport, flush_threshold: 2, flush_interval: 60)
automatic_log(stale_terminal_client, "evt_terminal_inflight")
automatic_log(stale_terminal_client, "evt_terminal_inflight_2")
terminal_entered.pop
automatic_log(stale_terminal_client, "evt_terminal_during_io")
terminal_release << true
wait_for_automatic("in-flight terminal response did not pause") do
  stale_terminal_client.delivery_health.state == "paused"
end
assert_automatic(transport.sent_bodies.length == 1, "stale wake must not bypass a terminal pause")
stale_terminal_client.recover_automatic_delivery
sleep(0.03)
assert_automatic(stale_terminal_client.delivery_health.last_outcome == "accepted", "stale wake overwrote recovery health")
assert_automatic(stale_terminal_client.pending_events.zero?, "explicit recovery did not drain later capture")
recovery_request_count = transport.sent_bodies.length
automatic_log(stale_terminal_client, "evt_terminal_after_recovery_1")
sleep(0.03)
assert_automatic(
  transport.sent_bodies.length == recovery_request_count,
  "successful recovery must clear the stale in-flight wake"
)
automatic_log(stale_terminal_client, "evt_terminal_after_recovery_2")
wait_for_automatic("threshold delivery after terminal recovery did not run") do
  transport.sent_bodies.length == recovery_request_count + 1
end
assert_automatic(
  automatic_ids(transport.sent_bodies.last) == %w[
    evt_terminal_after_recovery_1 evt_terminal_after_recovery_2
  ],
  "post-recovery threshold delivery must preserve order"
)
stale_terminal_client.shutdown
automatic_tests += 1

transport = AutomaticBlockingTransport.new
coalesced_client = automatic_client(transport: transport, flush_threshold: 1, flush_interval: 60)
automatic_log(coalesced_client, "evt_inflight")
transport.wait_until_entered
automatic_log(coalesced_client, "evt_later_1")
automatic_log(coalesced_client, "evt_later_2")
transport.release
wait_for_automatic("coalesced delivery did not drain") { transport.sent_bodies.length == 2 }
assert_automatic(
  transport.sent_bodies.map { |body| automatic_ids(body) } == [
    ["evt_inflight"],
    %w[evt_later_1 evt_later_2]
  ],
  "duplicate wakeups must coalesce without clearing later work"
)
coalesced_client.shutdown
automatic_tests += 1

{
  401 => "authentication",
  429 => "quota",
  400 => "validation"
}.each do |status, reason|
  transport = AutomaticScriptedTransport.new([status, 202, 202])
  client = automatic_client(transport: transport, flush_threshold: 1)
  automatic_log(client, "evt_terminal_#{status}")
  wait_for_automatic("terminal response did not pause") { client.delivery_health.state == "paused" }
  automatic_log(client, "evt_terminal_later_#{status}")
  sleep(0.05)
  assert_automatic(transport.sent_bodies.length == 1, "paused delivery must not send newer work")
  assert_automatic(client.delivery_health.pause_reason == reason, "terminal pause reason changed")
  client.recover_automatic_delivery
  assert_automatic(client.delivery_health.state == "idle", "explicit recovery must resume automatic delivery")
  automatic_log(client, "evt_terminal_recovered_#{status}")
  wait_for_automatic("recovered automatic delivery did not run") { transport.sent_bodies.length == 4 }
  client.shutdown
end
automatic_tests += 1

transport = AutomaticBlockingTransport.new
serialized_client = automatic_client(transport: transport, flush_threshold: 1, flush_interval: 60)
automatic_log(serialized_client, "evt_serialized")
transport.wait_until_entered
manual_transport = AutomaticScriptedTransport.new
manual_result = Queue.new
manual_thread = Thread.new do
  manual_result << serialized_client.flush(manual_transport)
end
sleep(0.02)
assert_automatic(manual_thread.alive?, "manual flush must serialize behind automatic delivery")
transport.release
manual_thread.join
assert_automatic(manual_result.pop.status_code == 204, "serialized manual flush must observe the accepted prefix")
assert_automatic(manual_transport.sent_bodies.empty?, "serialized manual flush must not duplicate accepted work")
serialized_client.shutdown
automatic_tests += 1

owned_transport = AutomaticScriptedTransport.new
stale_manual_client = automatic_client(
  transport: owned_transport,
  flush_threshold: 100,
  flush_interval: 60
)
automatic_log(stale_manual_client, "evt_manual_before_stop")
manual_race_transport = AutomaticBlockingTransport.new
manual_race_result = Queue.new
manual_race_thread = Thread.new do
  manual_race_result << stale_manual_client.flush(manual_race_transport)
end
manual_race_transport.wait_until_entered
stale_manual_client.stop_automatic_delivery
assert_automatic(stale_manual_client.delivery_health.state == "stopped", "explicit stop did not stop delivery")
manual_race_transport.release
manual_race_thread.join
assert_automatic(manual_race_result.pop.status_code == 202, "in-flight manual flush response changed")
assert_automatic(
  stale_manual_client.delivery_health.state == "stopped",
  "stale manual completion must not overwrite explicit stop"
)
assert_automatic(owned_transport.sent_bodies.empty?, "explicit stop must not create a replacement send")
automatic_tests += 1

transport = AutomaticBlockingTransport.new
shutdown_client = automatic_client(transport: transport, flush_threshold: 1, flush_interval: 60)
automatic_log(shutdown_client, "evt_shutdown")
transport.wait_until_entered
shutdown_result = Queue.new
shutdown_thread = Thread.new do
  begin
    shutdown_result << shutdown_client.shutdown
  rescue StandardError => error
    shutdown_result << error
  end
end
sleep(0.02)
assert_automatic(shutdown_thread.alive?, "shutdown must wait for the in-flight automatic flush")
begin
  shutdown_client.shutdown
  raise "overlapping shutdown must fail"
rescue LogBrew::SdkError => error
  assert_automatic(error.code == "shutdown_error", "overlapping shutdown classification changed")
end
transport.release
shutdown_thread.join
assert_automatic(shutdown_result.pop.is_a?(LogBrew::TransportResponse), "shutdown must preserve the response")
assert_automatic(shutdown_client.delivery_health.state == "closed", "shutdown must close health")
begin
  automatic_log(shutdown_client, "evt_after_shutdown")
  raise "post-shutdown capture must fail"
rescue LogBrew::SdkError => error
  assert_automatic(error.code == "shutdown_error", "post-shutdown capture classification changed")
end
assert_automatic(
  Thread.list.none? { |thread| thread.name == "logbrew-delivery" && thread.alive? },
  "shutdown must terminate the automatic worker"
)
automatic_tests += 1

transport = AutomaticScriptedTransport.new([500, 202])
failed_shutdown_client = automatic_client(transport: transport, flush_interval: 0.02, flush_threshold: 100)
automatic_log(failed_shutdown_client, "evt_failed_shutdown")
begin
  failed_shutdown_client.shutdown
  raise "failed shutdown must raise"
rescue LogBrew::SdkError => error
  assert_automatic(error.code == "transport_error", "failed shutdown must preserve transport classification")
end
wait_for_automatic("failed shutdown did not recover automatic delivery") do
  transport.sent_bodies.length == 2 && failed_shutdown_client.pending_events.zero?
end
assert_automatic(transport.sent_bodies[0] == transport.sent_bodies[1], "failed shutdown retry bytes changed")
failed_shutdown_client.shutdown
automatic_tests += 1

transport = AutomaticScriptedTransport.new([401, 202])
terminal_shutdown_client = automatic_client(transport: transport, flush_interval: 0.01, flush_threshold: 100)
automatic_log(terminal_shutdown_client, "evt_terminal_shutdown")
begin
  terminal_shutdown_client.shutdown
  raise "terminal shutdown must raise"
rescue LogBrew::SdkError => error
  assert_automatic(error.code == "unauthenticated", "terminal shutdown classification changed")
end
terminal_shutdown_health = terminal_shutdown_client.delivery_health
assert_automatic(terminal_shutdown_health.state == "paused", "terminal shutdown must reopen paused")
assert_automatic(terminal_shutdown_health.pause_reason == "authentication", "terminal shutdown pause reason changed")
sleep(0.03)
assert_automatic(transport.sent_bodies.length == 1, "terminal shutdown must not schedule an automatic retry")
terminal_shutdown_client.recover_automatic_delivery
terminal_shutdown_client.shutdown
automatic_tests += 1

if Process.respond_to?(:fork)
  transport = AutomaticScriptedTransport.new
  fork_client = automatic_client(transport: transport, flush_interval: 60, flush_threshold: 2)
  reader, writer = IO.pipe
  child_pid = fork do
    reader.close
    codes = []
    [
      -> { automatic_log(fork_client, "evt_inherited_child") },
      -> { fork_client.flush },
      -> { fork_client.stop_automatic_delivery },
      -> { fork_client.purge_pending_events },
      -> { fork_client.shutdown }
    ].each do |operation|
      begin
        operation.call
        codes << "missing_error"
      rescue LogBrew::SdkError => error
        codes << error.code
      end
    end
    writer.write(JSON.generate(codes))
    writer.close
    exit! 0
  end
  writer.close
  child_codes = JSON.parse(reader.read)
  reader.close
  _, child_status = Process.wait2(child_pid)
  assert_automatic(child_status.success?, "fork ownership child failed")
  assert_automatic(
    child_codes == %w[
      process_ownership_error process_ownership_error process_ownership_error
      process_ownership_error process_ownership_error
    ],
    "inherited automatic clients must fail closed in the child"
  )
  automatic_log(fork_client, "evt_parent_1")
  automatic_log(fork_client, "evt_parent_2")
  wait_for_automatic("parent automatic owner stopped after fork") { transport.sent_bodies.length == 1 }
  assert_automatic(
    automatic_ids(transport.sent_bodies.fetch(0)) == %w[evt_parent_1 evt_parent_2],
    "parent owner must remain deterministic after fork"
  )
  fork_client.shutdown
  automatic_tests += 1
end

if Process.respond_to?(:fork)
  Dir.mktmpdir("logbrew-ruby-automatic-") do |directory|
    queue_path = File.join(directory, "queue")
    reader, writer = IO.pipe
    seed_pid = fork do
      reader.close
      client = automatic_client(
        transport: AutomaticScriptedTransport.new,
        persistent_queue_path: queue_path,
        flush_interval: 60,
        flush_threshold: 100
      )
      automatic_log(client, "evt_persisted_1")
      automatic_log(client, "evt_persisted_2")
      writer.write(Digest::SHA256.hexdigest(client.preview_json))
      writer.close
      exit! 0
    end
    writer.close
    preview_digest = reader.read
    reader.close
    _, seed_status = Process.wait2(seed_pid)
    assert_automatic(seed_status.success?, "persistent seed process failed")

    transport = AutomaticScriptedTransport.new
    recovered = automatic_client(
      transport: transport,
      persistent_queue_path: queue_path,
      flush_interval: 60,
      flush_threshold: 100
    )
    assert_automatic(recovered.delivery_health.queued_events == 2, "health must include hydrated queue work")
    wait_for_automatic("hydrated queue was not delivered automatically") { transport.sent_bodies.length == 1 }
    assert_automatic(
      Digest::SHA256.hexdigest(JSON.pretty_generate(JSON.parse(transport.sent_bodies.fetch(0)))) == preview_digest,
      "persistent recovery bytes must match the pre-exit preview"
    )
    assert_automatic(automatic_ids(transport.sent_bodies.fetch(0)) == %w[evt_persisted_1 evt_persisted_2], "restart order changed")
    recovered.shutdown
  end
  automatic_tests += 1
end

transport = AutomaticScriptedTransport.new([401])
privacy_client = automatic_client(transport: transport, flush_threshold: 1)
automatic_log(privacy_client, "evt_health_sentinel_7f3c", "health-payload-sentinel-7f3c")
wait_for_automatic("privacy client did not pause") { privacy_client.delivery_health.state == "paused" }
health = privacy_client.delivery_health
health_json = JSON.generate(health.to_h)
assert_automatic(health.frozen?, "health snapshot must be immutable")
assert_automatic(
  health.to_h.keys.sort == %w[
    consecutive_failures dropped_events failed_flushes in_flight last_outcome
    pause_reason queued_bytes queued_events retry_delay_ms state successful_flushes
  ],
  "health schema must stay fixed"
)
%w[LOGBREW_API_KEY evt_health_sentinel_7f3c health-payload-sentinel-7f3c].each do |unsafe|
  assert_automatic(!health_json.downcase.include?(unsafe.downcase), "health leaked #{unsafe}")
end
privacy_client.stop_automatic_delivery
automatic_tests += 1

puts "ruby automatic delivery tests ok (#{automatic_tests} tests)"
