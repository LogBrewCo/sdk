#include "logbrew.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int tests_run = 0;

#define EXPECT_TRUE(condition) do { \
  tests_run++; \
  if (!(condition)) { \
    fprintf(stderr, "test failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
    exit(1); \
  } \
} while (0)

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
  EXPECT_TRUE(logbrew_client_new(config, &client, &error) == LOGBREW_OK);
  EXPECT_TRUE(client != NULL);
  return client;
}

static void queue_fixture_events(LogBrewClient *client) {
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
  EXPECT_TRUE(logbrew_client_release(client, "evt_release_001", "2026-06-02T10:00:00Z",
      (LogBrewReleaseAttributes){"1.2.3", "abc123def456", "Public release marker"}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_environment(client, "evt_environment_001", "2026-06-02T10:00:01Z",
      (LogBrewEnvironmentAttributes){"production", "global"}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_issue(client, "evt_issue_001", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout timeout", "error", "Request timed out after retry budget"}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_log(client, "evt_log_001", "2026-06-02T10:00:03Z",
      (LogBrewLogAttributes){"worker started", "info", "job-runner"}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_span(client, "evt_span_001", "2026-06-02T10:00:04Z", span, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_action(client, "evt_action_001", "2026-06-02T10:00:05Z",
      (LogBrewActionAttributes){"deploy", "success"}, &error) == LOGBREW_OK);
}

static void preview_json_contains_all_supported_event_types(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  char *json = NULL;
  queue_fixture_events(client);
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_preview_json(client, &json, &error) == LOGBREW_OK);
  EXPECT_TRUE(strstr(json, "\"language\":\"c\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"release\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"environment\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"issue\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"log\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"span\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"action\"") != NULL);
  logbrew_free_string(json);
  logbrew_client_free(client);
}

static void flush_success_clears_queue(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingTransport recorder;
  LogBrewTransportResponse response;
  LogBrewError error;
  queue_fixture_events(client);
  logbrew_recording_transport_init(&recorder, NULL, 0U);
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&recorder), &response, &error) == LOGBREW_OK);
  EXPECT_TRUE(response.status_code == 202);
  EXPECT_TRUE(response.attempts == 1U);
  EXPECT_TRUE(logbrew_client_pending_events(client) == 0U);
  EXPECT_TRUE(logbrew_recording_transport_sent_count(&recorder) == 1U);
  EXPECT_TRUE(logbrew_recording_transport_last_body(&recorder) != NULL);
  logbrew_recording_transport_free(&recorder);
  logbrew_client_free(client);
}

static void empty_flush_is_no_op(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingTransport recorder;
  LogBrewTransportResponse response;
  LogBrewError error;
  logbrew_recording_transport_init(&recorder, NULL, 0U);
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&recorder), &response, &error) == LOGBREW_OK);
  EXPECT_TRUE(response.status_code == 204);
  EXPECT_TRUE(response.attempts == 0U);
  EXPECT_TRUE(logbrew_recording_transport_sent_count(&recorder) == 0U);
  logbrew_recording_transport_free(&recorder);
  logbrew_client_free(client);
}

static void validation_failures_are_stable(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  LogBrewStatus status;
  logbrew_error_clear(&error);
  status = logbrew_client_issue(client, "evt_issue_bad", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout timeout", "verbose", NULL}, &error);
  EXPECT_TRUE(status == LOGBREW_VALIDATION_ERROR);
  EXPECT_TRUE(strcmp(error.code, "validation_error") == 0);
  EXPECT_TRUE(logbrew_client_issue(client, "evt_issue_alias", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout timeout", "fatal", NULL}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_log(client, "evt_log_debug", "2026-06-02T10:00:03Z",
      (LogBrewLogAttributes){"verbose runtime detail", "debug", NULL}, &error) == LOGBREW_OK);
  char *preview = NULL;
  EXPECT_TRUE(logbrew_client_preview_json(client, &preview, &error) == LOGBREW_OK);
  EXPECT_TRUE(strstr(preview, "\"level\":\"critical\"") != NULL);
  EXPECT_TRUE(strstr(preview, "\"level\":\"info\"") != NULL);
  free(preview);
  status = logbrew_client_release(client, "evt_release_bad", "2026-06-02T10:00:00",
      (LogBrewReleaseAttributes){"1.2.3", NULL, NULL}, &error);
  EXPECT_TRUE(status == LOGBREW_VALIDATION_ERROR);
  EXPECT_TRUE(strcmp(error.code, "validation_error") == 0);
  logbrew_client_free(client);
}

static void product_timeline_helpers_capture_safe_metadata(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  char *json = NULL;
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
  LogBrewProductActionAttributes product_action = {
    "checkout.submit",
    "success",
    context,
    {metadata, sizeof(metadata) / sizeof(metadata[0])}
  };
  LogBrewNetworkMilestoneAttributes network = {
    "post",
    "https://api.example.com/api/checkout?sku=123#pay",
    503,
    true,
    184.5,
    true,
    context,
    {metadata, sizeof(metadata) / sizeof(metadata[0])}
  };
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_product_action(client, "evt_product_action_001", "2026-06-02T10:00:06Z",
      product_action, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_network_milestone(client, "evt_network_milestone_001", "2026-06-02T10:00:07Z",
      network, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_preview_json(client, &json, &error) == LOGBREW_OK);
  EXPECT_TRUE(strstr(json, "\"source\":\"c.action\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"source\":\"c.network\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"name\":\"POST /api/checkout\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"status\":\"failure\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"routeTemplate\":\"/api/checkout\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"durationMs\":184.5") != NULL);
  EXPECT_TRUE(strstr(json, "\"cartValue\":42.5") != NULL);
  EXPECT_TRUE(strstr(json, "\"retry\":false") != NULL);
  EXPECT_TRUE(strstr(json, "sku=") == NULL);
  EXPECT_TRUE(strstr(json, "#pay") == NULL);
  logbrew_free_string(json);
  logbrew_client_free(client);

  client = new_client();
  logbrew_error_clear(&error);
  network.status_code = 99;
  EXPECT_TRUE(logbrew_client_network_milestone(client, "evt_bad_status", "2026-06-02T10:00:07Z",
      network, &error) == LOGBREW_VALIDATION_ERROR);
  network.status_code = 200;
  network.duration_ms = -1.0;
  EXPECT_TRUE(logbrew_client_network_milestone(client, "evt_bad_duration", "2026-06-02T10:00:07Z",
      network, &error) == LOGBREW_VALIDATION_ERROR);
  network.duration_ms = NAN;
  EXPECT_TRUE(logbrew_client_network_milestone(client, "evt_nan_duration", "2026-06-02T10:00:07Z",
      network, &error) == LOGBREW_VALIDATION_ERROR);
  network.duration_ms = 1.0;
  network.route_template = "?sku=123";
  EXPECT_TRUE(logbrew_client_network_milestone(client, "evt_query_only", "2026-06-02T10:00:07Z",
      network, &error) == LOGBREW_VALIDATION_ERROR);
  product_action.metadata.entries = NULL;
  product_action.metadata.count = 1U;
  EXPECT_TRUE(logbrew_client_product_action(client, "evt_bad_metadata", "2026-06-02T10:00:06Z",
      product_action, &error) == LOGBREW_VALIDATION_ERROR);
  logbrew_client_free(client);
}

static void metric_helper_validates_and_serializes(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  char *json = NULL;
  LogBrewMetadataEntry metadata[] = {
    LOGBREW_METADATA_STRING_VALUE("queue", "checkout"),
    LOGBREW_METADATA_BOOL_VALUE("sampled", true)
  };
  LogBrewMetricAttributes metric = {
    "queue.depth",
    "gauge",
    42.0,
    "{items}",
    "instant",
    {metadata, sizeof(metadata) / sizeof(metadata[0])}
  };
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_metric(client, "evt_metric_001", "2026-06-02T10:00:06Z",
      metric, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_preview_json(client, &json, &error) == LOGBREW_OK);
  EXPECT_TRUE(strstr(json, "\"type\":\"metric\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"name\":\"queue.depth\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"kind\":\"gauge\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"value\":42") != NULL);
  EXPECT_TRUE(strstr(json, "\"unit\":\"{items}\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"temporality\":\"instant\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"metadata\":{\"queue\":\"checkout\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"sampled\":true") != NULL);
  logbrew_free_string(json);
  logbrew_client_free(client);

  client = new_client();
  metric.kind = "distribution";
  EXPECT_TRUE(logbrew_client_metric(client, "evt_bad_kind", "2026-06-02T10:00:06Z",
      metric, &error) == LOGBREW_VALIDATION_ERROR);
  metric.kind = "counter";
  metric.value = -1.0;
  metric.temporality = "delta";
  EXPECT_TRUE(logbrew_client_metric(client, "evt_bad_counter", "2026-06-02T10:00:06Z",
      metric, &error) == LOGBREW_VALIDATION_ERROR);
  metric.kind = "gauge";
  metric.value = 42.0;
  metric.temporality = "delta";
  EXPECT_TRUE(logbrew_client_metric(client, "evt_bad_temporality", "2026-06-02T10:00:06Z",
      metric, &error) == LOGBREW_VALIDATION_ERROR);
  metric.temporality = "instant";
  metric.value = NAN;
  EXPECT_TRUE(logbrew_client_metric(client, "evt_bad_value", "2026-06-02T10:00:06Z",
      metric, &error) == LOGBREW_VALIDATION_ERROR);
  metric.value = 42.0;
  metric.metadata.entries = NULL;
  metric.metadata.count = 1U;
  EXPECT_TRUE(logbrew_client_metric(client, "evt_bad_metadata", "2026-06-02T10:00:06Z",
      metric, &error) == LOGBREW_VALIDATION_ERROR);
  logbrew_client_free(client);
}

static void trace_context_helpers_validate_and_correlate(void) {
  static const char *incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
  LogBrewClient *client = new_client();
  LogBrewError error;
  LogBrewTraceContext context;
  LogBrewTraceContext fallback;
  LogBrewTraceContext nested;
  LogBrewTraceScope scope;
  LogBrewTraceScope nested_scope;
  LogBrewSpanAttributes span;
  LogBrewMetadataEntry trace_entries[LOGBREW_TRACE_METADATA_ENTRY_COUNT];
  LogBrewProductTimelineContext timeline_context = {
    "session_123",
    NULL,
    "/checkout?sku=123#pay",
    "Checkout",
    "checkout",
    "submit"
  };
  LogBrewMetadata trace_metadata;
  char traceparent[LOGBREW_TRACEPARENT_LENGTH + 1U];
  char *json = NULL;

  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_trace_context_from_traceparent(incoming, &context, &error) == LOGBREW_OK);
  EXPECT_TRUE(strcmp(context.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736") == 0);
  EXPECT_TRUE(strcmp(context.parent_span_id, "00f067aa0ba902b7") == 0);
  EXPECT_TRUE(strlen(context.span_id) == LOGBREW_SPAN_ID_LENGTH);
  EXPECT_TRUE(strcmp(context.span_id, context.parent_span_id) != 0);
  EXPECT_TRUE(context.sampled);
  EXPECT_TRUE(strcmp(context.trace_flags, "01") == 0);
  EXPECT_TRUE(logbrew_trace_create_headers(&context, traceparent, &error) == LOGBREW_OK);
  EXPECT_TRUE(strstr(traceparent, "00-4bf92f3577b34da6a3ce929d0e0e4736-") == traceparent);
  EXPECT_TRUE(strcmp(traceparent + 52, "-01") == 0);

  EXPECT_TRUE(logbrew_trace_context_from_traceparent("bad", &fallback, &error) == LOGBREW_VALIDATION_ERROR);
  EXPECT_TRUE(logbrew_trace_context_from_traceparent(
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01", &fallback, &error) == LOGBREW_VALIDATION_ERROR);
  EXPECT_TRUE(logbrew_trace_continue_or_create_context("bad", &fallback, &error) == LOGBREW_OK);
  EXPECT_TRUE(strlen(fallback.trace_id) == LOGBREW_TRACE_ID_LENGTH);
  EXPECT_TRUE(strlen(fallback.parent_span_id) == 0U);

  EXPECT_TRUE(logbrew_trace_scope_enter(&scope, &context, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_trace_current_context() != NULL);
  EXPECT_TRUE(strcmp(logbrew_trace_current_context()->trace_id, context.trace_id) == 0);
  EXPECT_TRUE(logbrew_trace_root_context(&nested, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_trace_scope_enter(&nested_scope, &nested, &error) == LOGBREW_OK);
  EXPECT_TRUE(strcmp(logbrew_trace_current_context()->trace_id, nested.trace_id) == 0);
  logbrew_trace_scope_exit(&nested_scope);
  EXPECT_TRUE(logbrew_trace_current_context() != NULL);
  EXPECT_TRUE(strcmp(logbrew_trace_current_context()->trace_id, context.trace_id) == 0);

  trace_metadata = logbrew_trace_metadata(&context, trace_entries);
  timeline_context = logbrew_trace_product_timeline_context(&context, timeline_context);
  EXPECT_TRUE(logbrew_trace_span_attributes(&context, "POST /checkout", "error", 37.5, true, &span, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_issue(client, "evt_trace_issue", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout failed", "error", "request failed"}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_log(client, "evt_trace_log", "2026-06-02T10:00:03Z",
      (LogBrewLogAttributes){"checkout failed", "warn", "checkout"}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_action(client, "evt_trace_action", "2026-06-02T10:00:04Z",
      (LogBrewActionAttributes){"checkout.submit", "failure"}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_span(client, "evt_trace_span", "2026-06-02T10:00:05Z", span, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_metric(client, "evt_trace_metric", "2026-06-02T10:00:06Z",
      (LogBrewMetricAttributes){"http.server.duration", "histogram", 37.5, "ms", "delta", trace_metadata}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_product_action(client, "evt_trace_product_action", "2026-06-02T10:00:07Z",
      (LogBrewProductActionAttributes){"checkout.submit", "failure", timeline_context, {NULL, 0U}}, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_preview_json(client, &json, &error) == LOGBREW_OK);
  EXPECT_TRUE(strstr(json, "\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e4736\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"parentSpanId\":\"00f067aa0ba902b7\"") != NULL);
  EXPECT_TRUE(strstr(json, context.span_id) != NULL);
  EXPECT_TRUE(strstr(json, "\"sampled\":true") != NULL);
  EXPECT_TRUE(strstr(json, "\"traceFlags\":\"01\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"metadata\":{\"traceId\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"issue\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"log\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"span\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"type\":\"metric\"") != NULL);
  EXPECT_TRUE(strstr(json, "traceparent") == NULL);
  EXPECT_TRUE(strstr(json, "sku=") == NULL);
  EXPECT_TRUE(strstr(json, "#pay") == NULL);
  logbrew_free_string(json);
  logbrew_trace_scope_exit(&scope);
  EXPECT_TRUE(logbrew_trace_current_context() == NULL);
  logbrew_client_free(client);
}

static void unauthenticated_response_surfaces_clean_error(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingStep steps[] = {LOGBREW_RECORD_STATUS_CODE(401)};
  LogBrewRecordingTransport recorder;
  LogBrewTransportResponse response;
  LogBrewError error;
  queue_fixture_events(client);
  logbrew_recording_transport_init(&recorder, steps, sizeof(steps) / sizeof(steps[0]));
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&recorder), &response, &error) == LOGBREW_TRANSPORT_ERROR);
  EXPECT_TRUE(strcmp(error.code, "unauthenticated") == 0);
  EXPECT_TRUE(logbrew_client_pending_events(client) == 6U);
  logbrew_recording_transport_free(&recorder);
  logbrew_client_free(client);
}

static void retry_recovery_and_retry_budget_are_observable(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingStep recover_steps[] = {
    LOGBREW_RECORD_NETWORK_FAILURE("temporary network failure"),
    LOGBREW_RECORD_STATUS_CODE(503),
    LOGBREW_RECORD_STATUS_CODE(202)
  };
  LogBrewRecordingTransport recorder;
  LogBrewTransportResponse response;
  LogBrewError error;
  queue_fixture_events(client);
  logbrew_recording_transport_init(&recorder, recover_steps, sizeof(recover_steps) / sizeof(recover_steps[0]));
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&recorder), &response, &error) == LOGBREW_OK);
  EXPECT_TRUE(response.status_code == 202);
  EXPECT_TRUE(response.attempts == 3U);
  EXPECT_TRUE(logbrew_recording_transport_sent_count(&recorder) == 3U);
  logbrew_recording_transport_free(&recorder);
  logbrew_client_free(client);

  client = new_client();
  queue_fixture_events(client);
  {
    LogBrewRecordingStep failure_steps[] = {
      LOGBREW_RECORD_NETWORK_FAILURE("first failure"),
      LOGBREW_RECORD_NETWORK_FAILURE("second failure"),
      LOGBREW_RECORD_NETWORK_FAILURE("third failure")
    };
    logbrew_recording_transport_init(&recorder, failure_steps, sizeof(failure_steps) / sizeof(failure_steps[0]));
    logbrew_error_clear(&error);
    EXPECT_TRUE(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&recorder), &response, &error) == LOGBREW_TRANSPORT_ERROR);
    EXPECT_TRUE(strcmp(error.code, "network_failure") == 0);
    EXPECT_TRUE(logbrew_recording_transport_sent_count(&recorder) == 3U);
    EXPECT_TRUE(logbrew_client_pending_events(client) == 6U);
    logbrew_recording_transport_free(&recorder);
  }
  logbrew_client_free(client);
}

static void non_retryable_status_and_shutdown_are_stable(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingStep status_steps[] = {LOGBREW_RECORD_STATUS_CODE(422)};
  LogBrewRecordingTransport recorder;
  LogBrewTransportResponse response;
  LogBrewError error;
  queue_fixture_events(client);
  logbrew_recording_transport_init(&recorder, status_steps, sizeof(status_steps) / sizeof(status_steps[0]));
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&recorder), &response, &error) == LOGBREW_TRANSPORT_ERROR);
  EXPECT_TRUE(strcmp(error.code, "transport_error") == 0);
  logbrew_recording_transport_free(&recorder);
  logbrew_client_free(client);

  client = new_client();
  queue_fixture_events(client);
  logbrew_recording_transport_init(&recorder, NULL, 0U);
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_client_shutdown(client, logbrew_recording_transport_as_transport(&recorder), &response, &error) == LOGBREW_OK);
  EXPECT_TRUE(logbrew_client_action(client, "evt_after_shutdown", "2026-06-02T10:00:05Z",
      (LogBrewActionAttributes){"deploy", "success"}, &error) == LOGBREW_SHUTDOWN_ERROR);
  EXPECT_TRUE(strcmp(error.code, "shutdown_error") == 0);
  logbrew_recording_transport_free(&recorder);
  logbrew_client_free(client);
}

#ifdef LOGBREW_C_TEST_HTTP_TRANSPORT
static void http_transport_validates_configuration(void) {
  LogBrewHttpTransport transport;
  LogBrewError error;
  LogBrewHttpHeader headers[] = {{"x-logbrew-source", "c-test"}};
  logbrew_error_clear(&error);
  EXPECT_TRUE(logbrew_http_transport_init(&transport, "ftp://example.com/v1/events", NULL, 0U, 1000L, &error) == LOGBREW_CONFIG_ERROR);
  EXPECT_TRUE(strcmp(error.code, "configuration_error") == 0);
  EXPECT_TRUE(logbrew_http_transport_init(&transport, "https://example.com/v1/events", NULL, 0U, 0L, &error) == LOGBREW_CONFIG_ERROR);
  headers[0].name = "authorization";
  EXPECT_TRUE(logbrew_http_transport_init(&transport, "https://example.com/v1/events", headers, 1U, 1000L, &error) == LOGBREW_CONFIG_ERROR);
  headers[0].name = "x-logbrew-source";
  EXPECT_TRUE(logbrew_http_transport_init(&transport, "https://example.com/v1/events", headers, 1U, 1000L, &error) == LOGBREW_OK);
  EXPECT_TRUE(strcmp(transport.endpoint, "https://example.com/v1/events") == 0);
  EXPECT_TRUE(transport.header_count == 1U);
  EXPECT_TRUE(strcmp(transport.headers[0].name, "x-logbrew-source") == 0);
  EXPECT_TRUE(strcmp(transport.headers[0].value, "c-test") == 0);
  logbrew_http_transport_free(&transport);
}
#endif

int main(void) {
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
#ifdef LOGBREW_C_TEST_HTTP_TRANSPORT
  http_transport_validates_configuration();
#endif
  printf("c package tests ok (%d checks)\n", tests_run);
  return 0;
}
