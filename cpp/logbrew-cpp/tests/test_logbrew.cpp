#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>

namespace {

int tests_run = 0;

#define EXPECT_TRUE(condition)                                                                        \
  do {                                                                                                \
    tests_run++;                                                                                      \
    if (!(condition)) {                                                                               \
      std::cerr << "test failed at " << __FILE__ << ':' << __LINE__ << ": " << #condition << '\n'; \
      std::exit(1);                                                                                   \
    }                                                                                                 \
  } while (false)

logbrew::LogBrewClient new_client() {
  return logbrew::LogBrewClient(logbrew::Config{"LOGBREW_API_KEY", "logbrew-cpp", logbrew::version, 2});
}

void queue_fixture_events(logbrew::LogBrewClient &client) {
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

void preview_json_contains_all_supported_event_types() {
  auto client = new_client();
  queue_fixture_events(client);
  const std::string json = client.preview_json();
  EXPECT_TRUE(json.find("\"language\":\"cpp\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"release\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"environment\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"issue\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"log\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"span\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"action\"") != std::string::npos);
}

void product_timeline_helpers_capture_safe_metadata() {
  auto client = new_client();

  logbrew::ProductTimelineContext context;
  context.session_id = "session_123";
  context.screen = "Checkout";
  context.trace_id = "trace_001";
  context.funnel = "checkout";
  context.step = "submit";

  logbrew::ProductActionAttributes product_action;
  product_action.name = "checkout submit";
  product_action.context = context;
  product_action.metadata = {
      {"component", "pay-button"},
      {"attempt", 2},
      {"retryable", false},
  };
  client.capture_product_action("evt_product_action_001", "2026-06-02T10:00:06Z", product_action);

  logbrew::NetworkMilestoneAttributes network;
  network.method = " post ";
  network.route_template = "https://api.example.com/checkout/confirm?view=ignored#fragment";
  network.status_code = 503;
  network.duration_ms = 42.75;
  network.context = context;
  network.metadata = {{"provider", "stripe"}};
  client.capture_network_milestone("evt_network_001", "2026-06-02T10:00:07Z", network);

  const std::string json = client.preview_json();
  EXPECT_TRUE(json.find("\"name\":\"checkout submit\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"source\":\"cpp.product_action\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"sessionId\":\"session_123\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"screen\":\"Checkout\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"attempt\":2") != std::string::npos);
  EXPECT_TRUE(json.find("\"retryable\":false") != std::string::npos);
  EXPECT_TRUE(json.find("\"name\":\"POST /checkout/confirm\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"source\":\"cpp.network\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"routeTemplate\":\"/checkout/confirm\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"statusCode\":503") != std::string::npos);
  EXPECT_TRUE(json.find("\"durationMs\":42.75") != std::string::npos);
  EXPECT_TRUE(json.find("view=ignored") == std::string::npos);
  EXPECT_TRUE(json.find("#fragment") == std::string::npos);
}

void metric_helper_validates_and_serializes() {
  auto client = new_client();
  client.metric(
      "evt_metric_001",
      "2026-06-02T10:00:06Z",
      logbrew::MetricAttributes{
          "queue.depth",
          "gauge",
          42.0,
          "{items}",
          "instant",
          {{"queue", "checkout"}, {"sampled", true}},
      });

  const std::string json = client.preview_json();
  EXPECT_TRUE(json.find("\"type\":\"metric\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"name\":\"queue.depth\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"kind\":\"gauge\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"value\":42") != std::string::npos);
  EXPECT_TRUE(json.find("\"unit\":\"{items}\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"temporality\":\"instant\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"queue\":\"checkout\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"sampled\":true") != std::string::npos);
}

void flush_success_clears_queue() {
  auto client = new_client();
  queue_fixture_events(client);
  logbrew::RecordingTransport transport;
  const logbrew::TransportResponse response = client.flush(transport);
  EXPECT_TRUE(response.status_code == 202);
  EXPECT_TRUE(response.attempts == 1U);
  EXPECT_TRUE(client.pending_events() == 0U);
  EXPECT_TRUE(transport.sent_bodies().size() == 1U);
  EXPECT_TRUE(transport.last_body() != nullptr);
}

void empty_flush_is_no_op() {
  auto client = new_client();
  logbrew::RecordingTransport transport;
  const logbrew::TransportResponse response = client.flush(transport);
  EXPECT_TRUE(response.status_code == 204);
  EXPECT_TRUE(response.attempts == 0U);
  EXPECT_TRUE(transport.sent_bodies().empty());
}

void validation_failures_are_stable() {
  auto client = new_client();
  try {
    client.issue("evt_issue_bad", "2026-06-02T10:00:02Z", logbrew::IssueAttributes{"Checkout timeout", "fatal", std::nullopt});
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    client.release("evt_release_bad", "2026-06-02T10:00:00", logbrew::ReleaseAttributes{"1.2.3", std::nullopt, std::nullopt});
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    logbrew::NetworkMilestoneAttributes network;
    network.method = "GET";
    network.route_template = "?view=ignored";
    client.capture_network_milestone("evt_network_bad_route", "2026-06-02T10:00:07Z", network);
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    logbrew::NetworkMilestoneAttributes network;
    network.method = "GET";
    network.route_template = "/health";
    network.status_code = 99;
    client.capture_network_milestone("evt_network_bad_status", "2026-06-02T10:00:07Z", network);
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    logbrew::ProductActionAttributes product_action;
    product_action.name = "checkout submit";
    product_action.metadata = {{"bad", std::numeric_limits<double>::quiet_NaN()}};
    client.capture_product_action("evt_product_action_bad", "2026-06-02T10:00:06Z", product_action);
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    client.metric(
        "evt_metric_bad_counter",
        "2026-06-02T10:00:06Z",
        logbrew::MetricAttributes{"jobs.processed", "counter", -1.0, "1", "delta"});
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    client.metric(
        "evt_metric_bad_gauge",
        "2026-06-02T10:00:06Z",
        logbrew::MetricAttributes{"queue.depth", "gauge", 42.0, "{items}", "delta"});
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    client.metric(
        "evt_metric_bad_histogram",
        "2026-06-02T10:00:06Z",
        logbrew::MetricAttributes{
            "checkout.duration",
            "histogram",
            std::numeric_limits<double>::quiet_NaN(),
            "ms",
            "delta",
        });
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
}

void unauthenticated_response_surfaces_clean_error() {
  auto client = new_client();
  queue_fixture_events(client);
  logbrew::RecordingTransport transport({logbrew::RecordingTransport::Step::status_code_step(401)});
  try {
    static_cast<void>(client.flush(transport));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "unauthenticated");
    EXPECT_TRUE(client.pending_events() == 6U);
  }
}

void retry_recovery_and_retry_budget_are_observable() {
  auto client = new_client();
  queue_fixture_events(client);
  logbrew::RecordingTransport transport({
      logbrew::RecordingTransport::Step::network_failure("temporary network failure"),
      logbrew::RecordingTransport::Step::status_code_step(503),
      logbrew::RecordingTransport::Step::status_code_step(202),
  });
  const logbrew::TransportResponse response = client.flush(transport);
  EXPECT_TRUE(response.status_code == 202);
  EXPECT_TRUE(response.attempts == 3U);
  EXPECT_TRUE(transport.sent_bodies().size() == 3U);

  auto retry_client = new_client();
  queue_fixture_events(retry_client);
  logbrew::RecordingTransport failing_transport({
      logbrew::RecordingTransport::Step::network_failure("first failure"),
      logbrew::RecordingTransport::Step::network_failure("second failure"),
      logbrew::RecordingTransport::Step::network_failure("third failure"),
  });
  try {
    static_cast<void>(retry_client.flush(failing_transport));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "network_failure");
    EXPECT_TRUE(failing_transport.sent_bodies().size() == 3U);
    EXPECT_TRUE(retry_client.pending_events() == 6U);
  }
}

void non_retryable_status_and_shutdown_are_stable() {
  auto client = new_client();
  queue_fixture_events(client);
  logbrew::RecordingTransport status_transport({logbrew::RecordingTransport::Step::status_code_step(422)});
  try {
    static_cast<void>(client.flush(status_transport));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "transport_error");
  }

  auto shutdown_client = new_client();
  queue_fixture_events(shutdown_client);
  logbrew::RecordingTransport accept_transport;
  static_cast<void>(shutdown_client.shutdown(accept_transport));
  try {
    shutdown_client.action("evt_after_shutdown", "2026-06-02T10:00:05Z", logbrew::ActionAttributes{"deploy", "success"});
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "shutdown_error");
  }
}

#ifdef LOGBREW_CPP_TEST_HTTP_TRANSPORT
void http_transport_validates_configuration() {
  try {
    logbrew::HttpTransport transport("ftp://example.com/v1/events", {}, 1000L);
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "configuration_error");
  }
  try {
    logbrew::HttpTransport transport("https://example.com/v1/events", {}, 0L);
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "configuration_error");
  }
  try {
    logbrew::HttpTransport transport("https://example.com/v1/events", {{"authorization", "bad"}}, 1000L);
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "configuration_error");
  }
  logbrew::HttpTransport transport(
      "https://example.com/v1/events",
      {{"x-logbrew-source", "cpp-test"}},
      1000L);
  (void)transport;
  EXPECT_TRUE(std::string(logbrew::http_transport_default_endpoint) == "https://api.logbrew.com/v1/events");
}
#endif

} // namespace

int main() {
  preview_json_contains_all_supported_event_types();
  product_timeline_helpers_capture_safe_metadata();
  metric_helper_validates_and_serializes();
  flush_success_clears_queue();
  empty_flush_is_no_op();
  validation_failures_are_stable();
  unauthenticated_response_surfaces_clean_error();
  retry_recovery_and_retry_budget_are_observable();
  non_retryable_status_and_shutdown_are_stable();
#ifdef LOGBREW_CPP_TEST_HTTP_TRANSPORT
  http_transport_validates_configuration();
#endif
  std::cout << "c++ package tests ok (" << tests_run << " checks)\n";
  return 0;
}
