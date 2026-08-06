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

static bool timeline_metadata_key_is_reserved(const char *key) {
  static const char *const reserved[] = {
    "source", "sessionId", "traceId", "routeTemplate", "screen", "funnel", "step",
    "method", "statusCode", "durationMs", "analyticsSchemaVersion", "analyticsKind",
    "analyticsSurface"
  };
  size_t index;
  for (index = 0U; index < sizeof(reserved) / sizeof(reserved[0]); index++) {
    if (strcmp(key, reserved[index]) == 0) {
      return true;
    }
  }
  return false;
}

static LogBrewStatus append_metadata(
    LogBrewTimelineBuffer *buffer,
    LogBrewMetadata metadata,
    LogBrewMetadata overridden_by,
    bool skip_timeline_reserved,
    bool *needs_comma,
    LogBrewError *error) {
  size_t index;
  size_t prior;
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
    for (prior = 0U; prior < index; prior++) {
      if (strcmp(metadata.entries[prior].key, entry.key) == 0) {
        set_timeline_error(error, "validation_error", "metadata contains a duplicate key");
        return LOGBREW_VALIDATION_ERROR;
      }
    }
    for (prior = 0U; prior < overridden_by.count; prior++) {
      if (overridden_by.entries != NULL && overridden_by.entries[prior].key != NULL &&
          strcmp(overridden_by.entries[prior].key, entry.key) == 0) {
        break;
      }
    }
    if (prior < overridden_by.count ||
        (skip_timeline_reserved && timeline_metadata_key_is_reserved(entry.key))) {
      continue;
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
    } else if (entry.kind == LOGBREW_METADATA_NULL) {
      status = *needs_comma ? timeline_append_char(buffer, ',', error) : LOGBREW_OK;
      if (status == LOGBREW_OK) status = append_json_string(buffer, entry.key, error);
      if (status == LOGBREW_OK) status = timeline_append(buffer, ":null", error);
      if (status == LOGBREW_OK) *needs_comma = true;
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

static LogBrewStatus validate_timeline_metadata(
    LogBrewMetadata base,
    LogBrewMetadata override,
    LogBrewError *error) {
  LogBrewStatus status;
  if (base.count > LOGBREW_MAX_METADATA_ENTRIES ||
      override.count > LOGBREW_MAX_METADATA_ENTRIES ||
      base.count > LOGBREW_MAX_METADATA_ENTRIES - override.count) {
    set_timeline_error(error, "validation_error", "metadata contains too many entries");
    return LOGBREW_VALIDATION_ERROR;
  }
  status = logbrew_json_validate_metadata(
      base, "metadata", LOGBREW_MAX_METADATA_ENTRIES, false,
      LOGBREW_MAX_METADATA_STRING_LENGTH, error);
  if (status == LOGBREW_OK) {
    status = logbrew_json_validate_metadata(
        override, "metadata", LOGBREW_MAX_METADATA_ENTRIES, false,
        LOGBREW_MAX_METADATA_STRING_LENGTH, error);
  }
  return status;
}

static LogBrewStatus append_timeline_metadata(
    LogBrewTimelineBuffer *buffer,
    const char *source,
    LogBrewProductTimelineContext context,
    LogBrewMetadata metadata,
    LogBrewMetadata override_metadata,
    const char *analytics_surface,
    bool *needs_comma,
    LogBrewError *error) {
  bool metadata_needs_comma = false;
  LogBrewStatus status = validate_timeline_metadata(metadata, override_metadata, error);
  if (status == LOGBREW_OK) {
    status = append_timeline_metadata_start(
        buffer, source, context, needs_comma, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_metadata(buffer, metadata, override_metadata, true, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_metadata(buffer, override_metadata, (LogBrewMetadata){NULL, 0U}, true,
                             &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_number(buffer, "analyticsSchemaVersion", 1.0, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_named_string(buffer, "analyticsKind", "interaction", &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_optional_string(buffer, "analyticsSurface", analytics_surface, &metadata_needs_comma, error);
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
    LogBrewMetadata override_metadata,
    bool *needs_comma,
    LogBrewError *error) {
  bool metadata_needs_comma = false;
  LogBrewStatus status = validate_timeline_metadata(
      attributes.metadata, override_metadata, error);
  if (status == LOGBREW_OK) {
    status = append_timeline_metadata_start(
        buffer, "c.network", context, needs_comma, &metadata_needs_comma, error);
  }
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
    status = append_metadata(buffer, attributes.metadata, override_metadata, true, &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_metadata(buffer, override_metadata, (LogBrewMetadata){NULL, 0U}, true,
                             &metadata_needs_comma, error);
  }
  if (status == LOGBREW_OK) {
    status = append_timeline_metadata_finish(buffer, needs_comma, error);
  }
  return status;
}

static bool timeline_scheme_equals(
    const char *start,
    const char *end,
    const char *expected) {
  size_t index;
  size_t length = (size_t)(end - start);
  if (length != strlen(expected)) {
    return false;
  }
  for (index = 0U; index < length; index++) {
    unsigned char current = (unsigned char)start[index];
    char normalized = current >= (unsigned char)'A' && current <= (unsigned char)'Z'
        ? (char)(current + ((unsigned char)'a' - (unsigned char)'A'))
        : (char)current;
    if (normalized != expected[index]) {
      return false;
    }
  }
  return true;
}

static bool timeline_uri_scheme_prefix(const char *start, const char *colon) {
  const char *cursor;
  bool starts_with_alpha =
      ((unsigned char)start[0] >= (unsigned char)'A' &&
       (unsigned char)start[0] <= (unsigned char)'Z') ||
      ((unsigned char)start[0] >= (unsigned char)'a' &&
       (unsigned char)start[0] <= (unsigned char)'z');
  if (colon <= start || !starts_with_alpha) {
    return false;
  }
  for (cursor = start + 1; cursor < colon; cursor++) {
    unsigned char current = (unsigned char)*cursor;
    if (!((current >= (unsigned char)'A' && current <= (unsigned char)'Z') ||
          (current >= (unsigned char)'a' && current <= (unsigned char)'z') ||
          (current >= (unsigned char)'0' && current <= (unsigned char)'9') ||
          current == (unsigned char)'+' || current == (unsigned char)'-' ||
          current == (unsigned char)'.')) {
      return false;
    }
  }
  return true;
}

static bool timeline_route_has_forbidden_control(const unsigned char *value, size_t length) {
  size_t index;
  for (index = 0U; index < length; index++) {
    if (value[index] < 0x20U || value[index] == 0x7fU ||
        (value[index] == 0xc2U && index + 1U < length &&
         value[index + 1U] >= 0x80U && value[index + 1U] <= 0x9fU)) {
      return true;
    }
  }
  return false;
}

static LogBrewStatus copy_sanitized_route(const char *route_template, char **out_route, LogBrewError *error) {
  const char *start = route_template;
  const char *end;
  const char *scheme;
  const char *colon;
  const char *boundary;
  size_t raw_length;
  size_t length;
  char *copy;
  *out_route = NULL;
  if (require_text("route_template", route_template, error) != LOGBREW_OK) {
    return LOGBREW_VALIDATION_ERROR;
  }
  raw_length = strlen(route_template);
  if (raw_length > 8192U || isspace((unsigned char)route_template[0]) ||
      isspace((unsigned char)route_template[raw_length - 1U]) ||
      timeline_route_has_forbidden_control((const unsigned char *)route_template, raw_length)) {
    set_timeline_error(error, "validation_error", "route_template is invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (start[0] == '/' && start[1] == '/') {
    set_timeline_error(error, "validation_error", "route_template must not use a protocol-relative host");
    return LOGBREW_VALIDATION_ERROR;
  }
  scheme = strstr(route_template, "://");
  if (scheme != NULL) {
    const char *authority;
    const char *authority_end;
    if (!(timeline_scheme_equals(route_template, scheme, "http") ||
          timeline_scheme_equals(route_template, scheme, "https"))) {
      set_timeline_error(error, "validation_error", "route_template uses an unsupported URL scheme");
      return LOGBREW_VALIDATION_ERROR;
    }
    authority = scheme + 3;
    authority_end = authority + strcspn(authority, "/?#");
    if (authority_end == authority) {
      set_timeline_error(error, "validation_error", "route_template URL host is invalid");
      return LOGBREW_VALIDATION_ERROR;
    }
    start = *authority_end == '/' ? authority_end : "/";
  } else {
    colon = strchr(route_template, ':');
    boundary = strpbrk(route_template, "/?#");
    if (colon != NULL && (boundary == NULL || colon < boundary) &&
        timeline_uri_scheme_prefix(route_template, colon)) {
      set_timeline_error(error, "validation_error", "route_template uses an unsupported URL scheme");
      return LOGBREW_VALIDATION_ERROR;
    }
  }
  end = start + strcspn(start, "?#");
  length = (size_t)(end - start);
  if (length == 0U || length > 2048U) {
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

static LogBrewStatus copy_bounded_product_analytics_surface(
    const char *surface,
    char **out_surface,
    LogBrewError *error) {
  const unsigned char *start = (const unsigned char *)surface;
  const unsigned char *end;
  const unsigned char *cursor;
  size_t character_count = 0U;
  size_t length;
  char *copy;
  *out_surface = NULL;
  if (surface == NULL) {
    return LOGBREW_OK;
  }
  while (*start != '\0' && isspace(*start)) {
    start++;
  }
  end = start + strlen((const char *)start);
  while (end > start && isspace(*(end - 1))) {
    end--;
  }
  if (end == start) {
    return LOGBREW_OK;
  }
  for (cursor = start; cursor < end; cursor++) {
    if (*cursor < 0x20U || *cursor == 0x7FU) {
      return LOGBREW_OK;
    }
    if (*cursor == 0xC2U && cursor + 1 < end &&
        *(cursor + 1) >= 0x80U && *(cursor + 1) <= 0x9FU) {
      return LOGBREW_OK;
    }
    if ((*cursor & 0xC0U) != 0x80U) {
      character_count++;
      if (character_count > 256U) {
        return LOGBREW_OK;
      }
    }
  }
  length = (size_t)(end - start);
  copy = (char *)malloc(length + 1U);
  if (copy == NULL) {
    set_timeline_error(error, "allocation_error", "out of memory");
    return LOGBREW_ALLOCATION_ERROR;
  }
  memcpy(copy, start, length);
  copy[length] = '\0';
  *out_surface = copy;
  return LOGBREW_OK;
}

static LogBrewStatus copy_upper_method(const char *method, char out_method[16], LogBrewError *error) {
  size_t index;
  LogBrewStatus status = require_text("method", method, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  for (index = 0U; method[index] != '\0'; index++) {
    unsigned char current = (unsigned char)method[index];
    if (index + 1U >= 16U) {
      set_timeline_error(error, "validation_error", "method is too long");
      return LOGBREW_VALIDATION_ERROR;
    }
    if (!((current >= (unsigned char)'A' && current <= (unsigned char)'Z') ||
          (current >= (unsigned char)'a' && current <= (unsigned char)'z') ||
          (current >= (unsigned char)'0' && current <= (unsigned char)'9') ||
          strchr("!#$%&'*+-.^_`|~", (int)current) != NULL)) {
      set_timeline_error(error, "validation_error", "method contains invalid HTTP characters");
      return LOGBREW_VALIDATION_ERROR;
    }
    out_method[index] = current >= (unsigned char)'a' && current <= (unsigned char)'z'
        ? (char)(current - ((unsigned char)'a' - (unsigned char)'A'))
        : (char)current;
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
  return logbrew_client_product_action_with_options(
      client, id, timestamp, attributes, LOGBREW_EVENT_OPTIONS_NONE, error);
}

LogBrewStatus logbrew_client_product_action_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewProductActionAttributes attributes,
    LogBrewEventOptions options,
    LogBrewError *error) {
  LogBrewTimelineBuffer buffer = {0};
  bool needs_comma = false;
  char *sanitized_route = NULL;
  char *analytics_surface = NULL;
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
    status = copy_bounded_product_analytics_surface(
        sanitized_route != NULL ? sanitized_route : context.screen,
        &analytics_surface,
        error);
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
    status = append_timeline_metadata(
        &buffer,
        "c.action",
        context,
        attributes.metadata,
        options.metadata,
        analytics_surface,
        &needs_comma,
        error);
  }
  if (status == LOGBREW_OK) {
    status = timeline_append_char(&buffer, '}', error);
  }
  free(sanitized_route);
  free(analytics_surface);
  if (status != LOGBREW_OK) {
    free(buffer.data);
    return status;
  }
  return logbrew_client_push_event_json_with_context(
      client, "action", id, timestamp, buffer.data, options.context, NULL, error);
}

LogBrewStatus logbrew_client_network_milestone(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewNetworkMilestoneAttributes attributes,
    LogBrewError *error) {
  return logbrew_client_network_milestone_with_options(
      client, id, timestamp, attributes, LOGBREW_EVENT_OPTIONS_NONE, error);
}

LogBrewStatus logbrew_client_network_milestone_with_options(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    LogBrewNetworkMilestoneAttributes attributes,
    LogBrewEventOptions options,
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
        options.metadata,
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
  return logbrew_client_push_event_json_with_context(
      client, "action", id, timestamp, buffer.data, options.context, NULL, error);
}
