#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>

int main() {
  try {
    logbrew::LogBrewClient client(logbrew::Config{"LOGBREW_API_KEY", "logbrew-cpp", logbrew::version, 2});

    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        logbrew::ReleaseAttributes{"1.2.3", "abc123def456", "Public release marker"});
    client.environment(
        "evt_environment_001",
        "2026-06-02T10:00:01Z",
        logbrew::EnvironmentAttributes{"production", "global"});
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        logbrew::IssueAttributes{"Checkout timeout", "error", "Request timed out after retry budget"});
    client.log(
        "evt_log_001",
        "2026-06-02T10:00:03Z",
        logbrew::LogAttributes{"worker started", "info", "job-runner"});
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        logbrew::SpanAttributes{"GET /health", "trace_001", "span_001", std::nullopt, "ok", 12.5});
    client.action(
        "evt_action_001",
        "2026-06-02T10:00:05Z",
        logbrew::ActionAttributes{"deploy", "success"});

    std::cout << client.preview_json() << '\n';
    logbrew::RecordingTransport transport;
    const logbrew::TransportResponse response = client.flush(transport);
    std::cerr << "{\"ok\":true,\"status\":" << response.status_code << ",\"attempts\":" << response.attempts
              << ",\"events\":" << transport.sent_bodies().size() << "}\n";
    return 0;
  } catch (const logbrew::SdkException &error) {
    std::cerr << error.code() << ": " << error.what() << '\n';
    return 1;
  }
}
