# frozen_string_literal: true

require "json"
require "logbrew"

queue_path = ENV.fetch("LOGBREW_PERSISTENT_QUEUE_PATH")
dropped = 0
last_drop_reason = nil
loaded_spec = Gem.loaded_specs["logbrew-sdk"]
client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby-persistent-worker",
  sdk_version: loaded_spec ? loaded_spec.version.to_s : "0.1.0",
  persistent_queue_path: queue_path,
  on_event_dropped: lambda do |notice|
    dropped = notice.dropped_events
    last_drop_reason = notice.reason
  end
)

client.release("evt_worker_release", "2026-07-13T18:00:00Z", version: "2.0.0")
client.environment("evt_worker_environment", "2026-07-13T18:00:01Z", name: "production")
client.log("evt_worker_started", "2026-07-13T18:00:02Z", message: "worker started", level: "info")

response = client.shutdown(LogBrew::RecordingTransport.always_accept)
puts JSON.generate(
  ok: response.status_code == 202,
  status: response.status_code,
  attempts: response.attempts,
  batches: response.batches,
  dropped: dropped,
  lastDropReason: last_drop_reason
)
