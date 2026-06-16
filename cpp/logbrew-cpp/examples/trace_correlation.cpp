#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

void require_condition(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

} // namespace

int main() {
  static const std::string incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
  logbrew::LogBrewClient client(logbrew::Config{"LOGBREW_API_KEY", "logbrew-cpp-trace", logbrew::version, 2});
  logbrew::TraceScope scope(logbrew::trace_context_from_traceparent(incoming));
  const auto trace_metadata = logbrew::trace_metadata();
  auto timeline_context = logbrew::trace_product_timeline_context(logbrew::ProductTimelineContext{
      "session_123",
      "Checkout",
      "spoofed_trace",
      "checkout",
      "submit",
      {},
  });
  const auto span = logbrew::trace_span_attributes("POST /checkout/{cart_id}", "error", 37.5);

  client.issue("evt_cpp_trace_issue_001", "2026-06-02T10:00:02Z",
               logbrew::IssueAttributes{"Checkout request failed", "error", "request failed after retry budget"});
  client.log("evt_cpp_trace_log_001", "2026-06-02T10:00:03Z",
             logbrew::LogAttributes{"checkout failed", "warning", "checkout"});
  client.action("evt_cpp_trace_action_001", "2026-06-02T10:00:04Z",
                logbrew::ActionAttributes{"checkout.submit", "failure", {{"traceId", "spoofed_trace"}}});
  client.span("evt_cpp_trace_span_001", "2026-06-02T10:00:05Z", span);
  client.metric("evt_cpp_trace_metric_001", "2026-06-02T10:00:06Z",
                logbrew::MetricAttributes{"http.server.duration", "histogram", 37.5, "ms", "delta", trace_metadata});
  client.capture_product_action("evt_cpp_trace_product_action_001", "2026-06-02T10:00:07Z",
                                logbrew::ProductActionAttributes{"checkout.submit", "failure", timeline_context, {}});
  client.capture_network_milestone(
      "evt_cpp_trace_network_001",
      "2026-06-02T10:00:08Z",
      logbrew::NetworkMilestoneAttributes{
          "post",
          "https://native.example.test/api/checkout?card=redacted#pay",
          503,
          37.5,
          std::nullopt,
          timeline_context,
          {},
      });

  const auto headers = logbrew::traceparent_headers();
  const auto traceparent = headers.find("traceparent");
  require_condition(traceparent != headers.end(), "missing traceparent header");
  std::cout << client.preview_json() << '\n';
  std::cerr << "{\"traceparent\":\"" << traceparent->second << "\"}\n";
  return 0;
}
