#include "logbrew.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void must(LogBrewStatus status, const LogBrewError *error) {
  if (status != LOGBREW_OK) {
    fprintf(stderr, "%s: %s\n", error->code, error->message);
    exit(1);
  }
}

static LogBrewClient *new_client(void) {
  LogBrewClient *client = NULL;
  LogBrewError error;
  LogBrewConfig config = {
    "LOGBREW_API_KEY",
    "logbrew-c",
    LOGBREW_C_VERSION,
    2U
  };
  logbrew_error_clear(&error);
  must(logbrew_client_new(config, &client, &error), &error);
  return client;
}

static void queue_events(LogBrewClient *client) {
  LogBrewError error;
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
}

static void exercise_failure_paths(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingTransport transport;
  LogBrewTransportResponse response;
  LogBrewError error;
  LogBrewStatus status;

  logbrew_recording_transport_init(&transport, NULL, 0U);
  must(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error), &error);
  if (response.status_code != 204 || response.attempts != 0U) {
    fprintf(stderr, "unexpected empty flush response\n");
    exit(1);
  }
  logbrew_recording_transport_free(&transport);

  status = logbrew_client_issue(client, "evt_bad_issue", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout timeout", "verbose", NULL}, &error);
  if (status != LOGBREW_VALIDATION_ERROR || strcmp(error.code, "validation_error") != 0) {
    fprintf(stderr, "validation failure did not use stable error code\n");
    exit(1);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  {
    LogBrewRecordingStep steps[] = {LOGBREW_RECORD_STATUS_CODE(401)};
    logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
    status = logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
    if (status != LOGBREW_TRANSPORT_ERROR || strcmp(error.code, "unauthenticated") != 0) {
      fprintf(stderr, "unauthenticated failure did not use stable error code\n");
      exit(1);
    }
    logbrew_recording_transport_free(&transport);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  {
    LogBrewRecordingStep steps[] = {LOGBREW_RECORD_STATUS_CODE(422)};
    logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
    status = logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
    if (status != LOGBREW_TRANSPORT_ERROR || strcmp(error.code, "transport_error") != 0) {
      fprintf(stderr, "non-retryable status failure did not use stable error code\n");
      exit(1);
    }
    logbrew_recording_transport_free(&transport);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  {
    LogBrewRecordingStep steps[] = {
      LOGBREW_RECORD_NETWORK_FAILURE("first failure"),
      LOGBREW_RECORD_NETWORK_FAILURE("second failure"),
      LOGBREW_RECORD_NETWORK_FAILURE("third failure")
    };
    logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
    status = logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
    if (status != LOGBREW_TRANSPORT_ERROR || strcmp(error.code, "network_failure") != 0) {
      fprintf(stderr, "retry-budget failure did not use stable error code\n");
      exit(1);
    }
    logbrew_recording_transport_free(&transport);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  logbrew_recording_transport_init(&transport, NULL, 0U);
  must(logbrew_client_shutdown(client, logbrew_recording_transport_as_transport(&transport), &response, &error), &error);
  status = logbrew_client_action(client, "evt_after_shutdown", "2026-06-02T10:00:05Z",
      (LogBrewActionAttributes){"deploy", "success"}, &error);
  if (status != LOGBREW_SHUTDOWN_ERROR || strcmp(error.code, "shutdown_error") != 0) {
    fprintf(stderr, "post-shutdown failure did not use stable error code\n");
    exit(1);
  }
  logbrew_recording_transport_free(&transport);
  logbrew_client_free(client);
}

static void exercise_timeline_helpers(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  char *preview = NULL;
  LogBrewMetadataEntry metadata[] = {
    LOGBREW_METADATA_NUMBER_VALUE("cartValue", 42.5),
    LOGBREW_METADATA_BOOL_VALUE("retry", false)
  };
  LogBrewProductTimelineContext context = {
    "session_123",
    "trace_001",
    "/checkout?sku=123#pay",
    "Checkout",
    "checkout",
    "submit"
  };
  logbrew_error_clear(&error);
  must(logbrew_client_product_action(client, "evt_product_action_001", "2026-06-02T10:00:06Z",
      (LogBrewProductActionAttributes){
        "checkout.submit",
        "success",
        context,
        {metadata, sizeof(metadata) / sizeof(metadata[0])}
      }, &error), &error);
  must(logbrew_client_network_milestone(client, "evt_network_milestone_001", "2026-06-02T10:00:07Z",
      (LogBrewNetworkMilestoneAttributes){
        "post",
        "https://api.example.com/api/checkout?sku=123#pay",
        503,
        true,
        184.5,
        true,
        context,
        {metadata, sizeof(metadata) / sizeof(metadata[0])}
      }, &error), &error);
  must(logbrew_client_preview_json(client, &preview, &error), &error);
  if (strstr(preview, "\"source\":\"c.action\"") == NULL ||
      strstr(preview, "\"source\":\"c.network\"") == NULL ||
      strstr(preview, "\"name\":\"POST /api/checkout\"") == NULL ||
      strstr(preview, "\"status\":\"failure\"") == NULL ||
      strstr(preview, "sku=") != NULL ||
      strstr(preview, "#pay") != NULL) {
    fprintf(stderr, "timeline helper preview failed\n");
    exit(1);
  }
  logbrew_free_string(preview);
  logbrew_client_free(client);
}

static void exercise_metric_helper(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  char *preview = NULL;
  LogBrewStatus status;
  LogBrewMetadataEntry metadata[] = {
    LOGBREW_METADATA_STRING_VALUE("queue", "checkout"),
    LOGBREW_METADATA_BOOL_VALUE("sampled", true)
  };
  logbrew_error_clear(&error);
  must(logbrew_client_metric(client, "evt_metric_001", "2026-06-02T10:00:06Z",
      (LogBrewMetricAttributes){
        "queue.depth",
        "gauge",
        42.0,
        "{items}",
        "instant",
        {metadata, sizeof(metadata) / sizeof(metadata[0])}
      }, &error), &error);
  must(logbrew_client_preview_json(client, &preview, &error), &error);
  if (strstr(preview, "\"type\":\"metric\"") == NULL ||
      strstr(preview, "\"name\":\"queue.depth\"") == NULL ||
      strstr(preview, "\"kind\":\"gauge\"") == NULL ||
      strstr(preview, "\"value\":42") == NULL ||
      strstr(preview, "\"unit\":\"{items}\"") == NULL ||
      strstr(preview, "\"temporality\":\"instant\"") == NULL ||
      strstr(preview, "\"queue\":\"checkout\"") == NULL ||
      strstr(preview, "\"sampled\":true") == NULL) {
    fprintf(stderr, "metric helper preview failed\n");
    exit(1);
  }
  logbrew_free_string(preview);

  status = logbrew_client_metric(client, "evt_bad_counter", "2026-06-02T10:00:06Z",
      (LogBrewMetricAttributes){"jobs.processed", "counter", -1.0, "1", "delta", {NULL, 0U}}, &error);
  if (status != LOGBREW_VALIDATION_ERROR || strcmp(error.code, "validation_error") != 0) {
    fprintf(stderr, "metric validation failure failed\n");
    exit(1);
  }
  logbrew_client_free(client);
}

int main(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingStep steps[] = {
    LOGBREW_RECORD_NETWORK_FAILURE("temporary network failure"),
    LOGBREW_RECORD_STATUS_CODE(503),
    LOGBREW_RECORD_STATUS_CODE(202)
  };
  LogBrewRecordingTransport transport;
  LogBrewTransportResponse response;
  LogBrewError error;
  char *preview = NULL;

  queue_events(client);
  must(logbrew_client_preview_json(client, &preview, &error), &error);
  printf("%s\n", preview);
  logbrew_free_string(preview);

  logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
  must(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error), &error);
  fprintf(stderr, "{\"ok\":true,\"status\":%d,\"retryAttempts\":%zu,\"sentBodies\":%zu}\n",
          response.status_code,
          response.attempts,
          logbrew_recording_transport_sent_count(&transport));
  logbrew_recording_transport_free(&transport);
  logbrew_client_free(client);

  exercise_timeline_helpers();
  exercise_metric_helper();
  exercise_failure_paths();
  return 0;
}
