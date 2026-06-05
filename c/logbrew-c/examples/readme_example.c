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
  LogBrewClient *client = NULL;
  LogBrewError error;
  LogBrewRecordingTransport transport;
  LogBrewTransportResponse response;
  char *preview = NULL;
  LogBrewConfig config = {
    "LOGBREW_API_KEY",
    "logbrew-c",
    LOGBREW_C_VERSION,
    2U
  };
  LogBrewSpanAttributes span = {
    "GET /health",
    "trace_001",
    "span_001",
    NULL,
    "ok",
    12.5,
    true
  };

  logbrew_error_clear(&error);
  must(logbrew_client_new(config, &client, &error), &error);
  must(logbrew_client_release(client, "evt_release_001", "2026-06-02T10:00:00Z",
      (LogBrewReleaseAttributes){"1.2.3", "abc123def456", "Public release marker"}, &error), &error);
  must(logbrew_client_environment(client, "evt_environment_001", "2026-06-02T10:00:01Z",
      (LogBrewEnvironmentAttributes){"production", "global"}, &error), &error);
  must(logbrew_client_issue(client, "evt_issue_001", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout timeout", "error", "Request timed out after retry budget"}, &error), &error);
  must(logbrew_client_log(client, "evt_log_001", "2026-06-02T10:00:03Z",
      (LogBrewLogAttributes){"worker started", "info", "job-runner"}, &error), &error);
  must(logbrew_client_span(client, "evt_span_001", "2026-06-02T10:00:04Z", span, &error), &error);
  must(logbrew_client_action(client, "evt_action_001", "2026-06-02T10:00:05Z",
      (LogBrewActionAttributes){"deploy", "success"}, &error), &error);

  must(logbrew_client_preview_json(client, &preview, &error), &error);
  printf("%s\n", preview);
  logbrew_free_string(preview);

  logbrew_recording_transport_init(&transport, NULL, 0U);
  must(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error), &error);
  fprintf(stderr, "{\"ok\":true,\"status\":%d,\"attempts\":%zu,\"events\":%zu}\n",
          response.status_code,
          response.attempts,
          logbrew_recording_transport_sent_count(&transport));
  logbrew_recording_transport_free(&transport);
  logbrew_client_free(client);
  return 0;
}
