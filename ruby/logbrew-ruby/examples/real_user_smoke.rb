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

support_draft = LogBrew::SupportTicketDraft.create(
  source: "sdk",
  category: "ingest_failure",
  title: "Telemetry flush failed",
  description: "Flush returned usage_limit_exceeded",
  trace_id: "4BF92F3577B34DA6A3CE929D0E0E4736",
  diagnostics: {
    apiKey: "lbw_ingest_hidden",
    endpoint: "https://api.example/ingest?debug=true#frag",
    error: RuntimeError.new("contains hidden token")
  }
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
  supportDraftRedacted: support_draft.dig("diagnostics", "apiKey") == "[redacted]",
  supportDraftTrace: support_draft.fetch("trace_id"),
  events: 6
)
