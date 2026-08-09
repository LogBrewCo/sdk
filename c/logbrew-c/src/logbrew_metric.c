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

static bool metric_utf8_continuation(unsigned char value) {
  return value >= 0x80U && value <= 0xbfU;
}

static bool metric_description_codepoint(
    const unsigned char *value,
    size_t length,
    size_t *index,
    unsigned long *codepoint) {
  unsigned char first = value[*index];
  if (first < 0x80U) {
    *codepoint = first;
    *index += 1U;
    return true;
  }
  if (first >= 0xc2U && first <= 0xdfU && *index + 1U < length && metric_utf8_continuation(value[*index + 1U])) {
    *codepoint = ((unsigned long)(first & 0x1fU) << 6U) | (unsigned long)(value[*index + 1U] & 0x3fU);
    *index += 2U;
    return true;
  }
  if (first >= 0xe0U && first <= 0xefU && *index + 2U < length &&
      metric_utf8_continuation(value[*index + 1U]) && metric_utf8_continuation(value[*index + 2U]) &&
      !(first == 0xe0U && value[*index + 1U] < 0xa0U) &&
      !(first == 0xedU && value[*index + 1U] > 0x9fU)) {
    *codepoint = ((unsigned long)(first & 0x0fU) << 12U) |
        ((unsigned long)(value[*index + 1U] & 0x3fU) << 6U) |
        (unsigned long)(value[*index + 2U] & 0x3fU);
    *index += 3U;
    return true;
  }
  if (first >= 0xf0U && first <= 0xf4U && *index + 3U < length &&
      metric_utf8_continuation(value[*index + 1U]) && metric_utf8_continuation(value[*index + 2U]) &&
      metric_utf8_continuation(value[*index + 3U]) &&
      !(first == 0xf0U && value[*index + 1U] < 0x90U) &&
      !(first == 0xf4U && value[*index + 1U] > 0x8fU)) {
    *codepoint = ((unsigned long)(first & 0x07U) << 18U) |
        ((unsigned long)(value[*index + 1U] & 0x3fU) << 12U) |
        ((unsigned long)(value[*index + 2U] & 0x3fU) << 6U) |
        (unsigned long)(value[*index + 3U] & 0x3fU);
    *index += 4U;
    return true;
  }
  return false;
}

static LogBrewStatus normalize_metric_description(
    const char *value,
    char **normalized,
    LogBrewError *error) {
  const unsigned char *start;
  const unsigned char *end;
  size_t length;
  size_t index = 0U;
  size_t scalar_count = 0U;
  bool invalid = false;
  char *copy;
  *normalized = NULL;
  if (value == NULL) {
    return LOGBREW_OK;
  }
  start = (const unsigned char *)value;
  while (*start != '\0' && isspace(*start)) {
    start++;
  }
  end = start + strlen((const char *)start);
  while (end > start && isspace(*(end - 1U))) {
    end--;
  }
  length = (size_t)(end - start);
  while (index < length) {
    unsigned long codepoint = 0UL;
    if (!metric_description_codepoint(start, length, &index, &codepoint)) {
      break;
    }
    scalar_count++;
    if (codepoint <= 0x1fUL || (codepoint >= 0x7fUL && codepoint <= 0x9fUL) ||
        codepoint == 0x2028UL || codepoint == 0x2029UL) {
      invalid = true;
      break;
    }
  }
  if (length == 0U || invalid || index != length || scalar_count > 1024U) {
    set_metric_error(error, "validation_error",
        "metric description must be a non-blank string of at most 1024 non-control characters");
    return LOGBREW_VALIDATION_ERROR;
  }
  copy = (char *)malloc(length + 1U);
  if (copy == NULL) {
    set_metric_error(error, "allocation_error", "out of memory");
    return LOGBREW_ALLOCATION_ERROR;
  }
  memcpy(copy, start, length);
  copy[length] = '\0';
  *normalized = copy;
  return LOGBREW_OK;
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

static LogBrewStatus append_merged_metadata(
    LogBrewMetricBuffer *buffer,
    LogBrewMetadata base,
    LogBrewMetadata override,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewJsonBuffer fragment = {0};
  bool fragment_comma = false;
  LogBrewStatus status = logbrew_json_append_metadata_member(
      &fragment, "metadata", base, override, LOGBREW_MAX_METADATA_ENTRIES, false,
      LOGBREW_MAX_METADATA_STRING_LENGTH, &fragment_comma, error);
  if (status == LOGBREW_OK && fragment.length > 0U && *needs_comma) {
    status = metric_append_char(buffer, ',', error);
  }
  if (status == LOGBREW_OK && fragment.length > 0U) {
    status = metric_append(buffer, fragment.data, error);
  }
  if (status == LOGBREW_OK && fragment.length > 0U) {
    *needs_comma = true;
  }
  logbrew_json_dispose(&fragment);
  return status;
}

LogBrewStatus logbrew_client_metric(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewMetricAttributes attributes,
    LogBrewError *error) {
  return logbrew_client_metric_with_options(
      client, id, timestamp, attributes, LOGBREW_EVENT_OPTIONS_NONE, error);
}

LogBrewStatus logbrew_client_metric_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewMetricAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error) {
  static const char *const kinds[] = {"counter", "gauge", "histogram"};
  static const char *const instant_temporalities[] = {"instant"};
  static const char *const delta_temporalities[] = {"delta", "cumulative"};
  LogBrewMetricBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  char *description = NULL;
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
    status = normalize_metric_description(attributes.description, &description, error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append_char(&buffer, '{', error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "name", attributes.name, &needs_comma, error);
  }
  if (status == LOGBREW_OK && description != NULL) {
    status = append_named_string(&buffer, "description", description, &needs_comma, error);
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
    status = append_merged_metadata(&buffer, attributes.metadata, options.metadata, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = metric_append_char(&buffer, '}', error);
  }
  if (status != LOGBREW_OK) {
    free(description);
    metric_buffer_dispose(&buffer);
    return status;
  }
  free(description);
  attributes_json = buffer.data;
  return logbrew_client_push_event_json_with_context(
      client, "metric", id, timestamp, attributes_json, options.context, NULL, error);
}
