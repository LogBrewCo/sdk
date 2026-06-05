# frozen_string_literal: true

require "json"

begin
  require "logbrew"
rescue LoadError
  require_relative "../lib/logbrew"
end
require_relative "readme_example"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby",
  sdk_version: "0.1.0"
)
enqueue_all(client)

puts client.preview_json
response = client.shutdown(LogBrew::RecordingTransport.always_accept)

retry_client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby",
  sdk_version: "0.1.0"
)
enqueue_all(retry_client)
retry_response = retry_client.flush(
  LogBrew::RecordingTransport.new([LogBrew::TransportError.network("temporary outage"), 202])
)

rejected_after_shutdown = false
begin
  client.action("evt_action_002", "2026-06-02T10:00:06Z", name: "deploy", status: "success")
rescue LogBrew::SdkError => error
  rejected_after_shutdown = error.code == "shutdown_error"
end

$stderr.puts JSON.generate(
  ok: rejected_after_shutdown,
  status: response.status_code,
  attempts: response.attempts,
  retryAttempts: retry_response.attempts,
  events: 6
)
