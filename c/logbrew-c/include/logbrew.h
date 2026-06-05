#ifndef LOGBREW_H
#define LOGBREW_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LOGBREW_C_VERSION "0.1.0"

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
void logbrew_client_free(LogBrewClient *client);
size_t logbrew_client_pending_events(const LogBrewClient *client);
void logbrew_free_string(char *value);

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

LogBrewStatus logbrew_client_environment(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewEnvironmentAttributes attributes,
    LogBrewError *error);

LogBrewStatus logbrew_client_issue(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewIssueAttributes attributes,
    LogBrewError *error);

LogBrewStatus logbrew_client_log(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewLogAttributes attributes,
    LogBrewError *error);

LogBrewStatus logbrew_client_span(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewSpanAttributes attributes,
    LogBrewError *error);

LogBrewStatus logbrew_client_action(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewActionAttributes attributes,
    LogBrewError *error);

void logbrew_recording_transport_init(
    LogBrewRecordingTransport *transport,
    const LogBrewRecordingStep *steps,
    size_t step_count);
void logbrew_recording_transport_free(LogBrewRecordingTransport *transport);
LogBrewTransport logbrew_recording_transport_as_transport(LogBrewRecordingTransport *transport);
const char *logbrew_recording_transport_last_body(const LogBrewRecordingTransport *transport);
size_t logbrew_recording_transport_sent_count(const LogBrewRecordingTransport *transport);

#ifdef __cplusplus
}
#endif

#endif
