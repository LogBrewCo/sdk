#ifndef LOGBREW_INTERNAL_H
#define LOGBREW_INTERNAL_H

#include "logbrew.h"

typedef struct {
  char *data;
  size_t length;
  size_t capacity;
} LogBrewJsonBuffer;

typedef struct LogBrewContextStorage LogBrewContextStorage;

void logbrew_internal_set_error(
    LogBrewError *error,
    const char *code,
    const char *message,
    bool retryable);
bool logbrew_internal_blank(const char *value);
LogBrewStatus logbrew_internal_require_timestamp(
    const char *label,
    const char *timestamp,
    LogBrewError *error);

void logbrew_json_dispose(LogBrewJsonBuffer *buffer);
LogBrewStatus logbrew_json_append(
    LogBrewJsonBuffer *buffer,
    const char *value,
    LogBrewError *error);
LogBrewStatus logbrew_json_append_char(
    LogBrewJsonBuffer *buffer,
    char value,
    LogBrewError *error);
LogBrewStatus logbrew_json_append_format(
    LogBrewJsonBuffer *buffer,
    LogBrewError *error,
    const char *format,
    ...);
LogBrewStatus logbrew_json_append_string(
    LogBrewJsonBuffer *buffer,
    const char *value,
    LogBrewError *error);
LogBrewStatus logbrew_json_append_named_string(
    LogBrewJsonBuffer *buffer,
    const char *name,
    const char *value,
    bool *needs_comma,
    LogBrewError *error);
LogBrewStatus logbrew_json_append_named_bool(
    LogBrewJsonBuffer *buffer,
    const char *name,
    bool value,
    bool *needs_comma,
    LogBrewError *error);
LogBrewStatus logbrew_json_append_named_number(
    LogBrewJsonBuffer *buffer,
    const char *name,
    double value,
    bool *needs_comma,
    LogBrewError *error);
LogBrewStatus logbrew_json_validate_metadata(
    LogBrewMetadata metadata,
    const char *label,
    size_t maximum_entries,
    bool strict_machine_keys,
    size_t maximum_string_length,
    LogBrewError *error);
LogBrewStatus logbrew_json_append_metadata_member(
    LogBrewJsonBuffer *buffer,
    const char *name,
    LogBrewMetadata base,
    LogBrewMetadata override,
    size_t maximum_entries,
    bool strict_machine_keys,
    size_t maximum_string_length,
    bool *needs_comma,
    LogBrewError *error);

LogBrewStatus logbrew_context_storage_create(
    const LogBrewTelemetryContext *context,
    bool include_automatic_context,
    LogBrewContextStorage **out_storage,
    LogBrewError *error);
void logbrew_context_storage_free(LogBrewContextStorage *storage);
LogBrewStatus logbrew_context_build_json(
    const LogBrewContextStorage *base,
    const LogBrewSpanAttributes *signal_span,
    const LogBrewTelemetryContext *event_context,
    char **out_json,
    LogBrewError *error);

LogBrewStatus logbrew_evidence_breadcrumb_json(
    LogBrewIssueBreadcrumb breadcrumb,
    char **out_json,
    LogBrewError *error);
LogBrewStatus logbrew_evidence_issue_fragment(
    LogBrewIssueDetails details,
    char *const *stored_breadcrumbs,
    size_t stored_breadcrumb_count,
    bool stored_breadcrumbs_truncated,
    char **out_fragment,
    LogBrewError *error);
LogBrewStatus logbrew_evidence_span_fragment(
    LogBrewSpanEvidence evidence,
    char **out_fragment,
    LogBrewError *error);

LogBrewStatus logbrew_client_push_event_json(
    LogBrewClient *client,
    const char *event_type,
    const char *id,
    const char *timestamp,
    char *attributes_json,
    LogBrewError *error);

LogBrewStatus logbrew_client_push_event_json_with_context(
    LogBrewClient *client,
    const char *event_type,
    const char *id,
    const char *timestamp,
    char *attributes_json,
    const LogBrewTelemetryContext *event_context,
    const LogBrewSpanAttributes *signal_span,
    LogBrewError *error);

#endif
