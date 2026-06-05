#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>

namespace {

logbrew::LogBrewClient new_client() {
  return logbrew::LogBrewClient(logbrew::Config{"LOGBREW_API_KEY", "logbrew-cpp", logbrew::version, 2});
}

void queue_events(logbrew::LogBrewClient &client) {
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
}

void require_condition(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

void exercise_failure_paths() {
  auto empty_client = new_client();
  logbrew::RecordingTransport empty_transport;
  const logbrew::TransportResponse empty_response = empty_client.flush(empty_transport);
  require_condition(empty_response.status_code == 204 && empty_response.attempts == 0U, "empty flush failed");

  try {
    empty_client.issue("evt_bad", "2026-06-02T10:00:02Z", logbrew::IssueAttributes{"Checkout timeout", "fatal", std::nullopt});
    require_condition(false, "validation failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "validation_error", "validation failure used wrong code");
  }

  auto unauth_client = new_client();
  queue_events(unauth_client);
  logbrew::RecordingTransport unauth_transport({logbrew::RecordingTransport::Step::status_code_step(401)});
  try {
    static_cast<void>(unauth_client.flush(unauth_transport));
    require_condition(false, "unauthenticated failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "unauthenticated", "unauthenticated failure used wrong code");
  }

  auto retry_client = new_client();
  queue_events(retry_client);
  logbrew::RecordingTransport retry_transport({
      logbrew::RecordingTransport::Step::network_failure("first failure"),
      logbrew::RecordingTransport::Step::network_failure("second failure"),
      logbrew::RecordingTransport::Step::network_failure("third failure"),
  });
  try {
    static_cast<void>(retry_client.flush(retry_transport));
    require_condition(false, "retry-budget failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "network_failure", "retry-budget failure used wrong code");
  }

  auto status_client = new_client();
  queue_events(status_client);
  logbrew::RecordingTransport status_transport({logbrew::RecordingTransport::Step::status_code_step(422)});
  try {
    static_cast<void>(status_client.flush(status_transport));
    require_condition(false, "non-retryable status failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "transport_error", "non-retryable status failure used wrong code");
  }

  auto shutdown_client = new_client();
  queue_events(shutdown_client);
  logbrew::RecordingTransport accept_transport;
  static_cast<void>(shutdown_client.shutdown(accept_transport));
  try {
    shutdown_client.action("evt_after_shutdown", "2026-06-02T10:00:05Z", logbrew::ActionAttributes{"deploy", "success"});
    require_condition(false, "post-shutdown failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "shutdown_error", "post-shutdown failure used wrong code");
  }
}

} // namespace

int main() {
  try {
    auto client = new_client();
    queue_events(client);
    std::cout << client.preview_json() << '\n';
    logbrew::RecordingTransport transport({
        logbrew::RecordingTransport::Step::network_failure("temporary network failure"),
        logbrew::RecordingTransport::Step::status_code_step(503),
        logbrew::RecordingTransport::Step::status_code_step(202),
    });
    const logbrew::TransportResponse response = client.flush(transport);
    std::cerr << "{\"ok\":true,\"status\":" << response.status_code << ",\"retryAttempts\":" << response.attempts
              << ",\"sentBodies\":" << transport.sent_bodies().size() << "}\n";
    exercise_failure_paths();
    return 0;
  } catch (const logbrew::SdkException &error) {
    std::cerr << error.code() << ": " << error.what() << '\n';
    return 1;
  }
}
