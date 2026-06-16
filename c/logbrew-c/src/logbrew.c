#include "logbrew.h"
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
} LogBrewBuffer;

typedef struct {
  char *json;
} LogBrewEvent;

struct LogBrewClient {
  char *api_key;
  char *sdk_name;
  char *sdk_version;
  size_t max_retries;
  bool closed;
  LogBrewEvent *events;
  size_t event_count;
  size_t event_capacity;
};

static void set_error(LogBrewError *error, const char *code, const char *message, bool retryable) {
  if (error == NULL) {
    return;
  }
  (void)snprintf(error->code, sizeof(error->code), "%s", code == NULL ? "sdk_error" : code);
  (void)snprintf(error->message, sizeof(error->message), "%s", message == NULL ? "" : message);
  error->retryable = retryable;
}

void logbrew_error_clear(LogBrewError *error) {
  if (error == NULL) {
    return;
  }
  error->code[0] = '\0';
  error->message[0] = '\0';
  error->retryable = false;
}

const char *logbrew_status_name(LogBrewStatus status) {
  switch (status) {
    case LOGBREW_OK:
      return "ok";
    case LOGBREW_CONFIG_ERROR:
      return "config_error";
    case LOGBREW_VALIDATION_ERROR:
      return "validation_error";
    case LOGBREW_ALLOCATION_ERROR:
      return "allocation_error";
    case LOGBREW_SERIALIZATION_ERROR:
      return "serialization_error";
    case LOGBREW_TRANSPORT_ERROR:
      return "transport_error";
    case LOGBREW_SHUTDOWN_ERROR:
      return "shutdown_error";
    default:
      return "unknown_error";
  }
}

static bool is_blank(const char *value) {
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

static LogBrewStatus require_non_empty(const char *label, const char *value, LogBrewError *error) {
  char message[160];
  if (!is_blank(value)) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s must be non-empty", label);
  set_error(error, "validation_error", message, false);
  return LOGBREW_VALIDATION_ERROR;
}

static bool string_equals_any(const char *value, const char *const *allowed, size_t allowed_count) {
  size_t index;
  for (index = 0; index < allowed_count; index++) {
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
  LogBrewStatus status = require_non_empty(label, value, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  if (string_equals_any(value, allowed, allowed_count)) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s has unsupported value: %s", label, value);
  set_error(error, "validation_error", message, false);
  return LOGBREW_VALIDATION_ERROR;
}

static LogBrewStatus normalize_severity(
    const char *label,
    const char *value,
    const char **normalized,
    LogBrewError *error) {
  static const char *const values[] = {"trace", "debug", "info", "warn", "warning", "error", "fatal", "critical"};
  LogBrewStatus status = require_allowed(label, value, values, sizeof(values) / sizeof(values[0]), error);
  if (status != LOGBREW_OK) {
    return status;
  }
  if (strcmp(value, "trace") == 0 || strcmp(value, "debug") == 0 || strcmp(value, "info") == 0) {
    *normalized = "info";
  } else if (strcmp(value, "warn") == 0 || strcmp(value, "warning") == 0) {
    *normalized = "warning";
  } else if (strcmp(value, "error") == 0) {
    *normalized = "error";
  } else {
    *normalized = "critical";
  }
  return LOGBREW_OK;
}

static LogBrewStatus require_timestamp(const char *timestamp, LogBrewError *error) {
  const char *time_part;
  LogBrewStatus status = require_non_empty("timestamp", timestamp, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  time_part = strchr(timestamp, 'T');
  if (time_part == NULL) {
    set_error(error, "validation_error", "timestamp must include a time separator", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (timestamp[strlen(timestamp) - 1U] == 'Z') {
    return LOGBREW_OK;
  }
  if (strchr(time_part, '+') != NULL) {
    return LOGBREW_OK;
  }
  if (strrchr(time_part + 1, '-') != NULL) {
    return LOGBREW_OK;
  }
  set_error(error, "validation_error", "timestamp must include a timezone offset", false);
  return LOGBREW_VALIDATION_ERROR;
}

static char *copy_string(const char *value) {
  size_t length;
  char *copy;
  if (value == NULL) {
    return NULL;
  }
  length = strlen(value);
  copy = (char *)malloc(length + 1U);
  if (copy == NULL) {
    return NULL;
  }
  memcpy(copy, value, length + 1U);
  return copy;
}

static void buffer_dispose(LogBrewBuffer *buffer) {
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0U;
  buffer->capacity = 0U;
}

static LogBrewStatus buffer_reserve(LogBrewBuffer *buffer, size_t extra, LogBrewError *error) {
  size_t required;
  size_t next_capacity;
  char *next;
  if (extra > ((size_t)-1) - buffer->length - 1U) {
    set_error(error, "allocation_error", "buffer size overflow", false);
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
    set_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  buffer->data = next;
  buffer->capacity = next_capacity;
  return LOGBREW_OK;
}

static LogBrewStatus buffer_append_n(LogBrewBuffer *buffer, const char *value, size_t length, LogBrewError *error) {
  LogBrewStatus status = buffer_reserve(buffer, length, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  memcpy(buffer->data + buffer->length, value, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return LOGBREW_OK;
}

static LogBrewStatus buffer_append(LogBrewBuffer *buffer, const char *value, LogBrewError *error) {
  return buffer_append_n(buffer, value, strlen(value), error);
}

static LogBrewStatus buffer_append_char(LogBrewBuffer *buffer, char value, LogBrewError *error) {
  return buffer_append_n(buffer, &value, 1U, error);
}

static LogBrewStatus buffer_append_format(LogBrewBuffer *buffer, LogBrewError *error, const char *format, ...) {
  va_list args;
  va_list copy;
  int needed;
  size_t length;
  LogBrewStatus status;
  va_start(args, format);
  va_copy(copy, args);
  needed = vsnprintf(NULL, 0U, format, copy);
  va_end(copy);
  if (needed < 0) {
    va_end(args);
    set_error(error, "serialization_error", "formatting failed", false);
    return LOGBREW_SERIALIZATION_ERROR;
  }
  length = (size_t)needed;
  status = buffer_reserve(buffer, length, error);
  if (status != LOGBREW_OK) {
    va_end(args);
    return status;
  }
  (void)vsnprintf(buffer->data + buffer->length, length + 1U, format, args);
  va_end(args);
  buffer->length += length;
  return LOGBREW_OK;
}

static LogBrewStatus append_json_string(LogBrewBuffer *buffer, const char *value, LogBrewError *error) {
  const unsigned char *cursor = (const unsigned char *)value;
  LogBrewStatus status = buffer_append_char(buffer, '"', error);
  if (status != LOGBREW_OK) {
    return status;
  }
  while (*cursor != '\0') {
    unsigned char current = *cursor;
    if (current == '"' || current == '\\') {
      status = buffer_append_char(buffer, '\\', error);
      if (status != LOGBREW_OK) {
        return status;
      }
      status = buffer_append_char(buffer, (char)current, error);
    } else if (current == '\n') {
      status = buffer_append(buffer, "\\n", error);
    } else if (current == '\r') {
      status = buffer_append(buffer, "\\r", error);
    } else if (current == '\t') {
      status = buffer_append(buffer, "\\t", error);
    } else if (current < 0x20U) {
      status = buffer_append_format(buffer, error, "\\u%04x", (unsigned int)current);
    } else {
      status = buffer_append_char(buffer, (char)current, error);
    }
    if (status != LOGBREW_OK) {
      return status;
    }
    cursor++;
  }
  return buffer_append_char(buffer, '"', error);
}

static LogBrewStatus append_named_string(
    LogBrewBuffer *buffer,
    const char *name,
    const char *value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status;
  if (*needs_comma) {
    status = buffer_append_char(buffer, ',', error);
    if (status != LOGBREW_OK) {
      return status;
    }
  }
  status = append_json_string(buffer, name, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  status = buffer_append_char(buffer, ':', error);
  if (status != LOGBREW_OK) {
    return status;
  }
  status = append_json_string(buffer, value, error);
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_optional_string(
    LogBrewBuffer *buffer,
    const char *name,
    const char *value,
    bool require_present_value,
    bool *needs_comma,
    LogBrewError *error) {
  if (value == NULL) {
    return LOGBREW_OK;
  }
  if (require_present_value && is_blank(value)) {
    char message[160];
    (void)snprintf(message, sizeof(message), "%s must be non-empty when provided", name);
    set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  return append_named_string(buffer, name, value, needs_comma, error);
}

static LogBrewStatus require_finite_number(const char *label, double value, LogBrewError *error) {
  char message[160];
  if (isfinite(value)) {
    return LOGBREW_OK;
  }
  (void)snprintf(message, sizeof(message), "%s must be finite", label);
  set_error(error, "validation_error", message, false);
  return LOGBREW_VALIDATION_ERROR;
}

static LogBrewStatus append_named_number(
    LogBrewBuffer *buffer,
    const char *name,
    double value,
    bool *needs_comma,
    LogBrewError *error) {
  LogBrewStatus status = require_finite_number(name, value, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  if (*needs_comma) {
    status = buffer_append_char(buffer, ',', error);
    if (status != LOGBREW_OK) {
      return status;
    }
  }
  status = append_json_string(buffer, name, error);
  if (status == LOGBREW_OK) {
    status = buffer_append_char(buffer, ':', error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append_format(buffer, error, "%.15g", value);
  }
  if (status == LOGBREW_OK) {
    *needs_comma = true;
  }
  return status;
}

static LogBrewStatus append_active_trace_metadata(LogBrewBuffer *buffer, bool *needs_comma, LogBrewError *error) {
  char *metadata_json = NULL;
  LogBrewStatus status = logbrew_trace_active_metadata_json(&metadata_json, error);
  if (status != LOGBREW_OK || metadata_json == NULL) {
    return status;
  }
  status = buffer_append(buffer, *needs_comma ? ",\"metadata\":" : "\"metadata\":", error);
  if (status == LOGBREW_OK) status = buffer_append(buffer, metadata_json, error);
  free(metadata_json);
  if (status == LOGBREW_OK) *needs_comma = true;
  return status;
}

static LogBrewStatus build_event_json(
    const char *event_type,
    const char *id,
    const char *timestamp,
    const char *attributes_json,
    char **out_json,
    LogBrewError *error) {
  LogBrewBuffer buffer = {0};
  LogBrewStatus status;
  *out_json = NULL;
  status = buffer_append(&buffer, "{\"type\":", error);
  if (status == LOGBREW_OK) {
    status = append_json_string(&buffer, event_type, error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append(&buffer, ",\"timestamp\":", error);
  }
  if (status == LOGBREW_OK) {
    status = append_json_string(&buffer, timestamp, error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append(&buffer, ",\"id\":", error);
  }
  if (status == LOGBREW_OK) {
    status = append_json_string(&buffer, id, error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append(&buffer, ",\"attributes\":", error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append(&buffer, attributes_json, error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append_char(&buffer, '}', error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  *out_json = buffer.data;
  return LOGBREW_OK;
}

static LogBrewStatus ensure_event_capacity(LogBrewClient *client, LogBrewError *error) {
  size_t next_capacity;
  LogBrewEvent *next;
  if (client->event_count < client->event_capacity) {
    return LOGBREW_OK;
  }
  next_capacity = client->event_capacity == 0U ? 8U : client->event_capacity * 2U;
  next = (LogBrewEvent *)realloc(client->events, next_capacity * sizeof(LogBrewEvent));
  if (next == NULL) {
    set_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  client->events = next;
  client->event_capacity = next_capacity;
  return LOGBREW_OK;
}

static void clear_events(LogBrewClient *client) {
  size_t index;
  for (index = 0U; index < client->event_count; index++) {
    free(client->events[index].json);
    client->events[index].json = NULL;
  }
  client->event_count = 0U;
}

static LogBrewStatus push_event(
    LogBrewClient *client,
    const char *event_type,
    const char *id,
    const char *timestamp,
    char *attributes_json,
    LogBrewError *error) {
  char *event_json = NULL;
  LogBrewStatus status;
  if (client == NULL) {
    free(attributes_json);
    set_error(error, "config_error", "client is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (client->closed) {
    free(attributes_json);
    set_error(error, "shutdown_error", "client is already shut down", false);
    return LOGBREW_SHUTDOWN_ERROR;
  }
  status = require_non_empty("id", id, error);
  if (status == LOGBREW_OK) {
    status = require_timestamp(timestamp, error);
  }
  if (status == LOGBREW_OK) {
    status = build_event_json(event_type, id, timestamp, attributes_json, &event_json, error);
  }
  free(attributes_json);
  if (status != LOGBREW_OK) {
    return status;
  }
  status = ensure_event_capacity(client, error);
  if (status != LOGBREW_OK) {
    free(event_json);
    return status;
  }
  client->events[client->event_count].json = event_json;
  client->event_count++;
  return LOGBREW_OK;
}

LogBrewStatus logbrew_client_push_event_json(
    LogBrewClient *client,
    const char *event_type,
    const char *id,
    const char *timestamp,
    char *attributes_json,
    LogBrewError *error) {
  return push_event(client, event_type, id, timestamp, attributes_json, error);
}

LogBrewStatus logbrew_client_push_action_json(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    char *attributes_json,
    LogBrewError *error) {
  return logbrew_client_push_event_json(client, "action", id, timestamp, attributes_json, error);
}

LogBrewStatus logbrew_client_new(LogBrewConfig config, LogBrewClient **out_client, LogBrewError *error) {
  LogBrewClient *client;
  LogBrewStatus status;
  if (out_client == NULL) {
    set_error(error, "config_error", "out_client is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  *out_client = NULL;
  status = require_non_empty("api_key", config.api_key, error);
  if (status == LOGBREW_OK) {
    status = require_non_empty("sdk_name", config.sdk_name, error);
  }
  if (status == LOGBREW_OK) {
    status = require_non_empty("sdk_version", config.sdk_version, error);
  }
  if (status != LOGBREW_OK) {
    return status;
  }
  client = (LogBrewClient *)calloc(1U, sizeof(LogBrewClient));
  if (client == NULL) {
    set_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  client->api_key = copy_string(config.api_key);
  client->sdk_name = copy_string(config.sdk_name);
  client->sdk_version = copy_string(config.sdk_version);
  if (client->api_key == NULL || client->sdk_name == NULL || client->sdk_version == NULL) {
    logbrew_client_free(client);
    set_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  client->max_retries = config.max_retries == 0U ? 2U : config.max_retries;
  *out_client = client;
  return LOGBREW_OK;
}

void logbrew_client_free(LogBrewClient *client) {
  if (client == NULL) {
    return;
  }
  clear_events(client);
  free(client->events);
  free(client->api_key);
  free(client->sdk_name);
  free(client->sdk_version);
  free(client);
}

size_t logbrew_client_pending_events(const LogBrewClient *client) {
  return client == NULL ? 0U : client->event_count;
}

void logbrew_free_string(char *value) {
  free(value);
}

LogBrewStatus logbrew_client_preview_json(const LogBrewClient *client, char **out_json, LogBrewError *error) {
  LogBrewBuffer buffer = {0};
  size_t index;
  LogBrewStatus status;
  if (out_json == NULL) {
    set_error(error, "config_error", "out_json is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  *out_json = NULL;
  if (client == NULL) {
    set_error(error, "config_error", "client is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  status = buffer_append(&buffer, "{\"sdk\":{\"name\":", error);
  if (status == LOGBREW_OK) {
    status = append_json_string(&buffer, client->sdk_name, error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append(&buffer, ",\"language\":\"c\",\"version\":", error);
  }
  if (status == LOGBREW_OK) {
    status = append_json_string(&buffer, client->sdk_version, error);
  }
  if (status == LOGBREW_OK) {
    status = buffer_append(&buffer, "},\"events\":[", error);
  }
  for (index = 0U; status == LOGBREW_OK && index < client->event_count; index++) {
    if (index > 0U) {
      status = buffer_append_char(&buffer, ',', error);
    }
    if (status == LOGBREW_OK) {
      status = buffer_append(&buffer, client->events[index].json, error);
    }
  }
  if (status == LOGBREW_OK) {
    status = buffer_append(&buffer, "]}", error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  *out_json = buffer.data;
  return LOGBREW_OK;
}

LogBrewStatus logbrew_client_flush(
    LogBrewClient *client,
    LogBrewTransport transport,
    LogBrewTransportResponse *response,
    LogBrewError *error) {
  char *body = NULL;
  size_t max_attempts;
  size_t attempt;
  LogBrewStatus status;
  if (response != NULL) {
    response->status_code = 0;
    response->attempts = 0U;
  }
  if (client == NULL) {
    set_error(error, "config_error", "client is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (client->closed) {
    set_error(error, "shutdown_error", "client is already shut down", false);
    return LOGBREW_SHUTDOWN_ERROR;
  }
  if (client->event_count == 0U) {
    if (response != NULL) {
      response->status_code = 204;
      response->attempts = 0U;
    }
    return LOGBREW_OK;
  }
  if (transport.send == NULL) {
    set_error(error, "config_error", "transport send callback is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  status = logbrew_client_preview_json(client, &body, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  max_attempts = client->max_retries + 1U;
  for (attempt = 1U; attempt <= max_attempts; attempt++) {
    LogBrewTransportResponse current = {0, attempt};
    LogBrewError transport_error = {{0}, {0}, false};
    status = transport.send(transport.user_data, client->api_key, body, &current, &transport_error);
    current.attempts = attempt;
    if (status == LOGBREW_OK) {
      if (current.status_code == 401) {
        logbrew_free_string(body);
        set_error(error, "unauthenticated", "transport rejected the API key", false);
        return LOGBREW_TRANSPORT_ERROR;
      }
      if (current.status_code >= 200 && current.status_code < 300) {
        if (response != NULL) {
          *response = current;
        }
        clear_events(client);
        logbrew_free_string(body);
        return LOGBREW_OK;
      }
      if (current.status_code >= 500 && attempt < max_attempts) {
        continue;
      }
      logbrew_free_string(body);
      set_error(error, "transport_error", "unexpected transport status", false);
      return LOGBREW_TRANSPORT_ERROR;
    }
    if (transport_error.retryable && attempt < max_attempts) {
      continue;
    }
    logbrew_free_string(body);
    set_error(error, transport_error.code[0] == '\0' ? "transport_error" : transport_error.code,
              transport_error.message[0] == '\0' ? "transport failed" : transport_error.message,
              transport_error.retryable);
    return LOGBREW_TRANSPORT_ERROR;
  }
  logbrew_free_string(body);
  set_error(error, "transport_error", "exhausted retry budget", false);
  return LOGBREW_TRANSPORT_ERROR;
}

LogBrewStatus logbrew_client_shutdown(
    LogBrewClient *client,
    LogBrewTransport transport,
    LogBrewTransportResponse *response,
    LogBrewError *error) {
  LogBrewStatus status;
  if (client == NULL) {
    set_error(error, "config_error", "client is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (client->closed) {
    set_error(error, "shutdown_error", "client is already shut down", false);
    return LOGBREW_SHUTDOWN_ERROR;
  }
  status = logbrew_client_flush(client, transport, response, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  client->closed = true;
  return LOGBREW_OK;
}

static LogBrewStatus start_attributes(LogBrewBuffer *buffer, LogBrewError *error) {
  return buffer_append_char(buffer, '{', error);
}

static LogBrewStatus finish_attributes(LogBrewBuffer *buffer, char **out_json, LogBrewError *error) {
  LogBrewStatus status = buffer_append_char(buffer, '}', error);
  if (status != LOGBREW_OK) {
    buffer_dispose(buffer);
    return status;
  }
  *out_json = buffer->data;
  return LOGBREW_OK;
}

LogBrewStatus logbrew_client_release(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewReleaseAttributes attributes,
    LogBrewError *error) {
  LogBrewBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  LogBrewStatus status = require_non_empty("release version", attributes.version, error);
  if (status == LOGBREW_OK) {
    status = start_attributes(&buffer, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "version", attributes.version, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(&buffer, "commit", attributes.commit, true, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(&buffer, "notes", attributes.notes, false, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = finish_attributes(&buffer, &attributes_json, error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  return push_event(client, "release", id, timestamp, attributes_json, error);
}

LogBrewStatus logbrew_client_environment(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewEnvironmentAttributes attributes,
    LogBrewError *error) {
  LogBrewBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  LogBrewStatus status = require_non_empty("environment name", attributes.name, error);
  if (status == LOGBREW_OK) {
    status = start_attributes(&buffer, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "name", attributes.name, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(&buffer, "region", attributes.region, false, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = finish_attributes(&buffer, &attributes_json, error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  return push_event(client, "environment", id, timestamp, attributes_json, error);
}

LogBrewStatus logbrew_client_issue(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewIssueAttributes attributes,
    LogBrewError *error) {
  LogBrewBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  const char *level = NULL;
  LogBrewStatus status = require_non_empty("issue title", attributes.title, error);
  if (status == LOGBREW_OK) {
    status = normalize_severity("issue level", attributes.level, &level, error);
  }
  if (status == LOGBREW_OK) {
    status = start_attributes(&buffer, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "title", attributes.title, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "level", level, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(&buffer, "message", attributes.message, false, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_active_trace_metadata(&buffer, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = finish_attributes(&buffer, &attributes_json, error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  return push_event(client, "issue", id, timestamp, attributes_json, error);
}

LogBrewStatus logbrew_client_log(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewLogAttributes attributes,
    LogBrewError *error) {
  LogBrewBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  const char *level = NULL;
  LogBrewStatus status = require_non_empty("log message", attributes.message, error);
  if (status == LOGBREW_OK) {
    status = normalize_severity("log level", attributes.level, &level, error);
  }
  if (status == LOGBREW_OK) {
    status = start_attributes(&buffer, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "message", attributes.message, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "level", level, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(&buffer, "logger", attributes.logger, false, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_active_trace_metadata(&buffer, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = finish_attributes(&buffer, &attributes_json, error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  return push_event(client, "log", id, timestamp, attributes_json, error);
}

LogBrewStatus logbrew_client_span(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewSpanAttributes attributes,
    LogBrewError *error) {
  static const char *const statuses[] = {"ok", "error"};
  LogBrewBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  LogBrewStatus status = require_non_empty("span name", attributes.name, error);
  if (status == LOGBREW_OK) {
    status = require_non_empty("span trace_id", attributes.trace_id, error);
  }
  if (status == LOGBREW_OK) {
    status = require_non_empty("span span_id", attributes.span_id, error);
  }
  if (status == LOGBREW_OK) {
    status = require_allowed("span status", attributes.status, statuses, sizeof(statuses) / sizeof(statuses[0]), error);
  }
  if (status == LOGBREW_OK && attributes.has_duration_ms && attributes.duration_ms < 0.0) {
    set_error(error, "validation_error", "span duration_ms must be non-negative", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK) {
    status = start_attributes(&buffer, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "name", attributes.name, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "traceId", attributes.trace_id, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "spanId", attributes.span_id, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(&buffer, "parentSpanId", attributes.parent_span_id, true, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "status", attributes.status, &needs_comma, error);
  }
  if (status == LOGBREW_OK && attributes.has_duration_ms) {
    status = append_named_number(&buffer, "durationMs", attributes.duration_ms, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = finish_attributes(&buffer, &attributes_json, error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  return push_event(client, "span", id, timestamp, attributes_json, error);
}

LogBrewStatus logbrew_client_action(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewActionAttributes attributes,
    LogBrewError *error) {
  static const char *const statuses[] = {"queued", "running", "success", "failure"};
  LogBrewBuffer buffer = {0};
  bool needs_comma = false;
  char *attributes_json = NULL;
  LogBrewStatus status = require_non_empty("action name", attributes.name, error);
  if (status == LOGBREW_OK) {
    status = require_allowed("action status", attributes.status, statuses, sizeof(statuses) / sizeof(statuses[0]), error);
  }
  if (status == LOGBREW_OK) {
    status = start_attributes(&buffer, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "name", attributes.name, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(&buffer, "status", attributes.status, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_active_trace_metadata(&buffer, &needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = finish_attributes(&buffer, &attributes_json, error);
  }
  if (status != LOGBREW_OK) {
    buffer_dispose(&buffer);
    return status;
  }
  return push_event(client, "action", id, timestamp, attributes_json, error);
}

void logbrew_recording_transport_init(
    LogBrewRecordingTransport *transport,
    const LogBrewRecordingStep *steps,
    size_t step_count) {
  if (transport == NULL) {
    return;
  }
  transport->steps = steps;
  transport->step_count = step_count;
  transport->cursor = 0U;
  transport->sent_bodies = NULL;
  transport->sent_count = 0U;
  transport->sent_capacity = 0U;
}

void logbrew_recording_transport_free(LogBrewRecordingTransport *transport) {
  size_t index;
  if (transport == NULL) {
    return;
  }
  for (index = 0U; index < transport->sent_count; index++) {
    free(transport->sent_bodies[index]);
  }
  free(transport->sent_bodies);
  transport->sent_bodies = NULL;
  transport->sent_count = 0U;
  transport->sent_capacity = 0U;
}
