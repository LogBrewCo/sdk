#include "logbrew.h"

#include <stdio.h>
#include <stdlib.h>

static void must(LogBrewStatus status, const LogBrewError *error) {
  if (status != LOGBREW_OK) {
    fprintf(stderr, "%s: %s\n", error->code, error->message);
    exit(1);
  }
}

int main(void) {
  static const char *incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
  LogBrewClient *client = NULL;
  LogBrewError error;
  LogBrewTraceContext trace;
  LogBrewTraceScope scope;
  LogBrewSpanAttributes span;
  LogBrewMetadataEntry trace_entries[LOGBREW_TRACE_METADATA_ENTRY_COUNT];
  LogBrewMetadata trace_metadata;
  LogBrewProductTimelineContext timeline_context = {
    "session_123",
    NULL,
    "https://mobile.example.test/api/checkout?card=redacted#pay",
    "Checkout",
    "checkout",
    "submit"
  };
  char traceparent[LOGBREW_TRACEPARENT_LENGTH + 1U];
  char *preview = NULL;
  LogBrewConfig config = {"LOGBREW_API_KEY", "logbrew-c-trace", LOGBREW_C_VERSION, 2U};

  logbrew_error_clear(&error);
  must(logbrew_client_new(config, &client, &error), &error);
  must(logbrew_trace_context_from_traceparent(incoming, &trace, &error), &error);
  must(logbrew_trace_scope_enter(&scope, &trace, &error), &error);

  trace_metadata = logbrew_trace_metadata(&trace, trace_entries);
  timeline_context = logbrew_trace_product_timeline_context(&trace, timeline_context);
  must(logbrew_trace_span_attributes(&trace, "POST /checkout/{cart_id}", "error", 37.5, true, &span, &error), &error);

  must(logbrew_client_issue(client, "evt_c_trace_issue_001", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout request failed", "error", "request failed after retry budget"}, &error), &error);
  must(logbrew_client_log(client, "evt_c_trace_log_001", "2026-06-02T10:00:03Z",
      (LogBrewLogAttributes){"checkout failed", "warning", "checkout"}, &error), &error);
  must(logbrew_client_action(client, "evt_c_trace_action_001", "2026-06-02T10:00:04Z",
      (LogBrewActionAttributes){"checkout.submit", "failure"}, &error), &error);
  must(logbrew_client_span(client, "evt_c_trace_span_001", "2026-06-02T10:00:05Z", span, &error), &error);
  must(logbrew_client_metric(client, "evt_c_trace_metric_001", "2026-06-02T10:00:06Z",
      (LogBrewMetricAttributes){"http.server.duration", "histogram", 37.5, "ms", "delta", trace_metadata}, &error), &error);
  must(logbrew_client_product_action(client, "evt_c_trace_product_action_001", "2026-06-02T10:00:07Z",
      (LogBrewProductActionAttributes){"checkout.submit", "failure", timeline_context, {NULL, 0U}}, &error), &error);
  must(logbrew_client_network_milestone(client, "evt_c_trace_network_001", "2026-06-02T10:00:08Z",
      (LogBrewNetworkMilestoneAttributes){
        "post",
        "https://mobile.example.test/api/checkout?card=redacted#pay",
        503,
        true,
        37.5,
        true,
        timeline_context,
        {NULL, 0U}
      }, &error), &error);
  must(logbrew_trace_create_headers(&trace, traceparent, &error), &error);
  must(logbrew_client_preview_json(client, &preview, &error), &error);

  printf("%s\n", preview);
  fprintf(stderr, "{\"traceparent\":\"%s\"}\n", traceparent);

  logbrew_free_string(preview);
  logbrew_trace_scope_exit(&scope);
  logbrew_client_free(client);
  return 0;
}
