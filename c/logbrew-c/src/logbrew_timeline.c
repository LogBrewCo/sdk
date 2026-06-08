#include "logbrew_internal.h"

#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *data;
  size_t length;
  size_t capacity;
} LogBrewTimelineBuffer;

static void set_timeline_error(LogBrewError *error, const char *code, const char *message) {
  if (error == NULL) {
    return;
  }
  (void)snprintf(error->code, sizeof(error->code), "%s", code);
  (void)snprintf(error->message, sizeof(error->message), "%s", message);
  error->retryable = false;
}

static bool timeline_blank(const char *value) {
  const unsigned char *cursor = (const unsigned char *)value;
  if (cursor == NULL) {
    return true;
  }
  while (*cursor != '\0') {
    if (!isspace(*cursor)) {
      return false;
    }
    cursor++;
  }
  return true;
}

static LogBrewStatus require_text(const char *label, const char *value, LogBrewError *error) {
  char message[160];
  if (!timeline_blank(value)) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s must be non-empty", label);
  set_timeline_error(error, "validation_error", message);
  return LOGBREW_VALIDATION_ERROR;
}

static LogBrewStatus timeline_reserve(LogBrewTimelineBuffer *buffer, size_t extra, LogBrewError *error) {
  size_t required;
  size_t next_capacity;
  char *next;
  if (extra > ((size_t)-1) - buffer->length - 1U) {
    set_timeline_error(error, "allocation_error", "buffer size overflow");
    return LOGBREW_ALLOCATION_ERROR;
  }
  required = buffer->length + extra + 1U;
  if (required <= buffer->capacity) {
    return LOGBREW_OK;
  }
  next_capacity = buffer->capacity == 0U ? 128U : buffer->capacity;
  while (next_capacity < required) {
    if (next_capacity > ((size_t)-1) / 2U) {
      next_capacity = required;
      break;
    }
    next_capacity *= 2U;
  }
  next = (char *)realloc(buffer->data, next_capacity);
  if (next == NULL) {
    set_timeline_error(error, "allocation_error", "out of memory");
    return LOGBREW_ALLOCATION_ERROR;
  }
  buffer->data = next;
  buffer->capacity = next_capacity;
  return LOGBREW_OK;
}

static LogBrewStatus timeline_append_n(
    LogBrewTimelineBuffer *buffer,
    const char *value,
    size_t length,
    LogBrewError *error) {
  LogBrewStatus status = timeline_reserve(buffer, length, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  memcpy(buffer->data + buffer->length, value, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return LOGBREW_OK;
}

static LogBrewStatus timeline_append(LogBrewTimelineBuffer *buffer, const char *value, LogBrewError *error) {
  return timeline_append_n(buffer, value, strlen(value), error);
}

static LogBrewStatus timeline_append_char(LogBrewTimelineBuffer *buffer, char value, LogBrewError *error) {
  return timeline_append_n(buffer, &value, 1U, error);
}

static LogBrewStatus timeline_append_format(
    LogBrewTimelineBuffer *buffer,
    LogBrewError *error,
    const char *format,
    ...) {
  va_list args;
  va_list copy;
  int needed;
  LogBrewStatus status;
  va_start(args, format);
  va_copy(copy, args);
  needed = vsnprintf(NULL, 0U, format, copy);
  va_end(copy);
  if (needed < 0) {
    va_end(args);
    set_timeline_error(error, "serialization_error", "formatting failed");
    return LOGBREW_SERIALIZATION_ERROR;
  }
  status = timeline_reserve(buffer, (size_t)needed, error);
  if (status == LOGBREW_OK) {
    (void)vsnprintf(buffer->data + buffer->length, (size_t)needed + 1U, format, args);
    buffer->length += (size_t)needed;
  }
  va_end(args);
  return status;
}

static LogBrewStatus append_json_string(LogBrewTimelineBuffer *buffer, const char *value, LogBrewError *error) {
  const unsigned char *cursor = (const unsigned char *)value;
  LogBrewStatus status = timeline_append_char(buffer, '"', error);
  while (status == LOGBREW_OK && *cursor != '\0') {
    unsigned char current = *cursor;
    if (current == '"' || current == '\\') {
      status = timeline_append_char(buffer, '\\', error);
      if (status == LOGBREW_OK) {
        status = timeline_append_char(buffer, (char)current, error);
      }
    } else if (current == '\n') {
      status = timeline_append(buffer, "\\n", error);
    } else if (current == '\r') {
      status = timeline_append(buffer, "\\r", error);
    } else if (current == '\t') {
      status = timeline_append(buffer, "\\t", error);
    } else if (current < 0x20U) {
      status = timeline_append_format(buffer, error, "\\u%04x", (unsigned int)current);
    } else {
      status = timeline_append_char(buffer, (char)current, error);
    }
    cursor++;
  }
  return status == LOGBREW_OK ? timeline_append_char(buffer, '"', error) : status;
}

static LogBrewStatus append_named_string(
    LogBrewTimelineBuffer *buffer,
    const char *name,
    const char *value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = *needs_comma ? timeline_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, name, error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(buffer, ':', error);
  }
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, value, error);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_optional_string(
    LogBrewTimelineBuffer *buffer,
    const char *name,
    const char *value,
    bool *needs_comma,
    LogBrewError *error) {
  if (value == NULL) {
    return LOGBREW_OK;
  }
  if (timeline_blank(value)) {
    set_timeline_error(error, "validation_error", "timeline context values must be non-empty when provided");
    return LOGBREW_VALIDATION_ERROR;
  }
  return append_named_string(buffer, name, value, needs_comma, error);
}

static LogBrewStatus append_named_number(
    LogBrewTimelineBuffer *buffer,
    const char *name,
    double value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status;
  if (!isfinite(value)) {
    set_timeline_error(error, "validation_error", "metadata number must be finite");
    return LOGBREW_VALIDATION_ERROR;
  }
  status = *needs_comma ? timeline_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, name, error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(buffer, ':', error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_format(buffer, error, "%.15g", value);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_named_bool(
    LogBrewTimelineBuffer *buffer,
    const char *name,
    bool value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = *needs_comma ? timeline_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, name, error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(buffer, ':', error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append(buffer, value ? "true" : "false", error);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_metadata(
    LogBrewTimelineBuffer *buffer,
    LogBrewMetadata metadata,
    bool *needs_comma,
    LogBrewError *error) {
  size_t index;
  if (metadata.count > 0U && metadata.entries == NULL) {
    set_timeline_error(error, "validation_error", "metadata entries are required when count is non-zero");
    return LOGBREW_VALIDATION_ERROR;
  }
  for (index = 0U; index < metadata.count; index++) {
    LogBrewMetadataEntry entry = metadata.entries[index];
    LogBrewStatus status = require_text("metadata key", entry.key, error);
    if (status != LOGBREW_OK) {
      return status;
    }
    if (entry.kind == LOGBREW_METADATA_STRING) {
      status = require_text("metadata string value", entry.string_value, error);
      if (status == LOGBREW_OK) {
        status = append_named_string(buffer, entry.key, entry.string_value, needs_comma, error);
      }
    } else if (entry.kind == LOGBREW_METADATA_NUMBER) {
      status = append_named_number(buffer, entry.key, entry.number_value, needs_comma, error);
    } else if (entry.kind == LOGBREW_METADATA_BOOL) {
      status = append_named_bool(buffer, entry.key, entry.bool_value, needs_comma, error);
    } else {
      set_timeline_error(error, "validation_error", "metadata kind is unsupported");
      return LOGBREW_VALIDATION_ERROR;
    }
    if (status != LOGBREW_OK) {
      return status;
    }
  }
  return LOGBREW_OK;
}

static LogBrewStatus append_timeline_metadata_start(
    LogBrewTimelineBuffer *buffer,
    const char *source,
    LogBrewProductTimelineContext context,
    bool *needs_comma,
    bool *metadata_needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = timeline_append(buffer, *needs_comma ? ",\"metadata\":{" : "\"metadata\":{", error);
  if (status == LOGBREW_OK) {
    status = append_named_string(buffer, "source", source, metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(buffer, "sessionId", context.session_id, metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(buffer, "traceId", context.trace_id, metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(buffer, "routeTemplate", context.route_template, metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(buffer, "screen", context.screen, metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(buffer, "funnel", context.funnel, metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(buffer, "step", context.step, metadata_needs_comma, error);
  }
  return status;
}

static LogBrewStatus append_timeline_metadata_finish(
    LogBrewTimelineBuffer *buffer,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = timeline_append_char(buffer, '}', error);
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_timeline_metadata(
    LogBrewTimelineBuffer *buffer,
    const char *source,
    LogBrewProductTimelineContext context,
    LogBrewMetadata metadata,
    bool *needs_comma,
    LogBrewError *error) {
  bool metadata_needs_comma = false;
  LogBrewStatus status = append_timeline_metadata_start(buffer, source, context, needs_comma, &metadata_needs_comma, error);
  if (status == LOGBREW_OK) {
    status = append_metadata(buffer, metadata, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_timeline_metadata_finish(buffer, needs_comma, error);
  }
  return status;
}

static LogBrewStatus append_network_timeline_metadata(
    LogBrewTimelineBuffer *buffer,
    LogBrewProductTimelineContext context,
    const char *method,
    const char *route_template,
    LogBrewNetworkMilestoneAttributes attributes,
    bool *needs_comma,
    LogBrewError *error) {
  bool metadata_needs_comma = false;
  LogBrewStatus status = append_timeline_metadata_start(buffer, "c.network", context, needs_comma, &metadata_needs_comma, error);
  if (status == LOGBREW_OK) {
    status = append_named_string(buffer, "method", method, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(buffer, "routeTemplate", route_template, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK && attributes.has_status_code) {
    status = append_named_number(buffer, "statusCode", (double)attributes.status_code, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK && attributes.has_duration_ms) {
    status = append_named_number(buffer, "durationMs", attributes.duration_ms, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_metadata(buffer, attributes.metadata, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_timeline_metadata_finish(buffer, needs_comma, error);
  }
  return status;
}

static LogBrewStatus copy_sanitized_route(const char *route_template, char **out_route, LogBrewError *error) {
  const char *start = route_template;
  const char *end;
  const char *scheme;
  size_t length;
  char *copy;
  *out_route = NULL;
  if (require_text("route_template", route_template, error) != LOGBREW_OK) {
    return LOGBREW_VALIDATION_ERROR;
  }
  scheme = strstr(route_template, "://");
  if (scheme != NULL && (strncmp(route_template, "http://", 7U) == 0 || strncmp(route_template, "https://", 8U) == 0)) {
    start = strchr(scheme + 3, '/');
    if (start == NULL) {
      start = "/";
    }
  }
  end = start + strcspn(start, "?#");
  length = (size_t)(end - start);
  if (length == 0U) {
    set_timeline_error(error, "validation_error", "route_template must include a path before query or fragment");
    return LOGBREW_VALIDATION_ERROR;
  }
  copy = (char *)malloc(length + 1U);
  if (copy == NULL) {
    set_timeline_error(error, "allocation_error", "out of memory");
    return LOGBREW_ALLOCATION_ERROR;
  }
  memcpy(copy, start, length);
  copy[length] = '\0';
  *out_route = copy;
  return LOGBREW_OK;
}

static LogBrewStatus copy_upper_method(const char *method, char out_method[16], LogBrewError *error) {
  size_t index;
  LogBrewStatus status = require_text("method", method, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  for (index = 0U; method[index] != '\0'; index++) {
    if (index + 1U >= 16U) {
      set_timeline_error(error, "validation_error", "method is too long");
      return LOGBREW_VALIDATION_ERROR;
    }
    out_method[index] = (char)toupper((unsigned char)method[index]);
  }
  out_method[index] = '\0';
  return LOGBREW_OK;
}

static bool allowed_action_status(const char *status) {
  return strcmp(status, "queued") == 0 || strcmp(status, "running") == 0 ||
         strcmp(status, "success") == 0 || strcmp(status, "failure") == 0;
}

LogBrewStatus logbrew_client_product_action(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewProductActionAttributes attributes,
    LogBrewError *error) {
  LogBrewTimelineBuffer buffer = {0};
  bool needs_comma = false;
  char *sanitized_route = NULL;
  LogBrewProductTimelineContext context = attributes.context;
  LogBrewStatus status = require_text("action name", attributes.name, error);
  if (status == LOGBREW_OK) {
    status = require_text("action status", attributes.status, error);
  }
  if (status == LOGBREW_OK && !allowed_action_status(attributes.status)) {
    set_timeline_error(error, "validation_error", "action status has unsupported value");
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK && context.route_template != NULL) {
    status = copy_sanitized_route(context.route_template, &sanitized_route, error);
    context.route_template = sanitized_route;
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(&buffer, '{', error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "name", attributes.name, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "status", attributes.status, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_timeline_metadata(&buffer, "c.action", context, attributes.metadata, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(&buffer, '}', error);
  }
  free(sanitized_route);
  if (status != LOGBREW_OK) {
    free(buffer.data);
    return status;
  }
  return logbrew_client_push_action_json(client, id, timestamp, buffer.data, error);
}

LogBrewStatus logbrew_client_network_milestone(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewNetworkMilestoneAttributes attributes,
    LogBrewError *error) {
  LogBrewTimelineBuffer buffer = {0};
  LogBrewTimelineBuffer name_buffer = {0};
  bool needs_comma = false;
  char *sanitized_route = NULL;
  char normalized_method[16];
  const char *status_name = "success";
  LogBrewProductTimelineContext context = attributes.context;
  LogBrewStatus status = copy_upper_method(attributes.method, normalized_method, error);
  if (status == LOGBREW_OK) {
    status = copy_sanitized_route(attributes.route_template, &sanitized_route, error);
  }
  if (status == LOGBREW_OK && attributes.has_status_code &&
      (attributes.status_code < 100 || attributes.status_code > 599)) {
    set_timeline_error(error, "validation_error", "status_code must be between 100 and 599");
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK && attributes.has_duration_ms &&
      (!isfinite(attributes.duration_ms) || attributes.duration_ms < 0.0)) {
    set_timeline_error(error, "validation_error", "duration_ms must be finite and non-negative");
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK) {
    if (attributes.has_status_code) {
      status_name = attributes.status_code >= 400 ? "failure" : "success";
    }
    context.route_template = NULL;
    status = timeline_append_format(&name_buffer, error, "%s %s", normalized_method, sanitized_route);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(&buffer, '{', error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "name", name_buffer.data, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "status", status_name, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_network_timeline_metadata(
        &buffer,
        context,
        normalized_method,
        sanitized_route,
        attributes,
        &needs_comma,
        error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(&buffer, '}', error);
  }
  free(name_buffer.data);
  free(sanitized_route);
  if (status != LOGBREW_OK) {
    free(buffer.data);
    return status;
  }
  return logbrew_client_push_action_json(client, id, timestamp, buffer.data, error);
}
