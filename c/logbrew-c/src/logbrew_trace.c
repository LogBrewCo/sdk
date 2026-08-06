#include "logbrew.h"

#include <ctype.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(_MSC_VER)
#define LOGBREW_THREAD_LOCAL __declspec(thread)
#elif defined(__GNUC__) || defined(__clang__)
#define LOGBREW_THREAD_LOCAL __thread
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define LOGBREW_THREAD_LOCAL _Thread_local
#else
#error "LogBrew trace scopes require compiler thread-local storage support"
#endif

static LOGBREW_THREAD_LOCAL const LogBrewTraceContext *current_context = NULL;
static LOGBREW_THREAD_LOCAL unsigned long long id_counter = 0x9e3779b97f4a7c15ULL;

static bool trace_scope_is_in_active_chain(const LogBrewTraceScope *candidate) {
  const LogBrewTraceContext *cursor = current_context;
  while (cursor != NULL) {
    const LogBrewTraceScope *active_scope = (const LogBrewTraceScope *)(const void *)cursor;
    if (active_scope == candidate) {
      return true;
    }
    if (!active_scope->active || active_scope->owner != active_scope) {
      return false;
    }
    cursor = active_scope->previous;
  }
  return false;
}

static void set_trace_error(LogBrewError *error, const char *code, const char *message) {
  if (error == NULL) {
    return;
  }
  (void)snprintf(error->code, sizeof(error->code), "%s", code == NULL ? "trace_error" : code);
  (void)snprintf(error->message, sizeof(error->message), "%s", message == NULL ? "" : message);
  error->retryable = false;
}

static bool trace_blank(const char *value) {
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

static bool is_hex_char(char value) {
  return (value >= '0' && value <= '9') ||
         (value >= 'a' && value <= 'f') ||
         (value >= 'A' && value <= 'F');
}

static char lower_hex_char(char value) {
  return (char)tolower((unsigned char)value);
}

static bool hex_part_is_valid(const char *value, size_t offset, size_t length) {
  size_t index;
  bool any_non_zero = false;
  for (index = 0U; index < length; index++) {
    char current = value[offset + index];
    if (!is_hex_char(current)) {
      return false;
    }
    if (current != '0') {
      any_non_zero = true;
    }
  }
  return any_non_zero;
}

static void copy_lower_hex(char *destination, const char *source, size_t offset, size_t length) {
  size_t index;
  for (index = 0U; index < length; index++) {
    destination[index] = lower_hex_char(source[offset + index]);
  }
  destination[length] = '\0';
}

static bool trace_flags_are_sampled(const char *trace_flags) {
  char low_nibble = lower_hex_char(trace_flags[1]);
  return (low_nibble == '1' ||
          low_nibble == '3' ||
          low_nibble == '5' ||
          low_nibble == '7' ||
          low_nibble == '9' ||
          low_nibble == 'b' ||
          low_nibble == 'd' ||
          low_nibble == 'f');
}

static LogBrewStatus validate_trace_context(const LogBrewTraceContext *context, LogBrewError *error) {
  if (context == NULL) {
    set_trace_error(error, "config_error", "trace context is required");
    return LOGBREW_CONFIG_ERROR;
  }
  if (trace_blank(context->trace_id) || trace_blank(context->span_id) || trace_blank(context->trace_flags)) {
    set_trace_error(error, "validation_error", "trace context is incomplete");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (strlen(context->trace_id) != LOGBREW_TRACE_ID_LENGTH ||
      strlen(context->span_id) != LOGBREW_SPAN_ID_LENGTH ||
      strlen(context->trace_flags) != LOGBREW_TRACE_FLAGS_LENGTH ||
      !hex_part_is_valid(context->trace_id, 0U, LOGBREW_TRACE_ID_LENGTH) ||
      !hex_part_is_valid(context->span_id, 0U, LOGBREW_SPAN_ID_LENGTH) ||
      !is_hex_char(context->trace_flags[0]) ||
      !is_hex_char(context->trace_flags[1]) ||
      (!trace_blank(context->parent_span_id) &&
       (strlen(context->parent_span_id) != LOGBREW_SPAN_ID_LENGTH ||
        !hex_part_is_valid(context->parent_span_id, 0U, LOGBREW_SPAN_ID_LENGTH))) ||
      context->sampled != trace_flags_are_sampled(context->trace_flags)) {
    set_trace_error(error, "validation_error", "trace context is invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  return LOGBREW_OK;
}

static LogBrewStatus normalize_http_method(const char *method, char *out_method, size_t out_size, LogBrewError *error) {
  const unsigned char *cursor = (const unsigned char *)method;
  size_t count = 0U;
  if (trace_blank(method)) {
    set_trace_error(error, "validation_error", "HTTP client method must be non-empty");
    return LOGBREW_VALIDATION_ERROR;
  }
  while (*cursor != '\0') {
    if (isspace(*cursor)) {
      cursor++;
      continue;
    }
    if (!isalpha(*cursor)) {
      set_trace_error(error, "validation_error", "HTTP client method must contain only letters");
      return LOGBREW_VALIDATION_ERROR;
    }
    if (count + 1U >= out_size) {
      set_trace_error(error, "validation_error", "HTTP client method is too long");
      return LOGBREW_VALIDATION_ERROR;
    }
    out_method[count++] = (char)toupper(*cursor);
    cursor++;
  }
  if (count == 0U) {
    set_trace_error(error, "validation_error", "HTTP client method must be non-empty");
    return LOGBREW_VALIDATION_ERROR;
  }
  out_method[count] = '\0';
  return LOGBREW_OK;
}

static bool trace_scheme_equals(const char *start, const char *end, const char *expected) {
  size_t index;
  size_t length = (size_t)(end - start);
  if (length != strlen(expected)) {
    return false;
  }
  for (index = 0U; index < length; index++) {
    if (lower_hex_char(start[index]) != expected[index]) {
      return false;
    }
  }
  return true;
}

static bool trace_uri_scheme_prefix(const char *start, const char *colon) {
  const char *cursor;
  if (colon <= start || !isalpha((unsigned char)start[0])) {
    return false;
  }
  for (cursor = start + 1; cursor < colon; cursor++) {
    unsigned char current = (unsigned char)*cursor;
    if (!isalnum(current) && current != (unsigned char)'+' &&
        current != (unsigned char)'-' && current != (unsigned char)'.') {
      return false;
    }
  }
  return true;
}

static bool trace_route_has_forbidden_control(const unsigned char *value, size_t length) {
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

static LogBrewStatus sanitize_http_route(const char *route_template, char *out_route, size_t out_size, LogBrewError *error) {
  const char *start = route_template;
  const char *scheme;
  const char *colon;
  const char *boundary;
  const char *query;
  const char *hash;
  const char *end;
  size_t raw_length;
  size_t length;
  if (trace_blank(route_template)) {
    set_trace_error(error, "validation_error", "HTTP client route_template must be non-empty");
    return LOGBREW_VALIDATION_ERROR;
  }
  raw_length = strlen(route_template);
  if (raw_length > 8192U || isspace((unsigned char)route_template[0]) ||
      isspace((unsigned char)route_template[raw_length - 1U]) ||
      trace_route_has_forbidden_control((const unsigned char *)route_template, raw_length)) {
    set_trace_error(error, "validation_error", "HTTP client route_template is invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (start[0] == '/' && start[1] == '/') {
    set_trace_error(error, "validation_error", "HTTP client route_template must not use a protocol-relative host");
    return LOGBREW_VALIDATION_ERROR;
  }
  scheme = strstr(route_template, "://");
  if (scheme != NULL) {
    const char *authority;
    const char *authority_end;
    if (!(trace_scheme_equals(route_template, scheme, "http") ||
          trace_scheme_equals(route_template, scheme, "https"))) {
      set_trace_error(error, "validation_error", "HTTP client route_template uses an unsupported URL scheme");
      return LOGBREW_VALIDATION_ERROR;
    }
    authority = scheme + 3U;
    authority_end = authority + strcspn(authority, "/?#");
    if (authority_end == authority) {
      set_trace_error(error, "validation_error", "HTTP client route_template URL host is invalid");
      return LOGBREW_VALIDATION_ERROR;
    }
    start = *authority_end == '/' ? authority_end : "/";
  } else {
    colon = strchr(route_template, ':');
    boundary = strpbrk(route_template, "/?#");
    if (colon != NULL && (boundary == NULL || colon < boundary) &&
        trace_uri_scheme_prefix(route_template, colon)) {
      set_trace_error(error, "validation_error", "HTTP client route_template uses an unsupported URL scheme");
      return LOGBREW_VALIDATION_ERROR;
    }
  }
  query = strchr(start, '?');
  hash = strchr(start, '#');
  end = start + strlen(start);
  if (query != NULL && query < end) {
    end = query;
  }
  if (hash != NULL && hash < end) {
    end = hash;
  }
  while (end > start && isspace((unsigned char)*(end - 1))) {
    end--;
  }
  while (*start != '\0' && isspace((unsigned char)*start)) {
    start++;
  }
  length = (size_t)(end - start);
  if (length == 0U) {
    set_trace_error(error, "validation_error", "HTTP client route_template must include a path before query or fragment");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (length >= out_size) {
    set_trace_error(error, "validation_error", "HTTP client route_template is too long");
    return LOGBREW_VALIDATION_ERROR;
  }
  memcpy(out_route, start, length);
  out_route[length] = '\0';
  return LOGBREW_OK;
}

static unsigned long long mix_seed(void) {
  uintptr_t address = (uintptr_t)&id_counter;
  unsigned long long seed;
  id_counter += 0x9e3779b97f4a7c15ULL;
  seed = id_counter ^ ((unsigned long long)time(NULL) << 21U) ^ (unsigned long long)clock();
  seed ^= (unsigned long long)address;
  seed ^= seed >> 12U;
  seed ^= seed << 25U;
  seed ^= seed >> 27U;
  return seed * 2685821657736338717ULL;
}

static void fill_generated_hex(char *destination, size_t length) {
  static const char hex[] = "0123456789abcdef";
  unsigned long long state = mix_seed();
  size_t index;
  bool any_non_zero = false;
  for (index = 0U; index < length; index++) {
    state ^= state << 13U;
    state ^= state >> 7U;
    state ^= state << 17U;
    destination[index] = hex[(state >> ((index % 16U) * 4U)) & 0x0fU];
    if (destination[index] != '0') {
      any_non_zero = true;
    }
  }
  if (!any_non_zero && length > 0U) {
    destination[length - 1U] = '1';
  }
  destination[length] = '\0';
}

LogBrewStatus logbrew_trace_root_context(LogBrewTraceContext *out_context, LogBrewError *error) {
  if (out_context == NULL) {
    set_trace_error(error, "config_error", "out_context is required");
    return LOGBREW_CONFIG_ERROR;
  }
  memset(out_context, 0, sizeof(*out_context));
  fill_generated_hex(out_context->trace_id, LOGBREW_TRACE_ID_LENGTH);
  fill_generated_hex(out_context->span_id, LOGBREW_SPAN_ID_LENGTH);
  (void)snprintf(out_context->trace_flags, sizeof(out_context->trace_flags), "%s", "01");
  out_context->sampled = true;
  return LOGBREW_OK;
}

LogBrewStatus logbrew_trace_context_from_traceparent(
    const char *traceparent,
    LogBrewTraceContext *out_context,
    LogBrewError *error) {
  if (out_context == NULL) {
    set_trace_error(error, "config_error", "out_context is required");
    return LOGBREW_CONFIG_ERROR;
  }
  memset(out_context, 0, sizeof(*out_context));
  if (trace_blank(traceparent)) {
    set_trace_error(error, "validation_error", "traceparent must be non-empty");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (strlen(traceparent) != LOGBREW_TRACEPARENT_LENGTH ||
      traceparent[2] != '-' ||
      traceparent[35] != '-' ||
      traceparent[52] != '-') {
    set_trace_error(error, "validation_error", "traceparent must use W3C version-traceid-spanid-flags shape");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (!is_hex_char(traceparent[0]) || !is_hex_char(traceparent[1]) ||
      (lower_hex_char(traceparent[0]) == 'f' && lower_hex_char(traceparent[1]) == 'f')) {
    set_trace_error(error, "validation_error", "traceparent version is invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (!hex_part_is_valid(traceparent, 3U, LOGBREW_TRACE_ID_LENGTH)) {
    set_trace_error(error, "validation_error", "traceparent trace id is invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (!hex_part_is_valid(traceparent, 36U, LOGBREW_SPAN_ID_LENGTH)) {
    set_trace_error(error, "validation_error", "traceparent span id is invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (!is_hex_char(traceparent[53]) || !is_hex_char(traceparent[54])) {
    set_trace_error(error, "validation_error", "traceparent trace flags are invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  copy_lower_hex(out_context->trace_id, traceparent, 3U, LOGBREW_TRACE_ID_LENGTH);
  copy_lower_hex(out_context->parent_span_id, traceparent, 36U, LOGBREW_SPAN_ID_LENGTH);
  copy_lower_hex(out_context->trace_flags, traceparent, 53U, LOGBREW_TRACE_FLAGS_LENGTH);
  fill_generated_hex(out_context->span_id, LOGBREW_SPAN_ID_LENGTH);
  out_context->sampled = trace_flags_are_sampled(out_context->trace_flags);
  return LOGBREW_OK;
}

LogBrewStatus logbrew_trace_continue_or_create_context(
    const char *traceparent,
    LogBrewTraceContext *out_context,
    LogBrewError *error) {
  LogBrewError ignored;
  if (!trace_blank(traceparent) &&
      logbrew_trace_context_from_traceparent(traceparent, out_context, &ignored) == LOGBREW_OK) {
    return LOGBREW_OK;
  }
  logbrew_error_clear(error);
  return logbrew_trace_root_context(out_context, error);
}

LogBrewStatus logbrew_trace_child_context(
    const LogBrewTraceContext *parent,
    LogBrewTraceContext *out_context,
    LogBrewError *error) {
  LogBrewStatus status = validate_trace_context(parent, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  if (out_context == NULL) {
    set_trace_error(error, "config_error", "out_context is required");
    return LOGBREW_CONFIG_ERROR;
  }
  memset(out_context, 0, sizeof(*out_context));
  (void)snprintf(out_context->trace_id, sizeof(out_context->trace_id), "%s", parent->trace_id);
  (void)snprintf(out_context->parent_span_id, sizeof(out_context->parent_span_id), "%s", parent->span_id);
  (void)snprintf(out_context->trace_flags, sizeof(out_context->trace_flags), "%s", parent->trace_flags);
  out_context->sampled = parent->sampled;
  fill_generated_hex(out_context->span_id, LOGBREW_SPAN_ID_LENGTH);
  return LOGBREW_OK;
}

LogBrewStatus logbrew_trace_context_from_opentelemetry_span_context(
    LogBrewOpenTelemetrySpanContext context,
    LogBrewTraceContext *out_context,
    LogBrewError *error) {
  char traceparent[LOGBREW_TRACEPARENT_LENGTH + 1U];
  int written;
  if (out_context == NULL) {
    set_trace_error(error, "config_error", "out_context is required");
    return LOGBREW_CONFIG_ERROR;
  }
  if (trace_blank(context.trace_id) || trace_blank(context.span_id) || trace_blank(context.trace_flags)) {
    memset(out_context, 0, sizeof(*out_context));
    set_trace_error(error, "validation_error", "OpenTelemetry span context is incomplete");
    return LOGBREW_VALIDATION_ERROR;
  }
  written = snprintf(traceparent, sizeof(traceparent), "00-%s-%s-%s",
                     context.trace_id, context.span_id, context.trace_flags);
  if (written != (int)LOGBREW_TRACEPARENT_LENGTH) {
    memset(out_context, 0, sizeof(*out_context));
    set_trace_error(error, "validation_error", "OpenTelemetry span context is invalid");
    return LOGBREW_VALIDATION_ERROR;
  }
  return logbrew_trace_context_from_traceparent(traceparent, out_context, error);
}

LogBrewStatus logbrew_trace_create_headers(
    const LogBrewTraceContext *context,
    char out_traceparent[LOGBREW_TRACEPARENT_LENGTH + 1U],
    LogBrewError *error) {
  size_t index;
  LogBrewStatus status;
  if (context == NULL) {
    set_trace_error(error, "config_error", "trace context is required");
    return LOGBREW_CONFIG_ERROR;
  }
  if (out_traceparent == NULL) {
    set_trace_error(error, "config_error", "out_traceparent is required");
    return LOGBREW_CONFIG_ERROR;
  }
  status = validate_trace_context(context, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  (void)snprintf(out_traceparent, LOGBREW_TRACEPARENT_LENGTH + 1U, "00-%s-%s-%s",
                 context->trace_id, context->span_id, context->trace_flags);
  for (index = 0U; index < LOGBREW_TRACEPARENT_LENGTH; index++) {
    out_traceparent[index] = lower_hex_char(out_traceparent[index]);
  }
  return LOGBREW_OK;
}

const LogBrewTraceContext *logbrew_trace_current_context(void) {
  return current_context;
}

LogBrewStatus logbrew_trace_scope_enter(
    LogBrewTraceScope *scope,
    const LogBrewTraceContext *context,
    LogBrewError *error) {
  if (scope == NULL) {
    set_trace_error(error, "config_error", "trace scope is required");
    return LOGBREW_CONFIG_ERROR;
  }
  if (context == NULL) {
    set_trace_error(error, "config_error", "trace context is required");
    return LOGBREW_CONFIG_ERROR;
  }
  if (trace_scope_is_in_active_chain(scope)) {
    set_trace_error(error, "config_error", "trace scope is already active");
    return LOGBREW_CONFIG_ERROR;
  }
  if (validate_trace_context(context, error) != LOGBREW_OK) {
    return LOGBREW_VALIDATION_ERROR;
  }
  memset(scope, 0, sizeof(*scope));
  scope->context = *context;
  scope->previous = current_context;
  scope->active = true;
  scope->owner = scope;
  {
    size_t index;
    for (index = 0U; index < LOGBREW_TRACE_ID_LENGTH; index++) {
      scope->context.trace_id[index] = lower_hex_char(scope->context.trace_id[index]);
    }
    for (index = 0U; index < LOGBREW_SPAN_ID_LENGTH; index++) {
      scope->context.span_id[index] = lower_hex_char(scope->context.span_id[index]);
    }
    if (!trace_blank(scope->context.parent_span_id)) {
      for (index = 0U; index < LOGBREW_SPAN_ID_LENGTH; index++) {
        scope->context.parent_span_id[index] = lower_hex_char(scope->context.parent_span_id[index]);
      }
    }
    for (index = 0U; index < LOGBREW_TRACE_FLAGS_LENGTH; index++) {
      scope->context.trace_flags[index] = lower_hex_char(scope->context.trace_flags[index]);
    }
  }
  current_context = &scope->context;
  return LOGBREW_OK;
}

void logbrew_trace_scope_exit(LogBrewTraceScope *scope) {
  if (scope == NULL || !scope->active) {
    return;
  }
  if (current_context != &scope->context || scope->owner != scope) {
    return;
  }
  current_context = scope->previous;
  scope->previous = NULL;
  scope->active = false;
  scope->owner = NULL;
}

LogBrewMetadata logbrew_trace_metadata(
    const LogBrewTraceContext *context,
    LogBrewMetadataEntry entries[LOGBREW_TRACE_METADATA_ENTRY_COUNT]) {
  size_t count = 0U;
  if (context == NULL) {
    context = logbrew_trace_current_context();
  }
  if (entries == NULL || context == NULL || trace_blank(context->trace_id) || trace_blank(context->span_id)) {
    LogBrewMetadata empty = {NULL, 0U};
    return empty;
  }
  entries[count++] = LOGBREW_METADATA_STRING_VALUE("traceId", context->trace_id);
  entries[count++] = LOGBREW_METADATA_STRING_VALUE("spanId", context->span_id);
  if (!trace_blank(context->parent_span_id)) {
    entries[count++] = LOGBREW_METADATA_STRING_VALUE("parentSpanId", context->parent_span_id);
  }
  entries[count++] = LOGBREW_METADATA_BOOL_VALUE("sampled", context->sampled);
  entries[count++] = LOGBREW_METADATA_STRING_VALUE("traceFlags", context->trace_flags);
  return (LogBrewMetadata){entries, count};
}

LogBrewProductTimelineContext logbrew_trace_product_timeline_context(
    const LogBrewTraceContext *context,
    LogBrewProductTimelineContext base_context) {
  if (context == NULL) {
    context = logbrew_trace_current_context();
  }
  if (context != NULL && !trace_blank(context->trace_id)) {
    base_context.trace_id = context->trace_id;
  }
  return base_context;
}

LogBrewStatus logbrew_trace_span_attributes(
    const LogBrewTraceContext *context,
    const char *name,
    const char *status,
    double duration_ms,
    bool has_duration_ms,
    LogBrewSpanAttributes *out_attributes,
    LogBrewError *error) {
  if (context == NULL) {
    context = logbrew_trace_current_context();
  }
  if (out_attributes == NULL) {
    set_trace_error(error, "config_error", "out_attributes is required");
    return LOGBREW_CONFIG_ERROR;
  }
  if (context == NULL || trace_blank(context->trace_id) || trace_blank(context->span_id)) {
    set_trace_error(error, "validation_error", "trace context is required");
    return LOGBREW_VALIDATION_ERROR;
  }
  out_attributes->name = name;
  out_attributes->trace_id = context->trace_id;
  out_attributes->span_id = context->span_id;
  out_attributes->parent_span_id = trace_blank(context->parent_span_id) ? NULL : context->parent_span_id;
  out_attributes->status = status;
  out_attributes->duration_ms = duration_ms;
  out_attributes->has_duration_ms = has_duration_ms;
  return LOGBREW_OK;
}

LogBrewStatus logbrew_trace_span_attributes_from_opentelemetry_span_context(
    const char *name,
    const char *status,
    LogBrewOpenTelemetrySpanContext context,
    double duration_ms,
    bool has_duration_ms,
    LogBrewTraceContext *out_context,
    LogBrewSpanAttributes *out_attributes,
    LogBrewError *error) {
  LogBrewStatus result = logbrew_trace_context_from_opentelemetry_span_context(context, out_context, error);
  if (result != LOGBREW_OK) {
    return result;
  }
  return logbrew_trace_span_attributes(
      out_context, name, status, duration_ms, has_duration_ms, out_attributes, error);
}

LogBrewStatus logbrew_trace_http_client_span_start(
    const LogBrewTraceContext *parent,
    const char *method,
    const char *route_template,
    LogBrewHttpClientSpan *out_span,
    LogBrewError *error) {
  char normalized_method[16];
  char sanitized_route[LOGBREW_HTTP_CLIENT_SPAN_NAME_LENGTH];
  LogBrewStatus status;
  if (out_span == NULL) {
    set_trace_error(error, "config_error", "out_span is required");
    return LOGBREW_CONFIG_ERROR;
  }
  memset(out_span, 0, sizeof(*out_span));
  status = normalize_http_method(method, normalized_method, sizeof(normalized_method), error);
  if (status == LOGBREW_OK) {
    status = sanitize_http_route(route_template, sanitized_route, sizeof(sanitized_route), error);
  }
  if (status == LOGBREW_OK) {
    status = logbrew_trace_child_context(parent == NULL ? logbrew_trace_current_context() : parent, &out_span->trace, error);
  }
  if (status == LOGBREW_OK) {
    int written = snprintf(out_span->name, sizeof(out_span->name), "%s %s", normalized_method, sanitized_route);
    if (written < 0 || (size_t)written >= sizeof(out_span->name)) {
      set_trace_error(error, "validation_error", "HTTP client span name is too long");
      return LOGBREW_VALIDATION_ERROR;
    }
    status = logbrew_trace_create_headers(&out_span->trace, out_span->traceparent, error);
  }
  return status;
}

LogBrewStatus logbrew_trace_http_client_span_attributes(
    const LogBrewHttpClientSpan *span,
    int status_code,
    bool has_status_code,
    bool network_error,
    double duration_ms,
    bool has_duration_ms,
    LogBrewSpanAttributes *out_attributes,
    LogBrewError *error) {
  const char *span_status = "ok";
  if (span == NULL) {
    set_trace_error(error, "config_error", "HTTP client span is required");
    return LOGBREW_CONFIG_ERROR;
  }
  if (has_status_code && (status_code < 100 || status_code > 599)) {
    set_trace_error(error, "validation_error", "HTTP client status_code must be between 100 and 599");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (has_duration_ms && (!isfinite(duration_ms) || duration_ms < 0.0)) {
    set_trace_error(error, "validation_error", "HTTP client duration_ms must be finite and non-negative");
    return LOGBREW_VALIDATION_ERROR;
  }
  if (network_error || (has_status_code && status_code >= 500)) {
    span_status = "error";
  }
  return logbrew_trace_span_attributes(
      &span->trace, span->name, span_status, duration_ms, has_duration_ms, out_attributes, error);
}
