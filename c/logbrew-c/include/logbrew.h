#ifndef LOGBREW_H
#define LOGBREW_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LOGBREW_C_VERSION "0.2.1"
#define LOGBREW_HTTP_TRANSPORT_DEFAULT_ENDPOINT "https://api.logbrew.co/v1/events"

typedef enum {
  LOGBREW_OK = 0,
  LOGBREW_CONFIG_ERROR = 1,
  LOGBREW_VALIDATION_ERROR = 2,
  LOGBREW_ALLOCATION_ERROR = 3,
  LOGBREW_SERIALIZATION_ERROR = 4,
  LOGBREW_TRANSPORT_ERROR = 5,
  LOGBREW_SHUTDOWN_ERROR = 6
} LogBrewStatus;

typedef struct {
  char code[64];
  char message[256];
  bool retryable;
} LogBrewError;

typedef struct {
  int status_code;
  size_t attempts;
} LogBrewTransportResponse;

typedef LogBrewStatus (*LogBrewSendFn)(
    void *user_data,
    const char *api_key,
    const char *body,
    LogBrewTransportResponse *response,
    LogBrewError *error);

typedef struct {
  LogBrewSendFn send;
  void *user_data;
} LogBrewTransport;

typedef struct {
  const char *name;
  const char *value;
} LogBrewHttpHeader;

typedef struct {
  char *endpoint;
  LogBrewHttpHeader *headers;
  size_t header_count;
  long timeout_ms;
} LogBrewHttpTransport;

typedef struct {
  const char *api_key;
  const char *sdk_name;
  const char *sdk_version;
  size_t max_retries;
} LogBrewConfig;

typedef struct LogBrewClient LogBrewClient;

typedef struct {
  const char *version;
  const char *commit;
  const char *notes;
} LogBrewReleaseAttributes;

typedef struct {
  const char *name;
  const char *region;
} LogBrewEnvironmentAttributes;

typedef struct {
  const char *title;
  const char *level;
  const char *message;
} LogBrewIssueAttributes;

typedef struct {
  const char *message;
  const char *level;
  const char *logger;
} LogBrewLogAttributes;

typedef struct {
  const char *name;
  const char *trace_id;
  const char *span_id;
  const char *parent_span_id;
  const char *status;
  double duration_ms;
  bool has_duration_ms;
} LogBrewSpanAttributes;

typedef struct {
  const char *name;
  const char *status;
} LogBrewActionAttributes;

#define LOGBREW_TRACE_ID_LENGTH 32U
#define LOGBREW_SPAN_ID_LENGTH 16U
#define LOGBREW_TRACE_FLAGS_LENGTH 2U
#define LOGBREW_TRACEPARENT_LENGTH 55U
#define LOGBREW_TRACE_METADATA_ENTRY_COUNT 5U
#define LOGBREW_HTTP_CLIENT_SPAN_NAME_LENGTH 192U

typedef enum {
  LOGBREW_METADATA_STRING,
  LOGBREW_METADATA_NUMBER,
  LOGBREW_METADATA_BOOL,
  LOGBREW_METADATA_NULL
} LogBrewMetadataValueKind;

typedef struct {
  const char *key;
  LogBrewMetadataValueKind kind;
  const char *string_value;
  double number_value;
  bool bool_value;
} LogBrewMetadataEntry;

typedef struct {
  const LogBrewMetadataEntry *entries;
  size_t count;
} LogBrewMetadata;

typedef struct {
  char trace_id[LOGBREW_TRACE_ID_LENGTH + 1U];
  char span_id[LOGBREW_SPAN_ID_LENGTH + 1U];
  char parent_span_id[LOGBREW_SPAN_ID_LENGTH + 1U];
  char trace_flags[LOGBREW_TRACE_FLAGS_LENGTH + 1U];
  bool sampled;
} LogBrewTraceContext;

typedef struct {
  const char *trace_id;
  const char *span_id;
  const char *trace_flags;
} LogBrewOpenTelemetrySpanContext;

typedef struct {
  LogBrewTraceContext context;
  const LogBrewTraceContext *previous;
  bool active;
  const void *owner;
} LogBrewTraceScope;

typedef struct {
  LogBrewTraceContext trace;
  char traceparent[LOGBREW_TRACEPARENT_LENGTH + 1U];
  char name[LOGBREW_HTTP_CLIENT_SPAN_NAME_LENGTH];
} LogBrewHttpClientSpan;

typedef struct {
  const char *name;
  const char *kind;
  double value;
  const char *unit;
  const char *temporality;
  LogBrewMetadata metadata;
  /** Optional stable display meaning; never use identifiers or changing values. */
  const char *description;
} LogBrewMetricAttributes;

#ifdef __cplusplus
#define LOGBREW_METADATA_STRING_VALUE(key_value, value) \
  LogBrewMetadataEntry{(key_value), LOGBREW_METADATA_STRING, (value), 0.0, false}
#define LOGBREW_METADATA_NUMBER_VALUE(key_value, value) \
  LogBrewMetadataEntry{(key_value), LOGBREW_METADATA_NUMBER, NULL, (value), false}
#define LOGBREW_METADATA_BOOL_VALUE(key_value, value) \
  LogBrewMetadataEntry{(key_value), LOGBREW_METADATA_BOOL, NULL, 0.0, (value)}
#define LOGBREW_METADATA_NULL_VALUE(key_value) \
  LogBrewMetadataEntry{(key_value), LOGBREW_METADATA_NULL, NULL, 0.0, false}
#else
#define LOGBREW_METADATA_STRING_VALUE(key_value, value) \
  ((LogBrewMetadataEntry){(key_value), LOGBREW_METADATA_STRING, (value), 0.0, false})
#define LOGBREW_METADATA_NUMBER_VALUE(key_value, value) \
  ((LogBrewMetadataEntry){(key_value), LOGBREW_METADATA_NUMBER, NULL, (value), false})
#define LOGBREW_METADATA_BOOL_VALUE(key_value, value) \
  ((LogBrewMetadataEntry){(key_value), LOGBREW_METADATA_BOOL, NULL, 0.0, (value)})
#define LOGBREW_METADATA_NULL_VALUE(key_value) \
  ((LogBrewMetadataEntry){(key_value), LOGBREW_METADATA_NULL, NULL, 0.0, false})
#endif

#define LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION 1U
#define LOGBREW_MAX_CONTEXT_TAGS 32U
#define LOGBREW_MAX_BREADCRUMBS 64U
#define LOGBREW_MAX_STACK_FRAMES 32U
#define LOGBREW_MAX_EXCEPTION_CHAIN_ENTRIES 8U
#define LOGBREW_MAX_SPAN_EVENTS 8U
#define LOGBREW_MAX_SPAN_LINKS 8U
#define LOGBREW_MAX_METADATA_ENTRIES 128U
#define LOGBREW_MAX_METADATA_KEY_LENGTH 128U
#define LOGBREW_MAX_METADATA_STRING_LENGTH 4096U

typedef struct {
  const char *name;
  const char *version;
} LogBrewNamedVersion;

typedef struct {
  const char *environment;
  const char *release;
} LogBrewDeploymentContext;

typedef struct {
  const char *name;
  const char *version;
  const char *build;
} LogBrewOperatingSystemContext;

typedef struct {
  const char *family;
  const char *model;
  const char *architecture;
} LogBrewDeviceContext;

typedef struct {
  const char *name;
  const char *version;
  const char *build;
} LogBrewApplicationContext;

typedef struct {
  const LogBrewNamedVersion *service;
  const LogBrewDeploymentContext *deployment;
  const LogBrewNamedVersion *runtime;
  const LogBrewNamedVersion *framework;
  const LogBrewOperatingSystemContext *operating_system;
  const LogBrewDeviceContext *device;
  const LogBrewApplicationContext *application;
} LogBrewTelemetryResource;

typedef struct {
  const char *trace_id;
  const char *span_id;
  const char *parent_span_id;
  bool sampled;
  bool has_sampled;
} LogBrewTelemetryTraceContext;

typedef struct {
  const char *id;
  const char *previous_id;
} LogBrewSessionContext;

typedef enum {
  LOGBREW_SUBJECT_ANONYMOUS,
  LOGBREW_SUBJECT_USER
} LogBrewSubjectKind;

typedef struct {
  const char *id;
  LogBrewSubjectKind kind;
} LogBrewSubjectContext;

typedef struct {
  const char *key;
  const char *value;
} LogBrewTelemetryTag;

/**
 * Caller-owned schema-v1 telemetry context. Client construction and telemetry
 * scopes take bounded deep copies; per-event capture reads it synchronously.
 * Subject identifiers must already be opaque and privacy-safe.
 */
typedef struct {
  unsigned int schema_version;
  const LogBrewTelemetryResource *resource;
  const LogBrewTelemetryTraceContext *trace;
  const LogBrewSessionContext *session;
  const LogBrewSubjectContext *subject;
  const LogBrewTelemetryTag *tags;
  size_t tag_count;
} LogBrewTelemetryContext;

typedef struct {
  LogBrewMetadata metadata;
  const LogBrewTelemetryContext *context;
} LogBrewEventOptions;

#ifdef __cplusplus
#define LOGBREW_EVENT_OPTIONS_NONE LogBrewEventOptions{{NULL, 0U}, NULL}
#else
#define LOGBREW_EVENT_OPTIONS_NONE ((LogBrewEventOptions){{NULL, 0U}, NULL})
#endif

typedef struct {
  const LogBrewTelemetryContext *context;
  bool disable_automatic_context;
} LogBrewClientOptions;

typedef struct {
  void *snapshot;
  const void *previous;
  bool active;
} LogBrewTelemetryScope;

#define LOGBREW_TELEMETRY_SCOPE_INIT {NULL, NULL, false}

typedef struct {
  const char *type;
  bool handled;
} LogBrewIssueMechanism;

typedef struct {
  const char *type;
  const LogBrewIssueMechanism *mechanism;
} LogBrewIssueException;

typedef struct {
  const char *filename;
  /** Zero means filename is NUL-terminated; helpers may set an exact slice. */
  size_t filename_length;
  unsigned int line;
  unsigned int column;
  const char *function;
  const char *module;
  bool in_app;
  bool has_in_app;
  const char *debug_id;
} LogBrewIssueStackFrame;

typedef enum {
  LOGBREW_EXCEPTION_RELATIONSHIP_REPORTED = 0,
  LOGBREW_EXCEPTION_RELATIONSHIP_CAUSE = 1,
  LOGBREW_EXCEPTION_RELATIONSHIP_CONTEXT = 2,
  LOGBREW_EXCEPTION_RELATIONSHIP_AGGREGATE_MEMBER = 3,
  LOGBREW_EXCEPTION_RELATIONSHIP_SUPPRESSED = 4
} LogBrewIssueExceptionRelationship;

typedef enum {
  LOGBREW_EXCEPTION_MESSAGE_NOT_CAPTURED = 0,
  LOGBREW_EXCEPTION_MESSAGE_CAPTURED = 1,
  LOGBREW_EXCEPTION_MESSAGE_TRUNCATED = 2,
  LOGBREW_EXCEPTION_MESSAGE_REDACTED = 3
} LogBrewIssueExceptionMessageState;

typedef enum {
  LOGBREW_EXCEPTION_STACK_NOT_CAPTURED = 0,
  LOGBREW_EXCEPTION_STACK_CAPTURED = 1,
  LOGBREW_EXCEPTION_STACK_TRUNCATED = 2
} LogBrewIssueExceptionStackState;

/**
 * One bounded node in an exception graph. C cannot discover language-runtime
 * causes portably, so callers provide this evidence explicitly. Entry zero is
 * the reported exception and must match the legacy exception/stack fields.
 */
typedef struct {
  size_t id;
  size_t parent_id;
  bool has_parent_id;
  LogBrewIssueExceptionRelationship relationship;
  const char *type;
  const char *message;
  LogBrewIssueExceptionMessageState message_state;
  const char *module;
  const LogBrewIssueMechanism *mechanism;
  const LogBrewIssueStackFrame *stack_frames;
  size_t stack_frame_count;
  LogBrewIssueExceptionStackState stack_frames_state;
} LogBrewIssueExceptionChainEntry;

typedef struct {
  const LogBrewIssueExceptionChainEntry *entries;
  size_t entry_count;
  bool truncated;
} LogBrewIssueExceptionChain;

typedef struct {
  const char *timestamp;
  const char *type;
  const char *category;
  const char *level;
  const char *message;
  LogBrewMetadata data;
} LogBrewIssueBreadcrumb;

typedef struct {
  const LogBrewIssueException *exception;
  const LogBrewIssueStackFrame *stack_frames;
  size_t stack_frame_count;
  const LogBrewIssueBreadcrumb *breadcrumbs;
  size_t breadcrumb_count;
  bool breadcrumbs_truncated;
  /** Optional bounded cause/context/aggregate graph; appended for ABI growth. */
  const LogBrewIssueExceptionChain *exception_chain;
} LogBrewIssueDetails;

typedef struct {
  const char *name;
  const char *timestamp;
  LogBrewMetadata metadata;
} LogBrewSpanEvent;

typedef struct {
  const char *trace_id;
  const char *span_id;
  bool sampled;
  bool has_sampled;
  LogBrewMetadata metadata;
} LogBrewSpanLink;

typedef struct {
  const LogBrewSpanEvent *events;
  size_t event_count;
  const LogBrewSpanLink *links;
  size_t link_count;
} LogBrewSpanEvidence;

typedef struct {
  const char *session_id;
  const char *trace_id;
  const char *route_template;
  const char *screen;
  const char *funnel;
  const char *step;
} LogBrewProductTimelineContext;

typedef struct {
  const char *name;
  const char *status;
  LogBrewProductTimelineContext context;
  LogBrewMetadata metadata;
} LogBrewProductActionAttributes;

typedef struct {
  const char *method;
  const char *route_template;
  int status_code;
  bool has_status_code;
  double duration_ms;
  bool has_duration_ms;
  LogBrewProductTimelineContext context;
  LogBrewMetadata metadata;
} LogBrewNetworkMilestoneAttributes;

typedef enum {
  LOGBREW_RECORD_STATUS,
  LOGBREW_RECORD_ERROR
} LogBrewRecordingStepKind;

typedef struct {
  LogBrewRecordingStepKind kind;
  int status_code;
  const char *code;
  const char *message;
  bool retryable;
} LogBrewRecordingStep;

#define LOGBREW_RECORD_STATUS_CODE(value) \
  ((LogBrewRecordingStep){LOGBREW_RECORD_STATUS, (value), NULL, NULL, false})

#define LOGBREW_RECORD_NETWORK_FAILURE(text) \
  ((LogBrewRecordingStep){LOGBREW_RECORD_ERROR, 0, "network_failure", (text), true})

typedef struct {
  const LogBrewRecordingStep *steps;
  size_t step_count;
  size_t cursor;
  char **sent_bodies;
  size_t sent_count;
  size_t sent_capacity;
} LogBrewRecordingTransport;

void logbrew_error_clear(LogBrewError *error);
const char *logbrew_status_name(LogBrewStatus status);

LogBrewStatus logbrew_client_new(
    LogBrewConfig config,
    LogBrewClient **out_client,
    LogBrewError *error);
LogBrewStatus logbrew_client_new_with_options(
    LogBrewConfig config,
    LogBrewClientOptions options,
    LogBrewClient **out_client,
    LogBrewError *error);
void logbrew_client_free(LogBrewClient *client);
size_t logbrew_client_pending_events(const LogBrewClient *client);
void logbrew_free_string(char *value);

LogBrewStatus logbrew_telemetry_context_validate(
    const LogBrewTelemetryContext *context,
    LogBrewError *error);
LogBrewStatus logbrew_telemetry_scope_enter(
    LogBrewTelemetryScope *scope,
    const LogBrewTelemetryContext *context,
    LogBrewError *error);
void logbrew_telemetry_scope_exit(LogBrewTelemetryScope *scope);

LogBrewStatus logbrew_client_add_breadcrumb(
    LogBrewClient *client,
    LogBrewIssueBreadcrumb breadcrumb,
    LogBrewError *error);
void logbrew_client_clear_breadcrumbs(LogBrewClient *client);

/**
 * Builds a copy-safe frame that borrows file, function, and module until the
 * synchronous issue capture call returns. The filename slice is sanitized.
 */
LogBrewStatus logbrew_issue_frame_from_location(
    const char *file,
    unsigned int line,
    unsigned int column,
    const char *function,
    const char *module,
    bool in_app,
    LogBrewIssueStackFrame *out_frame,
    LogBrewError *error);

LogBrewStatus logbrew_client_preview_json(
    const LogBrewClient *client,
    char **out_json,
    LogBrewError *error);

LogBrewStatus logbrew_client_flush(
    LogBrewClient *client,
    LogBrewTransport transport,
    LogBrewTransportResponse *response,
    LogBrewError *error);

LogBrewStatus logbrew_client_shutdown(
    LogBrewClient *client,
    LogBrewTransport transport,
    LogBrewTransportResponse *response,
    LogBrewError *error);

LogBrewStatus logbrew_client_release(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewReleaseAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_release_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewReleaseAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_environment(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewEnvironmentAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_environment_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewEnvironmentAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_issue(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewIssueAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_issue_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewIssueAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);
LogBrewStatus logbrew_client_issue_with_details(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewIssueAttributes attributes,
    LogBrewIssueDetails details,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_log(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewLogAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_log_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewLogAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_span(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewSpanAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_span_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewSpanAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);
LogBrewStatus logbrew_client_span_with_evidence(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewSpanAttributes attributes,
    LogBrewSpanEvidence evidence,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_metric(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewMetricAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_metric_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewMetricAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_action(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewActionAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_action_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewActionAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_product_action(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewProductActionAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_product_action_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewProductActionAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_client_network_milestone(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewNetworkMilestoneAttributes attributes,
    LogBrewError *error);
LogBrewStatus logbrew_client_network_milestone_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewNetworkMilestoneAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error);

LogBrewStatus logbrew_trace_root_context(LogBrewTraceContext *out_context, LogBrewError *error);

LogBrewStatus logbrew_trace_context_from_traceparent(
    const char *traceparent,
    LogBrewTraceContext *out_context,
    LogBrewError *error);

LogBrewStatus logbrew_trace_continue_or_create_context(
    const char *traceparent,
    LogBrewTraceContext *out_context,
    LogBrewError *error);

LogBrewStatus logbrew_trace_child_context(
    const LogBrewTraceContext *parent,
    LogBrewTraceContext *out_context,
    LogBrewError *error);

LogBrewStatus logbrew_trace_context_from_opentelemetry_span_context(
    LogBrewOpenTelemetrySpanContext context,
    LogBrewTraceContext *out_context,
    LogBrewError *error);

LogBrewStatus logbrew_trace_create_headers(
    const LogBrewTraceContext *context,
    char out_traceparent[LOGBREW_TRACEPARENT_LENGTH + 1U],
    LogBrewError *error);

const LogBrewTraceContext *logbrew_trace_current_context(void);

LogBrewStatus logbrew_trace_scope_enter(
    LogBrewTraceScope *scope,
    const LogBrewTraceContext *context,
    LogBrewError *error);

void logbrew_trace_scope_exit(LogBrewTraceScope *scope);

LogBrewMetadata logbrew_trace_metadata(
    const LogBrewTraceContext *context,
    LogBrewMetadataEntry entries[LOGBREW_TRACE_METADATA_ENTRY_COUNT]);

LogBrewProductTimelineContext logbrew_trace_product_timeline_context(
    const LogBrewTraceContext *context,
    LogBrewProductTimelineContext base_context);

LogBrewStatus logbrew_trace_span_attributes(
    const LogBrewTraceContext *context,
    const char *name,
    const char *status,
    double duration_ms,
    bool has_duration_ms,
    LogBrewSpanAttributes *out_attributes,
    LogBrewError *error);

LogBrewStatus logbrew_trace_span_attributes_from_opentelemetry_span_context(
    const char *name,
    const char *status,
    LogBrewOpenTelemetrySpanContext context,
    double duration_ms,
    bool has_duration_ms,
    LogBrewTraceContext *out_context,
    LogBrewSpanAttributes *out_attributes,
    LogBrewError *error);

LogBrewStatus logbrew_trace_http_client_span_start(
    const LogBrewTraceContext *parent,
    const char *method,
    const char *route_template,
    LogBrewHttpClientSpan *out_span,
    LogBrewError *error);

LogBrewStatus logbrew_trace_http_client_span_attributes(
    const LogBrewHttpClientSpan *span,
    int status_code,
    bool has_status_code,
    bool network_error,
    double duration_ms,
    bool has_duration_ms,
    LogBrewSpanAttributes *out_attributes,
    LogBrewError *error);

void logbrew_recording_transport_init(
    LogBrewRecordingTransport *transport,
    const LogBrewRecordingStep *steps,
    size_t step_count);
void logbrew_recording_transport_free(LogBrewRecordingTransport *transport);
LogBrewTransport logbrew_recording_transport_as_transport(LogBrewRecordingTransport *transport);
const char *logbrew_recording_transport_last_body(const LogBrewRecordingTransport *transport);
size_t logbrew_recording_transport_sent_count(const LogBrewRecordingTransport *transport);

LogBrewStatus logbrew_http_transport_init(
    LogBrewHttpTransport *transport,
    const char *endpoint,
    const LogBrewHttpHeader *headers,
    size_t header_count,
    long timeout_ms,
    LogBrewError *error);
void logbrew_http_transport_free(LogBrewHttpTransport *transport);
LogBrewTransport logbrew_http_transport_as_transport(LogBrewHttpTransport *transport);

#ifdef __cplusplus
}
#endif

#endif
