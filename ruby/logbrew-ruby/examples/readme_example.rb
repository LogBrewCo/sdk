# frozen_string_literal: true

begin
  require "logbrew"
rescue LoadError
  require_relative "../lib/logbrew"
end

def enqueue_all(client)
  client.release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  )
  client.environment(
    "evt_environment_001",
    "2026-06-02T10:00:01Z",
    name: "production",
    region: "global"
  )
  client.issue(
    "evt_issue_001",
    "2026-06-02T10:00:02Z",
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  )
  client.log(
    "evt_log_001",
    "2026-06-02T10:00:03Z",
    message: "worker started",
    level: "info",
    logger: "job-runner"
  )
  client.span(
    "evt_span_001",
    "2026-06-02T10:00:04Z",
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  )
  client.action(
    "evt_action_001",
    "2026-06-02T10:00:05Z",
    name: "deploy",
    status: "success"
  )
end

if __FILE__ == $PROGRAM_NAME
  client = LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0"
  )
  enqueue_all(client)

  puts client.preview_json
  response = client.shutdown(LogBrew::RecordingTransport.always_accept)
  $stderr.puts JSON.generate(ok: true, status: response.status_code, attempts: response.attempts, events: 6)
end
