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

void trace_context_helpers_validate_and_correlate() {
  static const std::string incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
  logbrew::TraceContext context = logbrew::trace_context_from_traceparent(incoming);
  EXPECT_TRUE(context.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736");
  EXPECT_TRUE(context.parent_span_id.has_value() && *context.parent_span_id == "00f067aa0ba902b7");
  EXPECT_TRUE(context.span_id.size() == logbrew::span_id_length);
  EXPECT_TRUE(context.span_id != *context.parent_span_id);
  EXPECT_TRUE(context.sampled);
  EXPECT_TRUE(context.trace_flags == "01");
  const auto headers = logbrew::traceparent_headers(&context);
  EXPECT_TRUE(headers.at("traceparent").find("00-4bf92f3577b34da6a3ce929d0e0e4736-") == 0U);
  EXPECT_TRUE(headers.at("traceparent").substr(52U) == "-01");

  try {
    static_cast<void>(logbrew::trace_context_from_traceparent("bad"));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    static_cast<void>(logbrew::trace_context_from_traceparent(
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01"));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  const logbrew::TraceContext fallback = logbrew::continue_or_create_trace_context("bad");
  EXPECT_TRUE(fallback.trace_id.size() == logbrew::trace_id_length);
  EXPECT_TRUE(!fallback.parent_span_id.has_value());

  const logbrew::OpenTelemetrySpanContext otel_parent = logbrew::open_telemetry_span_context(
      "4BF92F3577B34DA6A3CE929D0E0E4736",
      "00F067AA0BA902B7",
      "01");
  EXPECT_TRUE(otel_parent.trace_id == context.trace_id);
  EXPECT_TRUE(otel_parent.span_id == *context.parent_span_id);
  EXPECT_TRUE(otel_parent.trace_flags == "01");
  EXPECT_TRUE(otel_parent.sampled);
  const logbrew::TraceContext otel_context = logbrew::trace_context_from_opentelemetry_span_context(otel_parent);
  EXPECT_TRUE(otel_context.trace_id == context.trace_id);
  EXPECT_TRUE(otel_context.parent_span_id.has_value() && *otel_context.parent_span_id == *context.parent_span_id);
  EXPECT_TRUE(otel_context.span_id.size() == logbrew::span_id_length);
  EXPECT_TRUE(otel_context.span_id != *context.parent_span_id);
  EXPECT_TRUE(otel_context.sampled);
  EXPECT_TRUE(otel_context.trace_flags == "01");
  const logbrew::OpenTelemetrySpanContext unsampled_otel_parent =
      logbrew::open_telemetry_span_context_from_sampled(context.trace_id, *context.parent_span_id, false);
  const logbrew::TraceContext unsampled_otel_context =
      logbrew::trace_context_from_opentelemetry_span_context(unsampled_otel_parent);
  EXPECT_TRUE(!unsampled_otel_context.sampled);
  EXPECT_TRUE(unsampled_otel_context.trace_flags == "00");
  const auto otel_span = logbrew::trace_span_attributes_from_opentelemetry_span_context(
      "GET /otel-parent",
      "ok",
      otel_parent,
      12.0);
  EXPECT_TRUE(otel_span.trace_id == context.trace_id);
  EXPECT_TRUE(otel_span.parent_span_id.has_value() && *otel_span.parent_span_id == *context.parent_span_id);
  EXPECT_TRUE(otel_span.span_id.size() == logbrew::span_id_length);
  EXPECT_TRUE(otel_span.span_id != *context.parent_span_id);
  EXPECT_TRUE(otel_span.duration_ms.has_value() && *otel_span.duration_ms == 12.0);
  try {
    static_cast<void>(logbrew::open_telemetry_span_context(
        "00000000000000000000000000000000",
        "00f067aa0ba902b7",
        "01"));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    static_cast<void>(logbrew::open_telemetry_span_context(
        context.trace_id,
        "0000000000000000",
        "01"));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  try {
    static_cast<void>(logbrew::open_telemetry_span_context(context.trace_id, *context.parent_span_id, "zz"));
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }

  auto client = new_client();
  logbrew::ProductTimelineContext timeline_context;
  timeline_context.session_id = "session_123";
  timeline_context.screen = "Checkout";
  timeline_context.trace_id = "spoofed_trace";
  timeline_context.funnel = "checkout";
  timeline_context.step = "submit";

  {
    logbrew::TraceScope scope(context);
    EXPECT_TRUE(logbrew::current_trace_context() != nullptr);
    EXPECT_TRUE(logbrew::current_trace_context()->trace_id == context.trace_id);
    {
      logbrew::TraceScope nested_scope(logbrew::create_trace_context());
      EXPECT_TRUE(logbrew::current_trace_context()->trace_id == nested_scope.context().trace_id);
    }
    EXPECT_TRUE(logbrew::current_trace_context() != nullptr);
    EXPECT_TRUE(logbrew::current_trace_context()->trace_id == context.trace_id);

    const auto trace_metadata = logbrew::trace_metadata();
    const auto span = logbrew::trace_span_attributes("POST /checkout/{cart_id}", "error", 37.5);
    timeline_context = logbrew::trace_product_timeline_context(timeline_context);
    client.issue("evt_trace_issue", "2026-06-02T10:00:02Z",
                 logbrew::IssueAttributes{"Checkout failed", "error", "request failed"});
    client.log("evt_trace_log", "2026-06-02T10:00:03Z",
               logbrew::LogAttributes{"checkout failed", "warn", "checkout"});
    client.action("evt_trace_action", "2026-06-02T10:00:04Z",
                  logbrew::ActionAttributes{"checkout.submit", "failure", {{"traceId", "spoofed_trace"}}});
    client.span("evt_trace_span", "2026-06-02T10:00:05Z", span);
    client.metric("evt_trace_metric", "2026-06-02T10:00:06Z",
                  logbrew::MetricAttributes{"http.server.duration", "histogram", 37.5, "ms", "delta", trace_metadata});
    client.capture_product_action(
        "evt_trace_product_action",
        "2026-06-02T10:00:07Z",
        logbrew::ProductActionAttributes{"checkout.submit", "failure", timeline_context, {}});
    client.capture_network_milestone(
        "evt_trace_network",
        "2026-06-02T10:00:08Z",
        logbrew::NetworkMilestoneAttributes{
            "post",
            "https://native.example.test/api/checkout?card=redacted#pay",
            503,
            37.5,
            std::nullopt,
            timeline_context,
            {}});
  }
  EXPECT_TRUE(logbrew::current_trace_context() == nullptr);

  const std::string json = client.preview_json();
  EXPECT_TRUE(json.find("\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e4736\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"parentSpanId\":\"00f067aa0ba902b7\"") != std::string::npos);
  EXPECT_TRUE(json.find(context.span_id) != std::string::npos);
  EXPECT_TRUE(json.find("\"sampled\":true") != std::string::npos);
  EXPECT_TRUE(json.find("\"traceFlags\":\"01\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"issue\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"log\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"span\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"type\":\"metric\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"name\":\"POST /api/checkout\"") != std::string::npos);
  EXPECT_TRUE(json.find("spoofed_trace") == std::string::npos);
  EXPECT_TRUE(json.find("traceparent") == std::string::npos);
  EXPECT_TRUE(json.find("card=redacted") == std::string::npos);
  EXPECT_TRUE(json.find("#pay") == std::string::npos);
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
    client.issue("evt_issue_bad", "2026-06-02T10:00:02Z", logbrew::IssueAttributes{"Checkout timeout", "verbose", std::nullopt});
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
  client.issue("evt_issue_alias", "2026-06-02T10:00:02Z", logbrew::IssueAttributes{"Checkout timeout", "fatal", std::nullopt});
  client.log("evt_log_debug", "2026-06-02T10:00:03Z", logbrew::LogAttributes{"verbose runtime detail", "debug", std::nullopt});
  const std::string preview = client.preview_json();
  EXPECT_TRUE(preview.find("\"level\":\"critical\"") != std::string::npos);
  EXPECT_TRUE(preview.find("\"level\":\"info\"") != std::string::npos);
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
  trace_context_helpers_validate_and_correlate();
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
