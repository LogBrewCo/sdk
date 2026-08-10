#include "logbrew.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int checks = 0;

#define EXPECT_TRUE(expression) \
  do { \
    checks++; \
    if (!(expression)) { \
      fprintf(stderr, "check failed at line %d: %s\n", __LINE__, #expression); \
      exit(1); \
    } \
  } while (0)

static void must(LogBrewStatus status, const LogBrewError *error) {
  if (status != LOGBREW_OK) {
    fprintf(stderr, "%s: %s\n", error->code, error->message);
    exit(1);
  }
}

static size_t count_occurrences(const char *text, const char *needle) {
  size_t count = 0U;
  size_t needle_length = strlen(needle);
  const char *cursor = text;
  while ((cursor = strstr(cursor, needle)) != NULL) {
    count++;
    cursor += needle_length;
  }
  return count;
}

static void test_validation_and_privacy(void) {
  LogBrewError error;
  LogBrewClient *client = NULL;
  char *json = NULL;
  LogBrewClientOptions client_options = {0};
  LogBrewTelemetryContext context = {0};
  LogBrewTelemetryTag tags[LOGBREW_MAX_CONTEXT_TAGS + 1U];
  char tag_keys[LOGBREW_MAX_CONTEXT_TAGS + 1U][24];
  size_t index;

  logbrew_error_clear(&error);
  client_options.disable_automatic_context = true;
  must(logbrew_client_new_with_options(
      (LogBrewConfig){"LOGBREW_API_KEY", "privacy-test", LOGBREW_C_VERSION, 1U},
      client_options, &client, &error), &error);
  must(logbrew_client_log(client, "evt_no_auto", "2026-08-06T09:00:00Z",
      (LogBrewLogAttributes){"automatic context disabled", "info", "test"}, &error), &error);
  must(logbrew_client_preview_json(client, &json, &error), &error);
  EXPECT_TRUE(strstr(json, "\"context\"") == NULL);
  logbrew_free_string(json);
  logbrew_client_free(client);
  client = NULL;

  context.schema_version = 0U;
  EXPECT_TRUE(logbrew_telemetry_context_validate(&context, &error) == LOGBREW_VALIDATION_ERROR);
  EXPECT_TRUE(strcmp(error.code, "validation_error") == 0);
  {
    LogBrewTelemetryScope empty_scope = LOGBREW_TELEMETRY_SCOPE_INIT;
    EXPECT_TRUE(logbrew_telemetry_scope_enter(
        &empty_scope, NULL, &error) == LOGBREW_CONFIG_ERROR);
  }

  for (index = 0U; index < LOGBREW_MAX_CONTEXT_TAGS + 1U; index++) {
    (void)snprintf(tag_keys[index], sizeof(tag_keys[index]), "tag.%02lu", (unsigned long)index);
    tags[index].key = tag_keys[index];
    tags[index].value = "bounded";
  }
  context.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
  context.tags = tags;
  context.tag_count = LOGBREW_MAX_CONTEXT_TAGS + 1U;
  EXPECT_TRUE(logbrew_telemetry_context_validate(&context, &error) == LOGBREW_VALIDATION_ERROR);

  context.tag_count = 2U;
  tags[1].key = tags[0].key;
  EXPECT_TRUE(logbrew_telemetry_context_validate(&context, &error) == LOGBREW_VALIDATION_ERROR);
  tags[1].key = tag_keys[1];

  {
    LogBrewSessionContext session = {"same", "same"};
    LogBrewTelemetryContext invalid_session = {0};
    invalid_session.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    invalid_session.session = &session;
    EXPECT_TRUE(logbrew_telemetry_context_validate(&invalid_session, &error) == LOGBREW_VALIDATION_ERROR);
  }
  {
    LogBrewTelemetryTraceContext trace = {
      "00000000000000000000000000000000", NULL, NULL, false, false
    };
    LogBrewTelemetryContext invalid_trace = {0};
    invalid_trace.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    invalid_trace.trace = &trace;
    EXPECT_TRUE(logbrew_telemetry_context_validate(&invalid_trace, &error) == LOGBREW_VALIDATION_ERROR);
  }
  {
    char service_name[32] = "deep-copy-service";
    char session_id[32] = "deep-copy-session";
    LogBrewNamedVersion service = {service_name, "1.0"};
    LogBrewTelemetryResource resource = {0};
    LogBrewTelemetryContext base = {0};
    LogBrewSessionContext session = {session_id, NULL};
    LogBrewTelemetryContext outer = {0};
    LogBrewSubjectContext subject = {"opaque_subject", LOGBREW_SUBJECT_ANONYMOUS};
    LogBrewTelemetryContext inner = {0};
    LogBrewTelemetryScope outer_scope = LOGBREW_TELEMETRY_SCOPE_INIT;
    LogBrewTelemetryScope inner_scope = LOGBREW_TELEMETRY_SCOPE_INIT;
    resource.service = &service;
    base.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    base.resource = &resource;
    client_options.context = &base;
    client_options.disable_automatic_context = true;
    must(logbrew_client_new_with_options(
        (LogBrewConfig){"LOGBREW_API_KEY", "copy-test", LOGBREW_C_VERSION, 1U},
        client_options, &client, &error), &error);
    (void)snprintf(service_name, sizeof(service_name), "%s", "mutated-service");
    outer.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    outer.session = &session;
    must(logbrew_telemetry_scope_enter(&outer_scope, &outer, &error), &error);
    (void)snprintf(session_id, sizeof(session_id), "%s", "mutated-session");
    inner.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    inner.subject = &subject;
    must(logbrew_telemetry_scope_enter(&inner_scope, &inner, &error), &error);
    EXPECT_TRUE(logbrew_telemetry_scope_enter(&outer_scope, &outer, &error) == LOGBREW_CONFIG_ERROR);
    logbrew_telemetry_scope_exit(&outer_scope);
    must(logbrew_client_action(client, "evt_nested_scope", "2026-08-06T09:01:00Z",
        (LogBrewActionAttributes){"job.execute", "success"}, &error), &error);
    logbrew_telemetry_scope_exit(&inner_scope);
    logbrew_telemetry_scope_exit(&outer_scope);
    must(logbrew_client_preview_json(client, &json, &error), &error);
    EXPECT_TRUE(strstr(json, "deep-copy-service") != NULL);
    EXPECT_TRUE(strstr(json, "mutated-service") == NULL);
    EXPECT_TRUE(strstr(json, "deep-copy-session") != NULL);
    EXPECT_TRUE(strstr(json, "mutated-session") == NULL);
    EXPECT_TRUE(strstr(json, "opaque_subject") != NULL);
    logbrew_free_string(json);
    logbrew_client_free(client);
    client = NULL;
  }
  {
    LogBrewSpanEvent too_many[LOGBREW_MAX_SPAN_EVENTS + 1U];
    LogBrewSpanEvidence evidence = {0};
    LogBrewIssueStackFrame too_many_frames[LOGBREW_MAX_STACK_FRAMES + 1U];
    LogBrewIssueDetails details = {0};
    LogBrewIssueStackFrame absolute_frame = {0};
    LogBrewIssueStackFrame helper_frame = {0};
    LogBrewIssueStackFrame copied_frame = {0};
    LogBrewIssueMechanism mismatch_mechanism = {"manual", true};
    LogBrewIssueException mismatch_exception = {"ExpectedError", &mismatch_mechanism};
    LogBrewIssueExceptionChainEntry mismatch_entry = {0};
    LogBrewIssueExceptionChain mismatch_chain = {0};
    LogBrewMetadataEntry duplicates[] = {
      LOGBREW_METADATA_STRING_VALUE("duplicate", "one"),
      LOGBREW_METADATA_STRING_VALUE("duplicate", "two")
    };
    LogBrewEventOptions duplicate_options = {0};
    LogBrewIssueBreadcrumb invalid_breadcrumb = {0};
    LogBrewIssueBreadcrumb minimal_breadcrumb = {0};
    memset(too_many, 0, sizeof(too_many));
    memset(too_many_frames, 0, sizeof(too_many_frames));
    client_options.context = NULL;
    client_options.disable_automatic_context = true;
    must(logbrew_client_new_with_options(
        (LogBrewConfig){"LOGBREW_API_KEY", "bounds-test", LOGBREW_C_VERSION, 1U},
        client_options, &client, &error), &error);
    evidence.events = too_many;
    evidence.event_count = LOGBREW_MAX_SPAN_EVENTS + 1U;
    EXPECT_TRUE(logbrew_client_span_with_evidence(
        client, "evt_too_many_events", "2026-08-06T09:02:00Z",
        (LogBrewSpanAttributes){"bounded", "trace", "span", NULL, "ok", 0.0, false},
        evidence, LOGBREW_EVENT_OPTIONS_NONE, &error) == LOGBREW_VALIDATION_ERROR);
    details.stack_frames = too_many_frames;
    details.stack_frame_count = LOGBREW_MAX_STACK_FRAMES + 1U;
    EXPECT_TRUE(logbrew_client_issue_with_details(
        client, "evt_too_many_frames", "2026-08-06T09:02:01Z",
        (LogBrewIssueAttributes){"bounded", "error", NULL}, details,
        LOGBREW_EVENT_OPTIONS_NONE, &error) == LOGBREW_VALIDATION_ERROR);
    absolute_frame.filename = "/workspace/source.c";
    absolute_frame.line = 1U;
    absolute_frame.column = 1U;
    details.stack_frames = &absolute_frame;
    details.stack_frame_count = 1U;
    EXPECT_TRUE(logbrew_client_issue_with_details(
        client, "evt_absolute_frame", "2026-08-06T09:02:02Z",
        (LogBrewIssueAttributes){"bounded", "error", NULL}, details,
        LOGBREW_EVENT_OPTIONS_NONE, &error) == LOGBREW_VALIDATION_ERROR);
    EXPECT_TRUE(logbrew_issue_frame_from_location(
        "source.c", 0U, 1U, NULL, NULL, true, &absolute_frame, &error) == LOGBREW_VALIDATION_ERROR);
    must(logbrew_issue_frame_from_location(
        "/workspace/source/copied.c?redaction_canary=value", 7U, 2U,
        "copied_frame", "checkout.copy", true, &helper_frame, &error), &error);
    copied_frame = helper_frame;
    memset(&helper_frame, 0, sizeof(helper_frame));
    details.stack_frames = &copied_frame;
    details.stack_frame_count = 1U;
    must(logbrew_client_issue_with_details(
        client, "evt_copied_frame", "2026-08-06T09:02:03Z",
        (LogBrewIssueAttributes){"copy-safe frame", "error", NULL}, details,
        LOGBREW_EVENT_OPTIONS_NONE, &error), &error);
    mismatch_entry.type = "DifferentError";
    mismatch_entry.mechanism = &mismatch_mechanism;
    mismatch_entry.stack_frames = &copied_frame;
    mismatch_entry.stack_frame_count = 1U;
    mismatch_entry.stack_frames_state = LOGBREW_EXCEPTION_STACK_CAPTURED;
    mismatch_chain.entries = &mismatch_entry;
    mismatch_chain.entry_count = 1U;
    details.exception = &mismatch_exception;
    details.exception_chain = &mismatch_chain;
    EXPECT_TRUE(logbrew_client_issue_with_details(
        client, "evt_mismatched_chain", "2026-08-06T09:02:03Z",
        (LogBrewIssueAttributes){"mismatched chain", "error", NULL}, details,
        LOGBREW_EVENT_OPTIONS_NONE, &error) == LOGBREW_VALIDATION_ERROR);
    duplicate_options.metadata.entries = duplicates;
    duplicate_options.metadata.count = sizeof(duplicates) / sizeof(duplicates[0]);
    EXPECT_TRUE(logbrew_client_release_with_options(
        client, "evt_duplicate_metadata", "2026-08-06T09:02:03Z",
        (LogBrewReleaseAttributes){"1.0", NULL, NULL}, duplicate_options, &error) == LOGBREW_VALIDATION_ERROR);
    invalid_breadcrumb.timestamp = "2026-08-06T09:02:04Z";
    invalid_breadcrumb.category = "bad category";
    EXPECT_TRUE(logbrew_client_add_breadcrumb(client, invalid_breadcrumb, &error) == LOGBREW_VALIDATION_ERROR);
    minimal_breadcrumb.timestamp = "2026-08-06T09:02:05Z";
    minimal_breadcrumb.category = "job.step";
    must(logbrew_client_add_breadcrumb(client, minimal_breadcrumb, &error), &error);
    logbrew_client_clear_breadcrumbs(client);
    must(logbrew_client_issue(client, "evt_cleared_breadcrumbs", "2026-08-06T09:02:06Z",
        (LogBrewIssueAttributes){"cleared", "warning", NULL}, &error), &error);
    must(logbrew_client_preview_json(client, &json, &error), &error);
    EXPECT_TRUE(strstr(json, "\"breadcrumbs\"") == NULL);
    logbrew_free_string(json);
    logbrew_client_free(client);
    client = NULL;
  }
  {
    LogBrewTelemetryContext base = {0};
    LogBrewTelemetryTag event_tag = {"overflow", "event"};
    LogBrewTelemetryContext event_context = {0};
    LogBrewEventOptions event_options = {0};
    for (index = 0U; index < LOGBREW_MAX_CONTEXT_TAGS; index++) {
      tags[index].key = tag_keys[index];
    }
    base.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    base.tags = tags;
    base.tag_count = LOGBREW_MAX_CONTEXT_TAGS;
    client_options.context = &base;
    client_options.disable_automatic_context = true;
    must(logbrew_client_new_with_options(
        (LogBrewConfig){"LOGBREW_API_KEY", "merge-bound-test", LOGBREW_C_VERSION, 1U},
        client_options, &client, &error), &error);
    event_context.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    event_context.tags = &event_tag;
    event_context.tag_count = 1U;
    event_options.context = &event_context;
    EXPECT_TRUE(logbrew_client_release_with_options(
        client, "evt_context_overflow", "2026-08-06T09:03:00Z",
        (LogBrewReleaseAttributes){"1.0", NULL, NULL}, event_options, &error) == LOGBREW_VALIDATION_ERROR);
    logbrew_client_free(client);
  }
  {
    LogBrewSpanAttributes signal_span = {
      "worker.execute",
      "11111111111111111111111111111111",
      "2222222222222222",
      "3333333333333333",
      "ok",
      3.5,
      true
    };
    client_options.context = NULL;
    client_options.disable_automatic_context = true;
    must(logbrew_client_new_with_options(
        (LogBrewConfig){"LOGBREW_API_KEY", "signal-span-test", LOGBREW_C_VERSION, 1U},
        client_options, &client, &error), &error);
    must(logbrew_client_span(
        client, "evt_signal_span", "2026-08-06T09:03:30Z", signal_span, &error), &error);
    must(logbrew_client_preview_json(client, &json, &error), &error);
    EXPECT_TRUE(strstr(json,
        "\"context\":{\"schemaVersion\":1,\"trace\":{"
        "\"traceId\":\"11111111111111111111111111111111\","
        "\"spanId\":\"2222222222222222\","
        "\"parentSpanId\":\"3333333333333333\"}}") != NULL);
    logbrew_free_string(json);
    logbrew_client_free(client);
  }
  {
    char oversized_key[LOGBREW_MAX_METADATA_KEY_LENGTH + 2U];
    char oversized_value[LOGBREW_MAX_METADATA_STRING_LENGTH + 2U];
    LogBrewMetadataEntry entry = {0};
    LogBrewEventOptions bounded_options = {0};
    memset(oversized_key, 'k', sizeof(oversized_key) - 1U);
    oversized_key[sizeof(oversized_key) - 1U] = '\0';
    memset(oversized_value, 'v', sizeof(oversized_value) - 1U);
    oversized_value[sizeof(oversized_value) - 1U] = '\0';
    client_options.context = NULL;
    client_options.disable_automatic_context = true;
    must(logbrew_client_new_with_options(
        (LogBrewConfig){"LOGBREW_API_KEY", "metadata-bounds-test", LOGBREW_C_VERSION, 1U},
        client_options, &client, &error), &error);
    entry = LOGBREW_METADATA_STRING_VALUE(oversized_key, "value");
    bounded_options.metadata = (LogBrewMetadata){&entry, 1U};
    EXPECT_TRUE(logbrew_client_release_with_options(
        client, "evt_oversized_key", "2026-08-06T09:03:40Z",
        (LogBrewReleaseAttributes){"1.0", NULL, NULL}, bounded_options,
        &error) == LOGBREW_VALIDATION_ERROR);
    entry = LOGBREW_METADATA_STRING_VALUE("boundedKey", oversized_value);
    EXPECT_TRUE(logbrew_client_release_with_options(
        client, "evt_oversized_value", "2026-08-06T09:03:41Z",
        (LogBrewReleaseAttributes){"1.0", NULL, NULL}, bounded_options,
        &error) == LOGBREW_VALIDATION_ERROR);
    bounded_options.metadata.count = LOGBREW_MAX_METADATA_ENTRIES + 1U;
    EXPECT_TRUE(logbrew_client_release_with_options(
        client, "evt_oversized_count", "2026-08-06T09:03:42Z",
        (LogBrewReleaseAttributes){"1.0", NULL, NULL}, bounded_options,
        &error) == LOGBREW_VALIDATION_ERROR);
    logbrew_client_free(client);
  }
  {
    LogBrewMetadataEntry base_metadata[] = {
      LOGBREW_METADATA_STRING_VALUE("custom", "base"),
      LOGBREW_METADATA_STRING_VALUE("analyticsKind", "untrusted")
    };
    LogBrewMetadataEntry override_metadata[] = {
      LOGBREW_METADATA_STRING_VALUE("custom", "override"),
      LOGBREW_METADATA_NULL_VALUE("upstream"),
      LOGBREW_METADATA_STRING_VALUE("source", "untrusted-source"),
      LOGBREW_METADATA_STRING_VALUE("traceId", "untrusted-trace"),
      LOGBREW_METADATA_STRING_VALUE("routeTemplate", "untrusted-route"),
      LOGBREW_METADATA_STRING_VALUE("method", "untrusted-method"),
      LOGBREW_METADATA_NUMBER_VALUE("statusCode", 299.0)
    };
    LogBrewSubjectContext subject = {"opaque_timeline_subject", LOGBREW_SUBJECT_USER};
    LogBrewTelemetryContext event_context = {0};
    LogBrewEventOptions event_options = {0};
    LogBrewProductTimelineContext timeline = {
      "opaque_session", "canonical_timeline_trace", "/checkout/{id}", "Checkout", "checkout", "submit"
    };
    LogBrewProductActionAttributes action = {
      "checkout.submit", "success", timeline,
      {base_metadata, sizeof(base_metadata) / sizeof(base_metadata[0])}
    };
    LogBrewNetworkMilestoneAttributes network = {
      "post", "https://api.example.test/payments/{id}?redaction_canary=value", 503, true, 42.0, true,
      timeline, {base_metadata, sizeof(base_metadata) / sizeof(base_metadata[0])}
    };
    client_options.context = NULL;
    client_options.disable_automatic_context = true;
    must(logbrew_client_new_with_options(
        (LogBrewConfig){"LOGBREW_API_KEY", "timeline-options-test", LOGBREW_C_VERSION, 1U},
        client_options, &client, &error), &error);
    event_context.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
    event_context.subject = &subject;
    event_options.metadata.entries = override_metadata;
    event_options.metadata.count = sizeof(override_metadata) / sizeof(override_metadata[0]);
    event_options.context = &event_context;
    must(logbrew_client_product_action_with_options(
        client, "evt_product_options", "2026-08-06T09:04:00Z", action, event_options, &error), &error);
    must(logbrew_client_network_milestone_with_options(
        client, "evt_network_options", "2026-08-06T09:04:01Z", network, event_options, &error), &error);
    must(logbrew_client_preview_json(client, &json, &error), &error);
    EXPECT_TRUE(count_occurrences(json, "\"custom\":\"override\"") == 2U);
    EXPECT_TRUE(strstr(json, "\"custom\":\"base\"") == NULL);
    EXPECT_TRUE(count_occurrences(json, "\"analyticsKind\":\"interaction\"") == 1U);
    EXPECT_TRUE(count_occurrences(json, "\"traceId\":\"canonical_timeline_trace\"") == 2U);
    EXPECT_TRUE(count_occurrences(json, "\"source\":\"c.action\"") == 1U);
    EXPECT_TRUE(count_occurrences(json, "\"source\":\"c.network\"") == 1U);
    EXPECT_TRUE(count_occurrences(json, "\"method\":\"POST\"") == 1U);
    EXPECT_TRUE(count_occurrences(json, "\"statusCode\":503") == 1U);
    EXPECT_TRUE(strstr(json, "\"statusCode\":299") == NULL);
    EXPECT_TRUE(strstr(json, "untrusted") == NULL);
    EXPECT_TRUE(count_occurrences(json, "\"upstream\":null") == 2U);
    EXPECT_TRUE(count_occurrences(json, "opaque_timeline_subject") == 2U);
    EXPECT_TRUE(strstr(json, "redaction_canary=value") == NULL);
    logbrew_free_string(json);
    logbrew_client_free(client);
  }
}

int main(void) {
  LogBrewError error;
  LogBrewClient *client = NULL;
  char *json = NULL;
  LogBrewNamedVersion service = {"checkout-api", "2.4.0"};
  LogBrewDeploymentContext deployment = {"production", "checkout@2.4.0"};
  LogBrewApplicationContext application = {"checkout-worker", "2.4.0", "204"};
  LogBrewTelemetryResource resource = {0};
  LogBrewTelemetryTag base_tags[] = {{"region", "eu-west"}, {"tier", "payments"}};
  LogBrewTelemetryContext base_context = {0};
  LogBrewClientOptions client_options = {0};
  LogBrewSessionContext session = {"session_opaque_02", "session_opaque_01"};
  LogBrewTelemetryTag scoped_tags[] = {{"region", "eu-central"}, {"feature.checkout", "v2"}};
  LogBrewTelemetryContext scoped_context = {0};
  LogBrewTelemetryScope telemetry_scope = LOGBREW_TELEMETRY_SCOPE_INIT;
  LogBrewTraceContext trace;
  LogBrewTraceScope trace_scope;
  LogBrewSubjectContext subject = {"subject_sha256_abc123", LOGBREW_SUBJECT_USER};
  LogBrewTelemetryTag event_tags[] = {{"region", "eu-north"}, {"failure.domain", "payment"}};
  LogBrewTelemetryContext event_context = {0};
  LogBrewMetadataEntry issue_metadata[] = {
    LOGBREW_METADATA_STRING_VALUE("retryStage", "authorization"),
    LOGBREW_METADATA_BOOL_VALUE("retryable", false),
    LOGBREW_METADATA_NULL_VALUE("upstreamCode")
  };
  LogBrewEventOptions issue_options = {0};
  LogBrewIssueMechanism mechanism = {"signal", false};
  LogBrewIssueException exception = {"PaymentDeclined", &mechanism};
  LogBrewIssueStackFrame frames[2] = {0};
  LogBrewIssueMechanism cause_mechanism = {"c.cause", true};
  LogBrewIssueExceptionChainEntry exception_chain_entries[2] = {0};
  LogBrewIssueExceptionChain exception_chain = {0};
  LogBrewMetadataEntry breadcrumb_data[] = {
    LOGBREW_METADATA_STRING_VALUE("route", "/checkout/{id}"),
    LOGBREW_METADATA_NUMBER_VALUE("attempt", 2.0)
  };
  LogBrewIssueBreadcrumb explicit_breadcrumb = {0};
  LogBrewIssueDetails issue_details = {0};
  LogBrewSpanEvent span_event = {0};
  LogBrewSpanLink span_link = {0};
  LogBrewSpanEvidence span_evidence = {0};
  LogBrewEventOptions empty_options = LOGBREW_EVENT_OPTIONS_NONE;
  size_t index;

  logbrew_error_clear(&error);
  test_validation_and_privacy();
  resource.service = &service;
  resource.deployment = &deployment;
  resource.application = &application;
  base_context.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
  base_context.resource = &resource;
  base_context.tags = base_tags;
  base_context.tag_count = sizeof(base_tags) / sizeof(base_tags[0]);
  client_options.context = &base_context;
  must(logbrew_client_new_with_options(
      (LogBrewConfig){"LOGBREW_API_KEY", "rich-c-app", LOGBREW_C_VERSION, 2U},
      client_options,
      &client,
      &error), &error);

  scoped_context.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
  scoped_context.session = &session;
  scoped_context.tags = scoped_tags;
  scoped_context.tag_count = sizeof(scoped_tags) / sizeof(scoped_tags[0]);
  must(logbrew_telemetry_scope_enter(&telemetry_scope, &scoped_context, &error), &error);
  must(logbrew_trace_context_from_traceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", &trace, &error), &error);
  must(logbrew_trace_scope_enter(&trace_scope, &trace, &error), &error);

  for (index = 0U; index < LOGBREW_MAX_BREADCRUMBS + 1U; index++) {
    char timestamp[32];
    LogBrewIssueBreadcrumb breadcrumb = {0};
    (void)snprintf(timestamp, sizeof(timestamp), "2026-08-06T10:00:%02luZ", (unsigned long)(index % 60U));
    breadcrumb.timestamp = timestamp;
    breadcrumb.type = "navigation";
    breadcrumb.category = "checkout.step";
    breadcrumb.level = "info";
    breadcrumb.message = "advanced to next checkout step";
    must(logbrew_client_add_breadcrumb(client, breadcrumb, &error), &error);
  }

  subject.kind = LOGBREW_SUBJECT_USER;
  event_context.schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION;
  event_context.subject = &subject;
  event_context.tags = event_tags;
  event_context.tag_count = sizeof(event_tags) / sizeof(event_tags[0]);
  issue_options.metadata.entries = issue_metadata;
  issue_options.metadata.count = sizeof(issue_metadata) / sizeof(issue_metadata[0]);
  issue_options.context = &event_context;

  must(logbrew_issue_frame_from_location(
      "/workspace/source/checkout.c?redaction_canary=value#fragment",
      413U,
      9U,
      "authorize_payment",
      "checkout.payment",
      true,
      &frames[0],
      &error), &error);
  frames[1].filename = "src/retry.c";
  frames[1].line = 88U;
  frames[1].column = 4U;
  frames[1].function = "retry_authorization";
  frames[1].module = "checkout.retry";
  frames[1].has_in_app = true;
  frames[1].in_app = true;

  explicit_breadcrumb.timestamp = "2026-08-06T10:01:05.123Z";
  explicit_breadcrumb.type = "http";
  explicit_breadcrumb.category = "payment.request";
  explicit_breadcrumb.level = "error";
  explicit_breadcrumb.message = "authorization returned a terminal response";
  explicit_breadcrumb.data.entries = breadcrumb_data;
  explicit_breadcrumb.data.count = sizeof(breadcrumb_data) / sizeof(breadcrumb_data[0]);
  issue_details.exception = &exception;
  issue_details.stack_frames = frames;
  issue_details.stack_frame_count = sizeof(frames) / sizeof(frames[0]);
  exception_chain_entries[0].type = "PaymentDeclined";
  exception_chain_entries[0].mechanism = &mechanism;
  exception_chain_entries[0].message_state = LOGBREW_EXCEPTION_MESSAGE_REDACTED;
  exception_chain_entries[0].module = "checkout.payment";
  exception_chain_entries[0].stack_frames = frames;
  exception_chain_entries[0].stack_frame_count = sizeof(frames) / sizeof(frames[0]);
  exception_chain_entries[0].stack_frames_state = LOGBREW_EXCEPTION_STACK_CAPTURED;
  exception_chain_entries[1].id = 1U;
  exception_chain_entries[1].parent_id = 0U;
  exception_chain_entries[1].has_parent_id = true;
  exception_chain_entries[1].relationship = LOGBREW_EXCEPTION_RELATIONSHIP_CAUSE;
  exception_chain_entries[1].type = "GatewayRejected";
  exception_chain_entries[1].message = "provider rejected the authorization";
  exception_chain_entries[1].message_state = LOGBREW_EXCEPTION_MESSAGE_CAPTURED;
  exception_chain_entries[1].mechanism = &cause_mechanism;
  exception_chain_entries[1].stack_frames_state = LOGBREW_EXCEPTION_STACK_NOT_CAPTURED;
  exception_chain.entries = exception_chain_entries;
  exception_chain.entry_count = sizeof(exception_chain_entries) / sizeof(exception_chain_entries[0]);
  issue_details.exception_chain = &exception_chain;
  issue_details.breadcrumbs = &explicit_breadcrumb;
  issue_details.breadcrumb_count = 1U;

  must(logbrew_client_issue_with_details(
      client,
      "evt_issue_rich_001",
      "2026-08-06T10:01:06Z",
      (LogBrewIssueAttributes){"Payment authorization failed", "error", "Checkout could not authorize payment"},
      issue_details,
      issue_options,
      &error), &error);

  span_event.name = "payment.authorization.rejected";
  span_event.timestamp = "2026-08-06T10:01:05.900Z";
  span_event.metadata.entries = breadcrumb_data;
  span_event.metadata.count = sizeof(breadcrumb_data) / sizeof(breadcrumb_data[0]);
  span_link.trace_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  span_link.span_id = "bbbbbbbbbbbbbbbb";
  span_link.has_sampled = true;
  span_link.sampled = false;
  span_evidence.events = &span_event;
  span_evidence.event_count = 1U;
  span_evidence.links = &span_link;
  span_evidence.link_count = 1U;
  must(logbrew_client_span_with_evidence(
      client,
      "evt_span_rich_001",
      "2026-08-06T10:01:07Z",
      (LogBrewSpanAttributes){
        "POST /payments/{id}/authorize",
        trace.trace_id,
        trace.span_id,
        trace.parent_span_id,
        "error",
        184.5,
        true
      },
      span_evidence,
      empty_options,
      &error), &error);

  must(logbrew_client_release_with_options(client, "evt_release_rich_001", "2026-08-06T10:01:08Z",
      (LogBrewReleaseAttributes){"2.4.0", "abc123", "payment diagnostics"}, empty_options, &error), &error);
  must(logbrew_client_environment_with_options(client, "evt_environment_rich_001", "2026-08-06T10:01:09Z",
      (LogBrewEnvironmentAttributes){"production", "eu"}, empty_options, &error), &error);
  must(logbrew_client_log_with_options(client, "evt_log_rich_001", "2026-08-06T10:01:10Z",
      (LogBrewLogAttributes){"authorization rejected", "warning", "payment"}, empty_options, &error), &error);
  must(logbrew_client_action_with_options(client, "evt_action_rich_001", "2026-08-06T10:01:11Z",
      (LogBrewActionAttributes){"checkout.submit", "failure"}, empty_options, &error), &error);
  must(logbrew_client_metric_with_options(client, "evt_metric_rich_001", "2026-08-06T10:01:12Z",
      (LogBrewMetricAttributes){"payment.authorization.failures", "counter", 1.0, "{failure}", "delta", {NULL, 0U}, NULL},
      empty_options, &error), &error);

  must(logbrew_client_preview_json(client, &json, &error), &error);
  EXPECT_TRUE(strstr(json, "\"schemaVersion\":1") != NULL);
  EXPECT_TRUE(strstr(json, "\"runtime\":{\"name\":\"c\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"service\":{\"name\":\"checkout-api\",\"version\":\"2.4.0\"}") != NULL);
  EXPECT_TRUE(strstr(json, "\"environment\":\"production\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"session\":{\"id\":\"session_opaque_02\",\"previousId\":\"session_opaque_01\"}") != NULL);
  EXPECT_TRUE(strstr(json, "\"subject\":{\"id\":\"subject_sha256_abc123\",\"kind\":\"user\"}") != NULL);
  EXPECT_TRUE(strstr(json, "\"region\":\"eu-north\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e4736\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"exception\":{\"type\":\"PaymentDeclined\",\"mechanism\":{\"type\":\"signal\",\"handled\":false}}") != NULL);
  EXPECT_TRUE(strstr(json, "\"exceptionChain\":{\"entries\":[{\"id\":0,\"relationship\":\"reported\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"relationship\":\"cause\",\"type\":\"GatewayRejected\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"messageState\":\"redacted\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"messageState\":\"captured\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"stackFramesState\":\"not_captured\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"filename\":\"checkout.c\"") != NULL);
  EXPECT_TRUE(strstr(json, "source/checkout.c") == NULL);
  EXPECT_TRUE(strstr(json, "redaction_canary=value") == NULL);
  EXPECT_TRUE(strstr(json, "\"breadcrumbsTruncated\":true") != NULL);
  EXPECT_TRUE(strstr(json, "\"events\":[{\"name\":\"payment.authorization.rejected\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"links\":[{\"traceId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"") != NULL);
  EXPECT_TRUE(strstr(json, "\"upstreamCode\":null") != NULL);
  EXPECT_TRUE(strstr(json, "evt_release_rich_001") != NULL);
  EXPECT_TRUE(strstr(json, "evt_environment_rich_001") != NULL);
  EXPECT_TRUE(strstr(json, "evt_log_rich_001") != NULL);
  EXPECT_TRUE(strstr(json, "evt_action_rich_001") != NULL);
  EXPECT_TRUE(strstr(json, "evt_metric_rich_001") != NULL);

  puts(json);
  fprintf(stderr, "c rich telemetry tests passed: %d checks\n", checks);
  logbrew_free_string(json);
  logbrew_trace_scope_exit(&trace_scope);
  logbrew_telemetry_scope_exit(&telemetry_scope);
  logbrew_client_free(client);
  return 0;
}
