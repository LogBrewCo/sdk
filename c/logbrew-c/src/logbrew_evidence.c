#include "logbrew_internal.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool evidence_ascii_alpha(unsigned char value) {
  return (value >= (unsigned char)'A' && value <= (unsigned char)'Z') ||
      (value >= (unsigned char)'a' && value <= (unsigned char)'z');
}

static bool evidence_ascii_digit(unsigned char value) {
  return value >= (unsigned char)'0' && value <= (unsigned char)'9';
}

static bool evidence_ascii_alnum(unsigned char value) {
  return evidence_ascii_alpha(value) || evidence_ascii_digit(value);
}

static bool evidence_ascii_hex(unsigned char value) {
  return evidence_ascii_digit(value) ||
      (value >= (unsigned char)'A' && value <= (unsigned char)'F') ||
      (value >= (unsigned char)'a' && value <= (unsigned char)'f');
}

static char evidence_ascii_lower(unsigned char value) {
  return value >= (unsigned char)'A' && value <= (unsigned char)'Z'
      ? (char)(value + ((unsigned char)'a' - (unsigned char)'A'))
      : (char)value;
}

static bool evidence_machine_key(const char *value, size_t maximum, const char *separators) {
  size_t index;
  size_t length;
  if (value == NULL) {
    return false;
  }
  length = strlen(value);
  if (length == 0U || length > maximum || !evidence_ascii_alpha((unsigned char)value[0])) {
    return false;
  }
  for (index = 1U; index < length; index++) {
    unsigned char current = (unsigned char)value[index];
    if (!evidence_ascii_alnum(current) && strchr(separators, (int)current) == NULL) {
      return false;
    }
  }
  return true;
}

static bool evidence_forbidden_control(const unsigned char *value) {
  while (*value != '\0') {
    if (*value < 0x20U || *value == 0x7fU ||
        (*value == 0xc2U && value[1] >= 0x80U && value[1] <= 0x9fU)) {
      return true;
    }
    value++;
  }
  return false;
}

static LogBrewStatus validate_text(
    const char *label,
    const char *value,
    size_t maximum,
    bool disallow_location_delimiters,
    LogBrewError *error) {
  char message[192];
  size_t length;
  if (logbrew_internal_blank(value)) {
    (void)snprintf(message, sizeof(message), "%s must be non-empty", label);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  length = strlen(value);
  if ((maximum > 0U && length > maximum) || evidence_forbidden_control((const unsigned char *)value) ||
      (disallow_location_delimiters && (strchr(value, '?') != NULL || strchr(value, '#') != NULL))) {
    (void)snprintf(message, sizeof(message), "%s is invalid", label);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  return LOGBREW_OK;
}

static bool absolute_path(const char *value) {
  return value[0] == '/' || value[0] == '\\' ||
      (evidence_ascii_alpha((unsigned char)value[0]) && value[1] == ':' &&
       (value[2] == '/' || value[2] == '\\'));
}

static bool uuid_is_valid(const char *value) {
  size_t index;
  if (value == NULL || strlen(value) != 36U) {
    return false;
  }
  for (index = 0U; index < 36U; index++) {
    if (index == 8U || index == 13U || index == 18U || index == 23U) {
      if (value[index] != '-') return false;
    } else if (!evidence_ascii_hex((unsigned char)value[index])) {
      return false;
    }
  }
  return true;
}

static bool hex_id_is_valid(const char *value, size_t length) {
  size_t index;
  bool non_zero = false;
  if (value == NULL || strlen(value) != length) return false;
  for (index = 0U; index < length; index++) {
    if (!evidence_ascii_hex((unsigned char)value[index])) return false;
    non_zero = non_zero || value[index] != '0';
  }
  return non_zero;
}

LogBrewStatus logbrew_issue_frame_from_location(
    const char *file,
    unsigned int line,
    unsigned int column,
    const char *function,
    const char *module,
    bool in_app,
    LogBrewIssueStackFrame *out_frame,
    LogBrewError *error) {
  const char *end;
  const char *cursor;
  const char *start;
  char filename[2049];
  size_t length;
  if (out_frame == NULL) {
    logbrew_internal_set_error(error, "config_error", "out_frame is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  memset(out_frame, 0, sizeof(*out_frame));
  if (logbrew_internal_blank(file)) {
    logbrew_internal_set_error(error, "validation_error", "issue frame file must be non-empty", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  end = file + strlen(file);
  cursor = strchr(file, '?');
  if (cursor != NULL && cursor < end) end = cursor;
  cursor = strchr(file, '#');
  if (cursor != NULL && cursor < end) end = cursor;
  start = end;
  while (start > file && start[-1] != '/' && start[-1] != '\\') start--;
  length = (size_t)(end - start);
  if (length == 0U || length > sizeof(filename) - 1U) {
    logbrew_internal_set_error(error, "validation_error", "issue frame file basename is invalid", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  memcpy(filename, start, length);
  filename[length] = '\0';
  if (validate_text("issue frame filename", filename, 2048U, true, error) != LOGBREW_OK) {
    return LOGBREW_VALIDATION_ERROR;
  }
  if (line == 0U || line > (unsigned int)INT_MAX || column == 0U || column > (unsigned int)INT_MAX) {
    logbrew_internal_set_error(error, "validation_error", "issue frame line and column must be positive", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (function != NULL && validate_text("issue frame function", function, 256U, false, error) != LOGBREW_OK) {
    return LOGBREW_VALIDATION_ERROR;
  }
  if (module != NULL && validate_text("issue frame module", module, 512U, true, error) != LOGBREW_OK) {
    return LOGBREW_VALIDATION_ERROR;
  }
  out_frame->filename = start;
  out_frame->filename_length = length;
  out_frame->line = line;
  out_frame->column = column;
  out_frame->function = function;
  out_frame->module = module;
  out_frame->in_app = in_app;
  out_frame->has_in_app = true;
  return LOGBREW_OK;
}

static LogBrewStatus append_exception(
    LogBrewJsonBuffer *buffer,
    const LogBrewIssueException *value,
    bool *needs_comma,
    LogBrewError *error) {
  bool nested_comma = false;
  LogBrewStatus status = validate_text("issue exception type", value->type, 256U, true, error);
  if (status == LOGBREW_OK && *needs_comma) status = logbrew_json_append_char(buffer, ',', error);
  if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"exception\":{", error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(buffer, "type", value->type, &nested_comma, error);
  if (status == LOGBREW_OK && value->mechanism != NULL) {
    bool mechanism_comma = false;
    if (!evidence_machine_key(value->mechanism->type, 64U, "_.:-")) {
      logbrew_internal_set_error(error, "validation_error", "issue exception mechanism type is invalid", false);
      return LOGBREW_VALIDATION_ERROR;
    }
    if (nested_comma) status = logbrew_json_append_char(buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"mechanism\":{", error);
    if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
        buffer, "type", value->mechanism->type, &mechanism_comma, error);
    if (status == LOGBREW_OK) status = logbrew_json_append_named_bool(
        buffer, "handled", value->mechanism->handled, &mechanism_comma, error);
    if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  }
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  if (status == LOGBREW_OK) *needs_comma = true;
  return status;
}

static LogBrewStatus append_frame(
    LogBrewJsonBuffer *buffer,
    const LogBrewIssueStackFrame *value,
    LogBrewError *error) {
  bool needs_comma = false;
  char filename_storage[2049];
  const char *filename = value->filename;
  LogBrewStatus status = LOGBREW_OK;
  if (value->filename_length > 0U) {
    if (filename == NULL || value->filename_length > sizeof(filename_storage) - 1U ||
        memchr(filename, '\0', value->filename_length) != NULL) {
      logbrew_internal_set_error(error, "validation_error", "issue frame filename is invalid", false);
      status = LOGBREW_VALIDATION_ERROR;
    } else {
      memcpy(filename_storage, filename, value->filename_length);
      filename_storage[value->filename_length] = '\0';
      filename = filename_storage;
    }
  }
  if (status == LOGBREW_OK) status = validate_text("issue frame filename", filename, 2048U, true, error);
  if (status == LOGBREW_OK && absolute_path(filename)) {
    logbrew_internal_set_error(error, "validation_error",
        "issue frame filename must be relative or sanitized with logbrew_issue_frame_from_location", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK && (value->line == 0U || value->line > (unsigned int)INT_MAX ||
      value->column == 0U || value->column > (unsigned int)INT_MAX)) {
    logbrew_internal_set_error(error, "validation_error", "issue frame line and column must be positive", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK && value->function != NULL)
    status = validate_text("issue frame function", value->function, 256U, false, error);
  if (status == LOGBREW_OK && value->module != NULL)
    status = validate_text("issue frame module", value->module, 512U, true, error);
  if (status == LOGBREW_OK && value->debug_id != NULL && !uuid_is_valid(value->debug_id)) {
    logbrew_internal_set_error(error, "validation_error", "issue frame debug_id is invalid", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '{', error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(buffer, "filename", filename, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_format(buffer, error, ",\"line\":%u,\"column\":%u", value->line, value->column);
  if (status == LOGBREW_OK && value->function != NULL)
    status = logbrew_json_append_named_string(buffer, "function", value->function, &needs_comma, error);
  if (status == LOGBREW_OK && value->module != NULL)
    status = logbrew_json_append_named_string(buffer, "module", value->module, &needs_comma, error);
  if (status == LOGBREW_OK && value->has_in_app)
    status = logbrew_json_append_named_bool(buffer, "inApp", value->in_app, &needs_comma, error);
  if (status == LOGBREW_OK && value->debug_id != NULL)
    status = logbrew_json_append_named_string(buffer, "debugId", value->debug_id, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  return status;
}

static bool optional_text_equal(const char *left, const char *right) {
  if (left == NULL || right == NULL) return left == right;
  return strcmp(left, right) == 0;
}

static bool frame_filename_equal(
    const LogBrewIssueStackFrame *left,
    const LogBrewIssueStackFrame *right) {
  size_t left_length;
  size_t right_length;
  if (left->filename == NULL || right->filename == NULL) return left->filename == right->filename;
  left_length = left->filename_length > 0U ? left->filename_length : strlen(left->filename);
  right_length = right->filename_length > 0U ? right->filename_length : strlen(right->filename);
  return left_length == right_length && memcmp(left->filename, right->filename, left_length) == 0;
}

static bool frames_equal(
    const LogBrewIssueStackFrame *left,
    const LogBrewIssueStackFrame *right,
    size_t count) {
  size_t index;
  for (index = 0U; index < count; index++) {
    if (!frame_filename_equal(&left[index], &right[index]) ||
        left[index].line != right[index].line ||
        left[index].column != right[index].column ||
        !optional_text_equal(left[index].function, right[index].function) ||
        !optional_text_equal(left[index].module, right[index].module) ||
        left[index].in_app != right[index].in_app ||
        left[index].has_in_app != right[index].has_in_app ||
        !optional_text_equal(left[index].debug_id, right[index].debug_id)) {
      return false;
    }
  }
  return true;
}

static bool mechanisms_equal(
    const LogBrewIssueMechanism *left,
    const LogBrewIssueMechanism *right) {
  if (left == NULL || right == NULL) return left == right;
  return optional_text_equal(left->type, right->type) && left->handled == right->handled;
}

static const char *relationship_name(LogBrewIssueExceptionRelationship value) {
  switch (value) {
    case LOGBREW_EXCEPTION_RELATIONSHIP_REPORTED: return "reported";
    case LOGBREW_EXCEPTION_RELATIONSHIP_CAUSE: return "cause";
    case LOGBREW_EXCEPTION_RELATIONSHIP_CONTEXT: return "context";
    case LOGBREW_EXCEPTION_RELATIONSHIP_AGGREGATE_MEMBER: return "aggregate_member";
    case LOGBREW_EXCEPTION_RELATIONSHIP_SUPPRESSED: return "suppressed";
    default: return NULL;
  }
}

static const char *message_state_name(LogBrewIssueExceptionMessageState value) {
  switch (value) {
    case LOGBREW_EXCEPTION_MESSAGE_NOT_CAPTURED: return "not_captured";
    case LOGBREW_EXCEPTION_MESSAGE_CAPTURED: return "captured";
    case LOGBREW_EXCEPTION_MESSAGE_TRUNCATED: return "truncated";
    case LOGBREW_EXCEPTION_MESSAGE_REDACTED: return "redacted";
    default: return NULL;
  }
}

static const char *stack_state_name(LogBrewIssueExceptionStackState value) {
  switch (value) {
    case LOGBREW_EXCEPTION_STACK_NOT_CAPTURED: return "not_captured";
    case LOGBREW_EXCEPTION_STACK_CAPTURED: return "captured";
    case LOGBREW_EXCEPTION_STACK_TRUNCATED: return "truncated";
    default: return NULL;
  }
}

static LogBrewStatus append_mechanism_member(
    LogBrewJsonBuffer *buffer,
    const LogBrewIssueMechanism *mechanism,
    bool *needs_comma,
    LogBrewError *error) {
  bool mechanism_comma = false;
  LogBrewStatus status = LOGBREW_OK;
  if (!evidence_machine_key(mechanism->type, 64U, "_.:-")) {
    logbrew_internal_set_error(error, "validation_error", "issue exception mechanism type is invalid", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (*needs_comma) status = logbrew_json_append_char(buffer, ',', error);
  if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"mechanism\":{", error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
      buffer, "type", mechanism->type, &mechanism_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_bool(
      buffer, "handled", mechanism->handled, &mechanism_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  if (status == LOGBREW_OK) *needs_comma = true;
  return status;
}

static LogBrewStatus append_exception_chain_entry(
    LogBrewJsonBuffer *buffer,
    const LogBrewIssueExceptionChainEntry *entry,
    size_t index,
    LogBrewError *error) {
  const char *relationship = relationship_name(entry->relationship);
  const char *message_state = message_state_name(entry->message_state);
  const char *stack_state = stack_state_name(entry->stack_frames_state);
  bool needs_comma = true;
  size_t frame_index;
  LogBrewStatus status = LOGBREW_OK;
  if (entry->id != index) {
    logbrew_internal_set_error(
        error, "validation_error", "issue exceptionChain ids must be contiguous and match array order", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (index == 0U) {
    if (entry->has_parent_id || entry->relationship != LOGBREW_EXCEPTION_RELATIONSHIP_REPORTED) {
      logbrew_internal_set_error(error, "validation_error",
          "issue exceptionChain entry 0 must be the parentless reported exception", false);
      return LOGBREW_VALIDATION_ERROR;
    }
  } else if (!entry->has_parent_id || entry->parent_id >= index || relationship == NULL ||
      entry->relationship == LOGBREW_EXCEPTION_RELATIONSHIP_REPORTED) {
    logbrew_internal_set_error(
        error, "validation_error", "issue exceptionChain parent relationship is invalid", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (relationship == NULL || validate_text(
      "issue exceptionChain type", entry->type, 256U, true, error) != LOGBREW_OK) {
    if (relationship == NULL) {
      logbrew_internal_set_error(
          error, "validation_error", "issue exceptionChain relationship is invalid", false);
    }
    return LOGBREW_VALIDATION_ERROR;
  }
  if (message_state == NULL ||
      ((entry->message_state == LOGBREW_EXCEPTION_MESSAGE_CAPTURED ||
        entry->message_state == LOGBREW_EXCEPTION_MESSAGE_TRUNCATED)
          ? validate_text("issue exceptionChain message", entry->message, 1024U, false, error) != LOGBREW_OK
          : entry->message != NULL)) {
    if (message_state == NULL || entry->message != NULL) {
      logbrew_internal_set_error(
          error, "validation_error", "issue exceptionChain message must match messageState", false);
    }
    return LOGBREW_VALIDATION_ERROR;
  }
  if (entry->module != NULL && validate_text(
      "issue exceptionChain module", entry->module, 512U, true, error) != LOGBREW_OK) {
    return LOGBREW_VALIDATION_ERROR;
  }
  if (entry->mechanism != NULL && !evidence_machine_key(entry->mechanism->type, 64U, "_.:-")) {
    logbrew_internal_set_error(error, "validation_error", "issue exception mechanism type is invalid", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (stack_state == NULL ||
      ((entry->stack_frames_state == LOGBREW_EXCEPTION_STACK_CAPTURED ||
        entry->stack_frames_state == LOGBREW_EXCEPTION_STACK_TRUNCATED)
          ? entry->stack_frames == NULL || entry->stack_frame_count == 0U ||
              entry->stack_frame_count > LOGBREW_MAX_STACK_FRAMES
          : entry->stack_frames != NULL || entry->stack_frame_count != 0U)) {
    logbrew_internal_set_error(
        error, "validation_error", "issue exceptionChain stackFrames must match stackFramesState", false);
    return LOGBREW_VALIDATION_ERROR;
  }

  status = logbrew_json_append_format(buffer, error, "{\"id\":%zu", entry->id);
  if (status == LOGBREW_OK && entry->has_parent_id) {
    status = logbrew_json_append_format(buffer, error, ",\"parentId\":%zu", entry->parent_id);
  }
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
      buffer, "relationship", relationship, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
      buffer, "type", entry->type, &needs_comma, error);
  if (status == LOGBREW_OK && entry->message != NULL) status = logbrew_json_append_named_string(
      buffer, "message", entry->message, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
      buffer, "messageState", message_state, &needs_comma, error);
  if (status == LOGBREW_OK && entry->module != NULL) status = logbrew_json_append_named_string(
      buffer, "module", entry->module, &needs_comma, error);
  if (status == LOGBREW_OK && entry->mechanism != NULL) status = append_mechanism_member(
      buffer, entry->mechanism, &needs_comma, error);
  if (status == LOGBREW_OK && entry->stack_frame_count > 0U) {
    if (needs_comma) status = logbrew_json_append_char(buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"stackFrames\":[", error);
    for (frame_index = 0U; status == LOGBREW_OK && frame_index < entry->stack_frame_count; frame_index++) {
      if (frame_index > 0U) status = logbrew_json_append_char(buffer, ',', error);
      if (status == LOGBREW_OK) status = append_frame(buffer, &entry->stack_frames[frame_index], error);
    }
    if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, ']', error);
    if (status == LOGBREW_OK) needs_comma = true;
  }
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
      buffer, "stackFramesState", stack_state, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  return status;
}

static LogBrewStatus append_exception_chain(
    LogBrewJsonBuffer *buffer,
    const LogBrewIssueExceptionChain *chain,
    const LogBrewIssueException *legacy_exception,
    const LogBrewIssueStackFrame *legacy_frames,
    size_t legacy_frame_count,
    bool *needs_comma,
    LogBrewError *error) {
  const LogBrewIssueExceptionChainEntry *root;
  bool chain_comma = false;
  size_t index;
  LogBrewStatus status = LOGBREW_OK;
  if (chain->entries == NULL || chain->entry_count == 0U ||
      chain->entry_count > LOGBREW_MAX_EXCEPTION_CHAIN_ENTRIES) {
    logbrew_internal_set_error(
        error, "validation_error", "issue exceptionChain entries must contain 1-8 exceptions", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  root = &chain->entries[0];
  if (legacy_exception == NULL || !optional_text_equal(root->type, legacy_exception->type) ||
      !mechanisms_equal(root->mechanism, legacy_exception->mechanism)) {
    logbrew_internal_set_error(
        error, "validation_error", "issue exceptionChain reported exception must match exception", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if ((root->stack_frames_state == LOGBREW_EXCEPTION_STACK_NOT_CAPTURED && legacy_frame_count != 0U) ||
      (root->stack_frames_state != LOGBREW_EXCEPTION_STACK_NOT_CAPTURED &&
       (root->stack_frame_count != legacy_frame_count || legacy_frames == NULL ||
        !frames_equal(root->stack_frames, legacy_frames, legacy_frame_count)))) {
    logbrew_internal_set_error(
        error, "validation_error", "issue exceptionChain reported stack must match stackFrames", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (*needs_comma) status = logbrew_json_append_char(buffer, ',', error);
  if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"exceptionChain\":{\"entries\":[", error);
  for (index = 0U; status == LOGBREW_OK && index < chain->entry_count; index++) {
    if (index > 0U) status = logbrew_json_append_char(buffer, ',', error);
    if (status == LOGBREW_OK) status = append_exception_chain_entry(buffer, &chain->entries[index], index, error);
  }
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, ']', error);
  if (status == LOGBREW_OK) chain_comma = true;
  if (status == LOGBREW_OK) status = logbrew_json_append_named_bool(
      buffer, "truncated", chain->truncated, &chain_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  if (status == LOGBREW_OK) *needs_comma = true;
  return status;
}

LogBrewStatus logbrew_evidence_breadcrumb_json(
    LogBrewIssueBreadcrumb breadcrumb,
    char **out_json,
    LogBrewError *error) {
  static const char *const levels[] = {"debug", "info", "warning", "error", "critical"};
  LogBrewJsonBuffer buffer = {0};
  bool needs_comma = false;
  size_t index;
  LogBrewStatus status;
  bool level_valid = breadcrumb.level == NULL;
  if (out_json == NULL) {
    logbrew_internal_set_error(error, "config_error", "out_json is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  *out_json = NULL;
  status = logbrew_internal_require_timestamp("issue breadcrumb timestamp", breadcrumb.timestamp, error);
  if (status == LOGBREW_OK && !evidence_machine_key(breadcrumb.category, 64U, "_.:-")) {
    logbrew_internal_set_error(error, "validation_error", "issue breadcrumb category is invalid", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK && breadcrumb.type != NULL && !evidence_machine_key(breadcrumb.type, 64U, "_.:-")) {
    logbrew_internal_set_error(error, "validation_error", "issue breadcrumb type is invalid", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  for (index = 0U; breadcrumb.level != NULL && index < sizeof(levels) / sizeof(levels[0]); index++) {
    level_valid = level_valid || strcmp(breadcrumb.level, levels[index]) == 0;
  }
  if (status == LOGBREW_OK && !level_valid) {
    logbrew_internal_set_error(error, "validation_error", "issue breadcrumb level is invalid", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK && breadcrumb.message != NULL)
    status = validate_text("issue breadcrumb message", breadcrumb.message, 512U, false, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, '{', error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
      &buffer, "timestamp", breadcrumb.timestamp, &needs_comma, error);
  if (status == LOGBREW_OK && breadcrumb.type != NULL)
    status = logbrew_json_append_named_string(&buffer, "type", breadcrumb.type, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(
      &buffer, "category", breadcrumb.category, &needs_comma, error);
  if (status == LOGBREW_OK && breadcrumb.level != NULL)
    status = logbrew_json_append_named_string(&buffer, "level", breadcrumb.level, &needs_comma, error);
  if (status == LOGBREW_OK && breadcrumb.message != NULL)
    status = logbrew_json_append_named_string(&buffer, "message", breadcrumb.message, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_metadata_member(
      &buffer, "data", breadcrumb.data, (LogBrewMetadata){NULL, 0U}, 8U, true, 256U, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, '}', error);
  if (status != LOGBREW_OK) {
    logbrew_json_dispose(&buffer);
    return status;
  }
  *out_json = buffer.data;
  return LOGBREW_OK;
}

LogBrewStatus logbrew_evidence_issue_fragment(
    LogBrewIssueDetails details,
    char *const *stored_breadcrumbs,
    size_t stored_breadcrumb_count,
    bool stored_breadcrumbs_truncated,
    char **out_fragment,
    LogBrewError *error) {
  LogBrewJsonBuffer buffer = {0};
  bool needs_comma = false;
  LogBrewStatus status = LOGBREW_OK;
  size_t index;
  size_t explicit_start = details.breadcrumb_count > LOGBREW_MAX_BREADCRUMBS
      ? details.breadcrumb_count - LOGBREW_MAX_BREADCRUMBS : 0U;
  size_t explicit_retained = details.breadcrumb_count - explicit_start;
  size_t combined = stored_breadcrumb_count + explicit_retained;
  size_t drop = combined > LOGBREW_MAX_BREADCRUMBS ? combined - LOGBREW_MAX_BREADCRUMBS : 0U;
  bool truncated = details.breadcrumbs_truncated || stored_breadcrumbs_truncated ||
      details.breadcrumb_count > LOGBREW_MAX_BREADCRUMBS || combined > LOGBREW_MAX_BREADCRUMBS;
  if (out_fragment == NULL) {
    logbrew_internal_set_error(error, "config_error", "out_fragment is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  *out_fragment = NULL;
  if (details.stack_frame_count > LOGBREW_MAX_STACK_FRAMES ||
      (details.stack_frame_count > 0U && details.stack_frames == NULL)) {
    logbrew_internal_set_error(error, "validation_error", "issue stack frames must contain at most 32 entries", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (details.breadcrumb_count > 0U && details.breadcrumbs == NULL) {
    logbrew_internal_set_error(error, "validation_error", "issue breadcrumbs are required when count is non-zero", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (details.exception != NULL) status = append_exception(&buffer, details.exception, &needs_comma, error);
  if (status == LOGBREW_OK && details.stack_frame_count > 0U) {
    if (needs_comma) status = logbrew_json_append_char(&buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, "\"stackFrames\":[", error);
    for (index = 0U; status == LOGBREW_OK && index < details.stack_frame_count; index++) {
      if (index > 0U) status = logbrew_json_append_char(&buffer, ',', error);
      if (status == LOGBREW_OK) status = append_frame(&buffer, &details.stack_frames[index], error);
    }
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, ']', error);
    if (status == LOGBREW_OK) needs_comma = true;
  }
  if (status == LOGBREW_OK && details.exception_chain != NULL) {
    status = append_exception_chain(
        &buffer,
        details.exception_chain,
        details.exception,
        details.stack_frames,
        details.stack_frame_count,
        &needs_comma,
        error);
  }
  if (status == LOGBREW_OK && combined > 0U) {
    size_t emitted = 0U;
    size_t stored_start = drop < stored_breadcrumb_count ? drop : stored_breadcrumb_count;
    size_t explicit_drop = drop > stored_breadcrumb_count ? drop - stored_breadcrumb_count : 0U;
    size_t first_explicit = explicit_start + explicit_drop;
    if (needs_comma) status = logbrew_json_append_char(&buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, "\"breadcrumbs\":[", error);
    for (index = stored_start; status == LOGBREW_OK && index < stored_breadcrumb_count; index++) {
      if (emitted++ > 0U) status = logbrew_json_append_char(&buffer, ',', error);
      if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, stored_breadcrumbs[index], error);
    }
    for (index = first_explicit; status == LOGBREW_OK && index < details.breadcrumb_count; index++) {
      char *breadcrumb_json = NULL;
      if (emitted++ > 0U) status = logbrew_json_append_char(&buffer, ',', error);
      if (status == LOGBREW_OK) status = logbrew_evidence_breadcrumb_json(details.breadcrumbs[index], &breadcrumb_json, error);
      if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, breadcrumb_json, error);
      free(breadcrumb_json);
    }
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, ']', error);
    if (status == LOGBREW_OK) needs_comma = true;
  }
  if (status == LOGBREW_OK && truncated) {
    status = logbrew_json_append_named_bool(&buffer, "breadcrumbsTruncated", true, &needs_comma, error);
  }
  if (status != LOGBREW_OK) {
    logbrew_json_dispose(&buffer);
    return status;
  }
  if (buffer.data == NULL) {
    buffer.data = (char *)malloc(1U);
    if (buffer.data == NULL) {
      logbrew_internal_set_error(error, "allocation_error", "out of memory", false);
      return LOGBREW_ALLOCATION_ERROR;
    }
    buffer.data[0] = '\0';
  }
  *out_fragment = buffer.data;
  return LOGBREW_OK;
}

static LogBrewStatus append_span_event(
    LogBrewJsonBuffer *buffer,
    const LogBrewSpanEvent *value,
    LogBrewError *error) {
  bool needs_comma = false;
  LogBrewStatus status = validate_text("span event name", value->name, 512U, false, error);
  if (status == LOGBREW_OK && value->timestamp != NULL)
    status = logbrew_internal_require_timestamp("span event timestamp", value->timestamp, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '{', error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(buffer, "name", value->name, &needs_comma, error);
  if (status == LOGBREW_OK && value->timestamp != NULL)
    status = logbrew_json_append_named_string(buffer, "timestamp", value->timestamp, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_metadata_member(
      buffer, "metadata", value->metadata, (LogBrewMetadata){NULL, 0U}, 64U, false,
      LOGBREW_MAX_METADATA_STRING_LENGTH, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  return status;
}

static LogBrewStatus append_span_link(
    LogBrewJsonBuffer *buffer,
    const LogBrewSpanLink *value,
    LogBrewError *error) {
  bool needs_comma = false;
  char trace_id[LOGBREW_TRACE_ID_LENGTH + 1U];
  char span_id[LOGBREW_SPAN_ID_LENGTH + 1U];
  size_t index;
  LogBrewStatus status = LOGBREW_OK;
  if (!hex_id_is_valid(value->trace_id, LOGBREW_TRACE_ID_LENGTH) ||
      !hex_id_is_valid(value->span_id, LOGBREW_SPAN_ID_LENGTH)) {
    logbrew_internal_set_error(error, "validation_error", "span link identifiers must be non-zero W3C hex values", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  for (index = 0U; status == LOGBREW_OK && index < LOGBREW_TRACE_ID_LENGTH; index++) {
    trace_id[index] = evidence_ascii_lower((unsigned char)value->trace_id[index]);
  }
  trace_id[LOGBREW_TRACE_ID_LENGTH] = '\0';
  for (index = 0U; status == LOGBREW_OK && index < LOGBREW_SPAN_ID_LENGTH; index++) {
    span_id[index] = evidence_ascii_lower((unsigned char)value->span_id[index]);
  }
  span_id[LOGBREW_SPAN_ID_LENGTH] = '\0';
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '{', error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(buffer, "traceId", trace_id, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(buffer, "spanId", span_id, &needs_comma, error);
  if (status == LOGBREW_OK && value->has_sampled)
    status = logbrew_json_append_named_bool(buffer, "sampled", value->sampled, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_metadata_member(
      buffer, "metadata", value->metadata, (LogBrewMetadata){NULL, 0U}, 64U, false,
      LOGBREW_MAX_METADATA_STRING_LENGTH, &needs_comma, error);
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  return status;
}

LogBrewStatus logbrew_evidence_span_fragment(
    LogBrewSpanEvidence evidence,
    char **out_fragment,
    LogBrewError *error) {
  LogBrewJsonBuffer buffer = {0};
  bool needs_comma = false;
  LogBrewStatus status = LOGBREW_OK;
  size_t index;
  if (out_fragment == NULL) {
    logbrew_internal_set_error(error, "config_error", "out_fragment is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  *out_fragment = NULL;
  if (evidence.event_count > LOGBREW_MAX_SPAN_EVENTS ||
      (evidence.event_count > 0U && evidence.events == NULL)) {
    logbrew_internal_set_error(error, "validation_error", "span events must contain at most 8 entries", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (evidence.link_count > LOGBREW_MAX_SPAN_LINKS ||
      (evidence.link_count > 0U && evidence.links == NULL)) {
    logbrew_internal_set_error(error, "validation_error", "span links must contain at most 8 entries", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (evidence.event_count > 0U) {
    status = logbrew_json_append(&buffer, "\"events\":[", error);
    for (index = 0U; status == LOGBREW_OK && index < evidence.event_count; index++) {
      if (index > 0U) status = logbrew_json_append_char(&buffer, ',', error);
      if (status == LOGBREW_OK) status = append_span_event(&buffer, &evidence.events[index], error);
    }
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, ']', error);
    if (status == LOGBREW_OK) needs_comma = true;
  }
  if (status == LOGBREW_OK && evidence.link_count > 0U) {
    if (needs_comma) status = logbrew_json_append_char(&buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, "\"links\":[", error);
    for (index = 0U; status == LOGBREW_OK && index < evidence.link_count; index++) {
      if (index > 0U) status = logbrew_json_append_char(&buffer, ',', error);
      if (status == LOGBREW_OK) status = append_span_link(&buffer, &evidence.links[index], error);
    }
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, ']', error);
  }
  if (status != LOGBREW_OK) {
    logbrew_json_dispose(&buffer);
    return status;
  }
  if (buffer.data == NULL) {
    buffer.data = (char *)malloc(1U);
    if (buffer.data == NULL) {
      logbrew_internal_set_error(error, "allocation_error", "out of memory", false);
      return LOGBREW_ALLOCATION_ERROR;
    }
    buffer.data[0] = '\0';
  }
  *out_fragment = buffer.data;
  return LOGBREW_OK;
}
