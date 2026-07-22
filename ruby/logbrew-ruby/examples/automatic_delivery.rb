# frozen_string_literal: true

require "json"
require "logbrew"

transport = LogBrew::RecordingTransport.always_accept
client = LogBrew::Client.create_automatic(
  api_key: ENV.fetch("LOGBREW_API_KEY", "local-example-key"),
  sdk_name: "automatic-delivery-example",
  sdk_version: "1.0.0",
  transport: transport,
  flush_interval: 1,
  flush_threshold: 1
)

client.log(
  "evt_automatic_example",
  Time.now.utc.iso8601,
  message: "automatic delivery example",
  level: "info"
)

deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 2
sleep(0.01) until client.pending_events.zero? || Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
health = client.delivery_health.to_h
response = client.shutdown

puts JSON.generate(
  "ok" => response.status_code == 204 && health.fetch("last_outcome") == "accepted",
  "state" => client.delivery_health.state,
  "sentBodies" => transport.sent_bodies.length
)
