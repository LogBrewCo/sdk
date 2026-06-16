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
} LogBrewMetricBuffer;

static void set_metric_error(LogBrewError *error, const char *code, const char *message) {
  if (error == NULL) {
    return;
  }
  (void)snprintf(error->code, sizeof(error->code), "%s", code);
  (void)snprintf(error->message, sizeof(error->message), "%s", message);
  error->retryable = false;
}

static bool metric_blank(const char *value) {
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
  if (!metric_blank(value)) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s must be non-empty", label);
  set_metric_error(error, "validation_error", message);
  return LOGBREW_VALIDATION_ERROR;
}

static bool string_equals_any(const char *value, const char *const *allowed, size_t allowed_count) {
  size_t index;
  for (index = 0U; index < allowed_count; index++) {
    if (strcmp(value, allowed[index]) == 0) {
      return true;
    }
  }
  return false;
}

static LogBrewStatus require_allowed(
    const char *label,
    const char *value,
    const char *const *allowed,
    size_t allowed_count,
    LogBrewError *error) {
  char message[192];
  LogBrewStatus status = require_text(label, value, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  if (string_equals_any(value, allowed, allowed_count)) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s has unsupported value: %s", label, value);
  set_metric_error(error, "validation_error", message);
  return LOGBREW_VALIDATION_ERROR;
}

static LogBrewStatus require_finite_number(const char *label, double value, LogBrewError *error) {
  char message[160];
  if (isfinite(value)) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s must be finite", label);
  set_metric_error(error, "validation_error", message);
  return LOGBREW_VALIDATION_ERROR;
}

static void metric_buffer_dispose(LogBrewMetricBuffer *buffer) {
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0U;
  buffer->capacity = 0U;
}

static LogBrewStatus metric_reserve(LogBrewMetricBuffer *buffer, size_t extra, LogBrewError *error) {
  size_t required;
  size_t next_capacity;
  char *next;
  if (extra > ((size_t)-1) - buffer->length - 1U) {
    set_metric_error(error, "allocation_error", "buffer size overflow");
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
    set_metric_error(error, "allocation_error", "out of memory");
    return LOGBREW_ALLOCATION_ERROR;
  }
  buffer->data = next;
  buffer->capacity = next_capacity;
  return LOGBREW_OK;
}

static LogBrewStatus metric_append_n(
    LogBrewMetricBuffer *buffer,
    const char *value,
    size_t length,
    LogBrewError *error) {
  LogBrewStatus status = metric_reserve(buffer, length, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  memcpy(buffer->data + buffer->length, value, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return LOGBREW_OK;
}

static LogBrewStatus metric_append(LogBrewMetricBuffer *buffer, const char *value, LogBrewError *error) {
  return metric_append_n(buffer, value, strlen(value), error);
}

static LogBrewStatus metric_append_char(LogBrewMetricBuffer *buffer, char value, LogBrewError *error) {
  return metric_append_n(buffer, &value, 1U, error);
}

static LogBrewStatus metric_append_format(LogBrewMetricBuffer *buffer, LogBrewError *error, const char *format, ...) {
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
    set_metric_error(error, "serialization_error", "formatting failed");
    return LOGBREW_SERIALIZATION_ERROR;
  }
  status = metric_reserve(buffer, (size_t)needed, error);
  if (status == LOGBREW_OK) {
    (void)vsnprintf(buffer->data + buffer->length, (size_t)needed + 1U, format, args);
    buffer->length += (size_t)needed;
  }
  va_end(args);
  return status;
}

static LogBrewStatus append_json_string(LogBrewMetricBuffer *buffer, const char *value, LogBrewError *error) {
  const unsigned char *cursor = (const unsigned char *)value;
  LogBrewStatus status = metric_append_char(buffer, '"', error);
  while (status == LOGBREW_OK && *cursor != '\0') {
    unsigned char current = *cursor;
    if (current == '"' || current == '\\') {
      status = metric_append_char(buffer, '\\', error);
      if (status == LOGBREW_OK) {
        status = metric_append_char(buffer, (char)current, error);
      }
    } else if (current == '\n') {
      status = metric_append(buffer, "\\n", error);
    } else if (current == '\r') {
      status = metric_append(buffer, "\\r", error);
    } else if (current == '\t') {
      status = metric_append(buffer, "\\t", error);
    } else if (current < 0x20U) {
      status = metric_append_format(buffer, error, "\\u%04x", (unsigned int)current);
    } else {
      status = metric_append_char(buffer, (char)current, error);
    }
    cursor++;
  }
  return status == LOGBREW_OK ? metric_append_char(buffer, '"', error) : status;
}

static LogBrewStatus append_named_string(
    LogBrewMetricBuffer *buffer,
    const char *name,
    const char *value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = *needs_comma ? metric_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, name, error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append_char(buffer, ':', error);
  }
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, value, error);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_named_number(
    LogBrewMetricBuffer *buffer,
    const char *name,
    double value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = require_finite_number(name, value, error);
  if (status == LOGBREW_OK && *needs_comma) {
    status = metric_append_char(buffer, ',', error);
  }
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, name, error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append_char(buffer, ':', error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append_format(buffer, error, "%.15g", value);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_named_bool(
    LogBrewMetricBuffer *buffer,
    const char *name,
    bool value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = *needs_comma ? metric_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) {
    status = append_json_string(buffer, name, error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append_char(buffer, ':', error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append(buffer, value ? "true" : "false", error);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_metadata(
    LogBrewMetricBuffer *buffer,
    LogBrewMetadata metadata,
    bool *needs_comma,
    LogBrewError *error) {
  size_t index;
  bool metadata_needs_comma = false;
  LogBrewStatus status;
  if (metadata.count == 0U) {
    return LOGBREW_OK;
  }
  if (metadata.count > 0U && metadata.entries == NULL) {
    set_metric_error(error, "validation_error", "metadata entries are required when count is non-zero");
    return LOGBREW_VALIDATION_ERROR;
  }
  status = metric_append(buffer, *needs_comma ? ",\"metadata\":{" : "\"metadata\":{", error);
  if (status != LOGBREW_OK) {
    return status;
  }
  for (index = 0U; index < metadata.count; index++) {
    LogBrewMetadataEntry entry = metadata.entries[index];
    status = require_text("metadata key", entry.key, error);
    if (status != LOGBREW_OK) {
      return status;
    }
    if (entry.kind == LOGBREW_METADATA_STRING) {
      status = require_text("metadata string value", entry.string_value, error);
      if (status == LOGBREW_OK) {
        status = append_named_string(buffer, entry.key, entry.string_value, &metadata_needs_comma, error);
      }
    } else if (entry.kind == LOGBREW_METADATA_NUMBER) {
      status = append_named_number(buffer, entry.key, entry.number_value, &metadata_needs_comma, error);
    } else if (entry.kind == LOGBREW_METADATA_BOOL) {
      status = append_named_bool(buffer, entry.key, entry.bool_value, &metadata_needs_comma, error);
    } else {
      set_metric_error(error, "validation_error", "metadata kind is unsupported");
      return LOGBREW_VALIDATION_ERROR;
    }
    if (status != LOGBREW_OK) {
      return status;
    }
  }
  status = metric_append_char(buffer, '}', error);
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

LogBrewStatus logbrew_client_metric(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewMetricAttributes attributes,
    LogBrewError *error) {
  static const char *const kinds[] = {"counter", "gauge", "histogram"};
  static const char *const instant_temporalities[] = {"instant"};
  static const char *const delta_temporalities[] = {"delta", "cumulative"};
  LogBrewMetricBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  LogBrewStatus status = require_text("metric name", attributes.name, error);
  if (status == LOGBREW_OK) {
    status = require_allowed("metric kind", attributes.kind, kinds, sizeof(kinds) / sizeof(kinds[0]), error);
  }
  if (status == LOGBREW_OK) {
    status = require_finite_number("metric value", attributes.value, error);
  }
  if (status == LOGBREW_OK) {
    status = require_text("metric unit", attributes.unit, error);
  }
  if (status == LOGBREW_OK && strcmp(attributes.kind, "gauge") == 0) {
    status = require_allowed(
        "metric temporality",
        attributes.temporality,
        instant_temporalities,
        sizeof(instant_temporalities) / sizeof(instant_temporalities[0]),
        error);
  } else if (status == LOGBREW_OK) {
    status = require_allowed(
        "metric temporality",
        attributes.temporality,
        delta_temporalities,
        sizeof(delta_temporalities) / sizeof(delta_temporalities[0]),
        error);
    if (status == LOGBREW_OK && attributes.value < 0.0) {
      set_metric_error(error, "validation_error", "metric value must be non-negative for counter and histogram");
      status = LOGBREW_VALIDATION_ERROR;
    }
  }
  if (status == LOGBREW_OK) {
    status = metric_append_char(&buffer, '{', error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "name", attributes.name, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "kind", attributes.kind, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_number(&buffer, "value", attributes.value, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "unit", attributes.unit, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "temporality", attributes.temporality, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_metadata(&buffer, attributes.metadata, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append_char(&buffer, '}', error);
  }
  if (status != LOGBREW_OK) {
    metric_buffer_dispose(&buffer);
    return status;
  }
  attributes_json = buffer.data;
  return logbrew_client_push_event_json(client, "metric", id, timestamp, attributes_json, error);
}
