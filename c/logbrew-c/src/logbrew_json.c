#include "logbrew_internal.h"

#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void logbrew_internal_set_error(
    LogBrewError *error,
    const char *code,
    const char *message,
    bool retryable) {
  if (error == NULL) {
    return;
  }
  (void)snprintf(error->code, sizeof(error->code), "%s", code == NULL ? "sdk_error" : code);
  (void)snprintf(error->message, sizeof(error->message), "%s", message == NULL ? "" : message);
  error->retryable = retryable;
}

bool logbrew_internal_blank(const char *value) {
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

LogBrewStatus logbrew_internal_require_timestamp(
    const char *label,
    const char *timestamp,
    LogBrewError *error) {
  const char *time_part;
  char message[192];
  if (logbrew_internal_blank(timestamp)) {
    (void)snprintf(message, sizeof(message), "%s must be non-empty", label);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  time_part = strchr(timestamp, 'T');
  if (time_part == NULL) {
    (void)snprintf(message, sizeof(message), "%s must include a time separator", label);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (timestamp[strlen(timestamp) - 1U] == 'Z' || strchr(time_part, '+') != NULL ||
      strrchr(time_part + 1, '-') != NULL) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s must include a timezone offset", label);
  logbrew_internal_set_error(error, "validation_error", message, false);
  return LOGBREW_VALIDATION_ERROR;
}

static LogBrewStatus json_reserve(LogBrewJsonBuffer *buffer, size_t extra, LogBrewError *error) {
  size_t required;
  size_t next_capacity;
  char *next;
  if (extra > ((size_t)-1) - buffer->length - 1U) {
    logbrew_internal_set_error(error, "allocation_error", "buffer size overflow", false);
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
    logbrew_internal_set_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  buffer->data = next;
  buffer->capacity = next_capacity;
  return LOGBREW_OK;
}

void logbrew_json_dispose(LogBrewJsonBuffer *buffer) {
  if (buffer == NULL) {
    return;
  }
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0U;
  buffer->capacity = 0U;
}

static LogBrewStatus json_append_n(
    LogBrewJsonBuffer *buffer,
    const char *value,
    size_t length,
    LogBrewError *error) {
  LogBrewStatus status = json_reserve(buffer, length, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  memcpy(buffer->data + buffer->length, value, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return LOGBREW_OK;
}

LogBrewStatus logbrew_json_append(
    LogBrewJsonBuffer *buffer,
    const char *value,
    LogBrewError *error) {
  return json_append_n(buffer, value, strlen(value), error);
}

LogBrewStatus logbrew_json_append_char(
    LogBrewJsonBuffer *buffer,
    char value,
    LogBrewError *error) {
  return json_append_n(buffer, &value, 1U, error);
}

LogBrewStatus logbrew_json_append_format(
    LogBrewJsonBuffer *buffer,
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
    logbrew_internal_set_error(error, "serialization_error", "formatting failed", false);
    return LOGBREW_SERIALIZATION_ERROR;
  }
  status = json_reserve(buffer, (size_t)needed, error);
  if (status == LOGBREW_OK) {
    (void)vsnprintf(buffer->data + buffer->length, (size_t)needed + 1U, format, args);
    buffer->length += (size_t)needed;
  }
  va_end(args);
  return status;
}

LogBrewStatus logbrew_json_append_string(
    LogBrewJsonBuffer *buffer,
    const char *value,
    LogBrewError *error) {
  const unsigned char *cursor = (const unsigned char *)value;
  LogBrewStatus status = logbrew_json_append_char(buffer, '"', error);
  while (status == LOGBREW_OK && *cursor != '\0') {
    unsigned char current = *cursor;
    if (current == '"' || current == '\\') {
      status = logbrew_json_append_char(buffer, '\\', error);
      if (status == LOGBREW_OK) {
        status = logbrew_json_append_char(buffer, (char)current, error);
      }
    } else if (current == '\n') {
      status = logbrew_json_append(buffer, "\\n", error);
    } else if (current == '\r') {
      status = logbrew_json_append(buffer, "\\r", error);
    } else if (current == '\t') {
      status = logbrew_json_append(buffer, "\\t", error);
    } else if (current < 0x20U) {
      status = logbrew_json_append_format(buffer, error, "\\u%04x", (unsigned int)current);
    } else {
      status = logbrew_json_append_char(buffer, (char)current, error);
    }
    cursor++;
  }
  return status == LOGBREW_OK ? logbrew_json_append_char(buffer, '"', error) : status;
}

static LogBrewStatus json_member_prefix(
    LogBrewJsonBuffer *buffer,
    const char *name,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = *needs_comma ? logbrew_json_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) {
    status = logbrew_json_append_string(buffer, name, error);
  }
  if (status == LOGBREW_OK) {
    status = logbrew_json_append_char(buffer, ':', error);
  }
  return status;
}

LogBrewStatus logbrew_json_append_named_string(
    LogBrewJsonBuffer *buffer,
    const char *name,
    const char *value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = json_member_prefix(buffer, name, needs_comma, error);
  if (status == LOGBREW_OK) {
    status = logbrew_json_append_string(buffer, value, error);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

LogBrewStatus logbrew_json_append_named_bool(
    LogBrewJsonBuffer *buffer,
    const char *name,
    bool value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = json_member_prefix(buffer, name, needs_comma, error);
  if (status == LOGBREW_OK) {
    status = logbrew_json_append(buffer, value ? "true" : "false", error);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

LogBrewStatus logbrew_json_append_named_number(
    LogBrewJsonBuffer *buffer,
    const char *name,
    double value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status;
  if (!isfinite(value)) {
    logbrew_internal_set_error(error, "validation_error", "metadata number must be finite", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  status = json_member_prefix(buffer, name, needs_comma, error);
  if (status == LOGBREW_OK) {
    status = logbrew_json_append_format(buffer, error, "%.15g", value);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static bool json_machine_key(const char *value) {
  size_t index;
  size_t length;
  if (value == NULL) {
    return false;
  }
  length = strlen(value);
  if (length == 0U || length > 64U ||
      !(((unsigned char)value[0] >= (unsigned char)'A' && (unsigned char)value[0] <= (unsigned char)'Z') ||
        ((unsigned char)value[0] >= (unsigned char)'a' && (unsigned char)value[0] <= (unsigned char)'z'))) {
    return false;
  }
  for (index = 1U; index < length; index++) {
    unsigned char current = (unsigned char)value[index];
    if (!((current >= (unsigned char)'A' && current <= (unsigned char)'Z') ||
          (current >= (unsigned char)'a' && current <= (unsigned char)'z') ||
          (current >= (unsigned char)'0' && current <= (unsigned char)'9')) &&
        current != '_' && current != '.' && current != '-') {
      return false;
    }
  }
  return true;
}

static bool json_forbidden_control(const unsigned char *value) {
  while (*value != '\0') {
    if (*value < 0x20U || *value == 0x7fU ||
        (*value == 0xc2U && value[1] >= 0x80U && value[1] <= 0x9fU)) {
      return true;
    }
    value++;
  }
  return false;
}

static bool metadata_has_key(LogBrewMetadata metadata, const char *key) {
  size_t index;
  for (index = 0U; index < metadata.count; index++) {
    if (metadata.entries[index].key != NULL && strcmp(metadata.entries[index].key, key) == 0) {
      return true;
    }
  }
  return false;
}

static LogBrewStatus validate_metadata_set(
    LogBrewMetadata metadata,
    const char *label,
    bool strict_machine_keys,
    size_t maximum_string_length,
    LogBrewError *error) {
  size_t index;
  size_t prior;
  char message[192];
  if (metadata.count > 0U && metadata.entries == NULL) {
    (void)snprintf(message, sizeof(message), "%s entries are required when count is non-zero", label);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  for (index = 0U; index < metadata.count; index++) {
    LogBrewMetadataEntry entry = metadata.entries[index];
    if (logbrew_internal_blank(entry.key) ||
        strlen(entry.key) > LOGBREW_MAX_METADATA_KEY_LENGTH ||
        json_forbidden_control((const unsigned char *)entry.key) ||
        (strict_machine_keys && !json_machine_key(entry.key))) {
      (void)snprintf(message, sizeof(message), "%s key is invalid", label);
      logbrew_internal_set_error(error, "validation_error", message, false);
      return LOGBREW_VALIDATION_ERROR;
    }
    for (prior = 0U; prior < index; prior++) {
      if (strcmp(metadata.entries[prior].key, entry.key) == 0) {
        (void)snprintf(message, sizeof(message), "%s contains a duplicate key", label);
        logbrew_internal_set_error(error, "validation_error", message, false);
        return LOGBREW_VALIDATION_ERROR;
      }
    }
    if (entry.kind == LOGBREW_METADATA_STRING) {
      size_t length;
      if (logbrew_internal_blank(entry.string_value)) {
        (void)snprintf(message, sizeof(message), "%s string value must be non-empty", label);
        logbrew_internal_set_error(error, "validation_error", message, false);
        return LOGBREW_VALIDATION_ERROR;
      }
      length = strlen(entry.string_value);
      if ((maximum_string_length > 0U && length > maximum_string_length) ||
          (strict_machine_keys && json_forbidden_control((const unsigned char *)entry.string_value))) {
        (void)snprintf(message, sizeof(message), "%s string value is too long", label);
        logbrew_internal_set_error(error, "validation_error", message, false);
        return LOGBREW_VALIDATION_ERROR;
      }
    } else if (entry.kind == LOGBREW_METADATA_NUMBER && !isfinite(entry.number_value)) {
      (void)snprintf(message, sizeof(message), "%s number must be finite", label);
      logbrew_internal_set_error(error, "validation_error", message, false);
      return LOGBREW_VALIDATION_ERROR;
    } else if (entry.kind != LOGBREW_METADATA_NUMBER && entry.kind != LOGBREW_METADATA_BOOL &&
               entry.kind != LOGBREW_METADATA_NULL) {
      (void)snprintf(message, sizeof(message), "%s kind is unsupported", label);
      logbrew_internal_set_error(error, "validation_error", message, false);
      return LOGBREW_VALIDATION_ERROR;
    }
  }
  return LOGBREW_OK;
}

LogBrewStatus logbrew_json_validate_metadata(
    LogBrewMetadata metadata,
    const char *label,
    size_t maximum_entries,
    bool strict_machine_keys,
    size_t maximum_string_length,
    LogBrewError *error) {
  if (maximum_entries > 0U && metadata.count > maximum_entries) {
    logbrew_internal_set_error(error, "validation_error", "metadata contains too many entries", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  return validate_metadata_set(
      metadata, label, strict_machine_keys, maximum_string_length, error);
}

static LogBrewStatus append_metadata_entries(
    LogBrewJsonBuffer *buffer,
    LogBrewMetadata metadata,
    LogBrewMetadata skip_when_present,
    bool *needs_comma,
    LogBrewError *error) {
  size_t index;
  LogBrewStatus status = LOGBREW_OK;
  for (index = 0U; status == LOGBREW_OK && index < metadata.count; index++) {
    LogBrewMetadataEntry entry = metadata.entries[index];
    if (metadata_has_key(skip_when_present, entry.key)) {
      continue;
    }
    if (entry.kind == LOGBREW_METADATA_STRING) {
      status = logbrew_json_append_named_string(buffer, entry.key, entry.string_value, needs_comma, error);
    } else if (entry.kind == LOGBREW_METADATA_NUMBER) {
      status = logbrew_json_append_named_number(buffer, entry.key, entry.number_value, needs_comma, error);
    } else if (entry.kind == LOGBREW_METADATA_BOOL) {
      status = logbrew_json_append_named_bool(buffer, entry.key, entry.bool_value, needs_comma, error);
    } else {
      status = json_member_prefix(buffer, entry.key, needs_comma, error);
      if (status == LOGBREW_OK) {
        status = logbrew_json_append(buffer, "null", error);
      }
      if (status == LOGBREW_OK) {
        *needs_comma = true;
      }
    }
  }
  return status;
}

LogBrewStatus logbrew_json_append_metadata_member(
    LogBrewJsonBuffer *buffer,
    const char *name,
    LogBrewMetadata base,
    LogBrewMetadata override,
    size_t maximum_entries,
    bool strict_machine_keys,
    size_t maximum_string_length,
    bool *needs_comma,
    LogBrewError *error) {
  size_t combined_count;
  bool metadata_needs_comma = false;
  LogBrewStatus status;
  size_t index;
  if ((maximum_entries > 0U &&
       (base.count > maximum_entries || override.count > maximum_entries ||
        base.count > maximum_entries - override.count)) ||
      base.count > ((size_t)-1) - override.count) {
    logbrew_internal_set_error(error, "validation_error", "metadata contains too many entries", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  combined_count = base.count + override.count;
  status = logbrew_json_validate_metadata(
      base, name, maximum_entries, strict_machine_keys, maximum_string_length, error);
  if (status == LOGBREW_OK) {
    status = logbrew_json_validate_metadata(
        override, name, maximum_entries, strict_machine_keys, maximum_string_length, error);
  }
  for (index = 0U; status == LOGBREW_OK && index < override.count; index++) {
    if (metadata_has_key(base, override.entries[index].key)) {
      combined_count--;
    }
  }
  if (status != LOGBREW_OK || combined_count == 0U) {
    return status;
  }
  status = json_member_prefix(buffer, name, needs_comma, error);
  if (status == LOGBREW_OK) {
    status = logbrew_json_append_char(buffer, '{', error);
  }
  if (status == LOGBREW_OK) {
    status = append_metadata_entries(buffer, base, override, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_metadata_entries(buffer, override, (LogBrewMetadata){NULL, 0U}, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = logbrew_json_append_char(buffer, '}', error);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}
