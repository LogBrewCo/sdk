#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

const char *const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

class PaymentDeclined final : public std::runtime_error {
public:
  PaymentDeclined() : std::runtime_error("payment declined") {}
};

void authorize_payment(int cents) {
  if (cents > 10000) {
    throw PaymentDeclined();
  }
}

void handle_checkout(logbrew::LogBrewClient &client, int request, int cents) {
  const std::string suffix = std::to_string(request);
  logbrew::TraceScope scope(logbrew::continue_or_create_trace_context(traceparent));
  client.add_breadcrumb(logbrew::IssueBreadcrumb{"2026-11-04T10:00:00Z", "navigation", "checkout.submit", "info", "Checkout submitted", {}});
  client.log("evt_log_" + suffix, "2026-11-04T10:00:01Z", logbrew::LogAttributes{"checkout started", "info", "checkout"});
  std::string status = "ok";
  try {
    authorize_payment(cents);
  } catch (const PaymentDeclined &) {
    status = "error";
    logbrew::IssueDetails details;
    details.exception = logbrew::IssueException{"PaymentDeclined", logbrew::IssueMechanism{"cpp.exception", true}};
    details.stack_frames = {logbrew::issue_frame_from_location(__FILE__, __LINE__, 1U, __func__, "checkout", true)};
    client.issue("evt_issue_" + suffix, "2026-11-04T10:00:02Z",
                 logbrew::IssueAttributes{"Payment authorization failed", "error", std::nullopt}, details);
  }
  client.span("evt_span_" + suffix, "2026-11-04T10:00:03Z", logbrew::trace_span_attributes("POST /checkout", status, 12.5));
  client.metric("evt_metric_" + suffix, "2026-11-04T10:00:03Z",
                logbrew::MetricAttributes{"checkout.duration", "histogram", 12.5, "ms", "delta", {}, std::nullopt});
}

}  // namespace

int main() {
  const char *endpoint = std::getenv("LOGBREW_CAPTURE_ENDPOINT");
  if (endpoint == nullptr) {
    std::cerr << "LOGBREW_CAPTURE_ENDPOINT is required\n";
    return 1;
  }
  logbrew::TelemetryResource resource;
  resource.service = logbrew::NamedVersion{"checkout-worker", "1.2.3"};
  resource.deployment = logbrew::DeploymentContext{"production", "checkout@1.2.3"};
  logbrew::ClientOptions options;
  options.context = logbrew::TelemetryContext{};
  options.context->resource = resource;
  logbrew::LogBrewClient client(logbrew::Config{"LOGBREW_API_KEY", "checkout-worker", logbrew::version, 2}, options);

  logbrew::TelemetryContext request_context;
  request_context.session = logbrew::SessionContext{"session_123", std::nullopt};
  request_context.subject = logbrew::SubjectContext{"user_123", logbrew::SubjectKind::user};
  {
    logbrew::TelemetryScope scope(request_context);
    handle_checkout(client, 1, 4200);
    handle_checkout(client, 2, 42000);
  }

  logbrew::HttpTransport transport(endpoint);
  client.shutdown(transport);
  return 0;
}
