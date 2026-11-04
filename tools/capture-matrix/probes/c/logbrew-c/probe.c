#include "logbrew.h"

#include <stdio.h>
#include <stdlib.h>

static const char *traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

static void check(LogBrewStatus status, const LogBrewError *error, const char *step) {
  if (status != LOGBREW_OK) {
    fprintf(stderr, "%s failed: %s %s\n", step, error->code, error->message);
    exit(1);
  }
}

static int authorize_payment(int cents) {
  return cents > 10000 ? -1 : 0;
}

static void handle_checkout(LogBrewClient *client, int request, int cents) {
  LogBrewError error;
  LogBrewTraceContext trace;
  LogBrewTraceScope scope;
  LogBrewSpanAttributes span;
  char log_id[32];
  char span_id[32];
  char issue_id[32];
  int failed;

  logbrew_error_clear(&error);
  snprintf(log_id, sizeof(log_id), "evt_log_%d", request);
  snprintf(span_id, sizeof(span_id), "evt_span_%d", request);
  snprintf(issue_id, sizeof(issue_id), "evt_issue_%d", request);
  check(logbrew_trace_continue_or_create_context(traceparent, &trace, &error), &error, "trace");
  check(logbrew_trace_scope_enter(&scope, &trace, &error), &error, "trace scope");

  check(logbrew_client_add_breadcrumb(
            client,
            (LogBrewIssueBreadcrumb){"2026-11-04T10:00:00Z", "navigation", "checkout.submit", "info", "Checkout submitted", {NULL, 0U}},
            &error),
        &error, "breadcrumb");
  check(logbrew_client_log(client, log_id, "2026-11-04T10:00:01Z", (LogBrewLogAttributes){"checkout started", "info", "checkout"}, &error),
        &error, "log");
  failed = authorize_payment(cents) != 0;
  if (failed) {
    LogBrewIssueMechanism mechanism = {"checkout.authorize", true};
    LogBrewIssueException exception = {"PaymentDeclined", &mechanism};
    LogBrewIssueStackFrame frame;
    LogBrewIssueDetails details = {0};
    check(logbrew_issue_frame_from_location(__FILE__, __LINE__, 1U, __func__, "checkout", true, &frame, &error), &error, "frame");
    details.exception = &exception;
    details.stack_frames = &frame;
    details.stack_frame_count = 1U;
    check(logbrew_client_issue_with_details(
              client, issue_id, "2026-11-04T10:00:02Z",
              (LogBrewIssueAttributes){"Payment authorization failed", "error", NULL},
              details, LOGBREW_EVENT_OPTIONS_NONE, &error),
          &error, "issue");
  }
  check(logbrew_trace_span_attributes(&trace, "POST /checkout", failed ? "error" : "ok", 12.5, true, &span, &error), &error, "span attributes");
  check(logbrew_client_span(client, span_id, "2026-11-04T10:00:03Z", span, &error), &error, "span");
  check(logbrew_client_metric(
            client, request == 1 ? "evt_metric_1" : "evt_metric_2", "2026-11-04T10:00:03Z",
            (LogBrewMetricAttributes){"checkout.duration", "histogram", 12.5, "ms", "delta", {NULL, 0U}, NULL},
            &error),
        &error, "metric");
  logbrew_trace_scope_exit(&scope);
}

int main(void) {
  const char *endpoint = getenv("LOGBREW_CAPTURE_ENDPOINT");
  LogBrewNamedVersion service = {"checkout-worker", "1.2.3"};
  LogBrewDeploymentContext deployment = {"production", "checkout@1.2.3"};
  LogBrewTelemetryResource resource = {.service = &service, .deployment = &deployment};
  LogBrewTelemetryContext context = {.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION, .resource = &resource};
  LogBrewClientOptions options = {.context = &context};
  LogBrewConfig config = {"LOGBREW_API_KEY", "checkout-worker", LOGBREW_C_VERSION, 2U};
  LogBrewSessionContext session = {"session_123", NULL};
  LogBrewSubjectContext subject = {"user_123", LOGBREW_SUBJECT_USER};
  LogBrewTelemetryContext request_context = {
      .schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION, .session = &session, .subject = &subject};
  LogBrewTelemetryScope scope = LOGBREW_TELEMETRY_SCOPE_INIT;
  LogBrewClient *client = NULL;
  LogBrewHttpTransport transport;
  LogBrewTransportResponse response;
  LogBrewError error;

  if (endpoint == NULL) {
    fprintf(stderr, "LOGBREW_CAPTURE_ENDPOINT is required\n");
    return 1;
  }
  logbrew_error_clear(&error);
  check(logbrew_client_new_with_options(config, options, &client, &error), &error, "client");
  check(logbrew_telemetry_scope_enter(&scope, &request_context, &error), &error, "telemetry scope");
  handle_checkout(client, 1, 4200);
  handle_checkout(client, 2, 42000);
  logbrew_telemetry_scope_exit(&scope);

  check(logbrew_http_transport_init(&transport, endpoint, NULL, 0U, 10000L, &error), &error, "transport");
  check(logbrew_client_shutdown(client, logbrew_http_transport_as_transport(&transport), &response, &error), &error, "shutdown");
  logbrew_http_transport_free(&transport);
  logbrew_client_free(client);
  return 0;
}
