#include "logbrew_internal.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_MSC_VER)
#define LOGBREW_CONTEXT_THREAD_LOCAL __declspec(thread)
#elif defined(__GNUC__) || defined(__clang__)
#define LOGBREW_CONTEXT_THREAD_LOCAL __thread
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define LOGBREW_CONTEXT_THREAD_LOCAL _Thread_local
#else
#error "LogBrew telemetry scopes require compiler thread-local storage support"
#endif

typedef struct {
  bool present;
  bool has_version;
  char name[257];
  char version[257];
} StoredNamedVersion;

typedef struct {
  bool present;
  bool has_environment;
  bool has_release;
  char environment[257];
  char release[257];
} StoredDeployment;

typedef struct {
  bool present;
  bool has_name;
  bool has_version;
  bool has_build;
  char name[257];
  char version[257];
  char build[257];
} StoredTriple;

typedef struct {
  bool present;
  bool has_family;
  bool has_model;
  bool has_architecture;
  char family[257];
  char model[257];
  char architecture[257];
} StoredDevice;

typedef struct {
  bool present;
  bool has_span_id;
  bool has_parent_span_id;
  bool has_sampled;
  char trace_id[LOGBREW_TRACE_ID_LENGTH + 1U];
  char span_id[LOGBREW_SPAN_ID_LENGTH + 1U];
  char parent_span_id[LOGBREW_SPAN_ID_LENGTH + 1U];
  bool sampled;
} StoredTrace;

typedef struct {
  bool present;
  bool has_previous_id;
  char id[201];
  char previous_id[201];
} StoredSession;

typedef struct {
  bool present;
  char id[201];
  LogBrewSubjectKind kind;
} StoredSubject;

typedef struct {
  char key[65];
  char value[257];
} StoredTag;

struct LogBrewContextStorage {
  StoredNamedVersion service;
  StoredDeployment deployment;
  StoredNamedVersion runtime;
  StoredNamedVersion framework;
  StoredTriple operating_system;
  StoredDevice device;
  StoredTriple application;
  StoredTrace trace;
  StoredSession session;
  StoredSubject subject;
  StoredTag tags[LOGBREW_MAX_CONTEXT_TAGS];
  size_t tag_count;
  bool tag_overflow;
  const LogBrewTelemetryScope *scope_owner;
};

static LOGBREW_CONTEXT_THREAD_LOCAL const LogBrewContextStorage *current_context = NULL;

static bool ascii_alpha(unsigned char value) {
  return (value >= (unsigned char)'A' && value <= (unsigned char)'Z') ||
      (value >= (unsigned char)'a' && value <= (unsigned char)'z');
}

static bool ascii_digit(unsigned char value) {
  return value >= (unsigned char)'0' && value <= (unsigned char)'9';
}

static bool ascii_alnum(unsigned char value) {
  return ascii_alpha(value) || ascii_digit(value);
}

static bool ascii_hex(unsigned char value) {
  return ascii_digit(value) ||
      (value >= (unsigned char)'A' && value <= (unsigned char)'F') ||
      (value >= (unsigned char)'a' && value <= (unsigned char)'f');
}

static char ascii_lower(unsigned char value) {
  return value >= (unsigned char)'A' && value <= (unsigned char)'Z'
      ? (char)(value + ((unsigned char)'a' - (unsigned char)'A'))
      : (char)value;
}

static bool forbidden_control(const unsigned char *value, size_t length) {
  size_t index;
  for (index = 0U; index < length; index++) {
    const unsigned char current = value[index];
    if (current < 0x20U || current == 0x7fU ||
        (current == 0xc2U && index + 1U < length && value[index + 1U] >= 0x80U &&
         value[index + 1U] <= 0x9fU)) {
      return true;
    }
  }
  return false;
}

static LogBrewStatus copy_context_string(
    const char *label,
    const char *value,
    size_t maximum,
    char *destination,
    size_t destination_size,
    LogBrewError *error) {
  const unsigned char *start = (const unsigned char *)value;
  const unsigned char *end;
  size_t length;
  char message[192];
  if (value == NULL) {
    (void)snprintf(message, sizeof(message), "%s is required", label);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  while (*start != '\0' && isspace(*start)) {
    start++;
  }
  end = start + strlen((const char *)start);
  while (end > start && isspace(*(end - 1))) {
    end--;
  }
  length = (size_t)(end - start);
  if (length == 0U || length > maximum || length + 1U > destination_size || forbidden_control(start, length)) {
    (void)snprintf(message, sizeof(message), "%s is invalid", label);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  memcpy(destination, start, length);
  destination[length] = '\0';
  return LOGBREW_OK;
}

static LogBrewStatus copy_optional_string(
    const char *label,
    const char *value,
    size_t maximum,
    char *destination,
    size_t destination_size,
    bool *present,
    LogBrewError *error) {
  if (value == NULL) {
    *present = false;
    destination[0] = '\0';
    return LOGBREW_OK;
  }
  *present = true;
  return copy_context_string(label, value, maximum, destination, destination_size, error);
}

static bool machine_key(const char *value, size_t maximum, const char *separators) {
  size_t index;
  size_t length;
  if (value == NULL) {
    return false;
  }
  length = strlen(value);
  if (length == 0U || length > maximum || !ascii_alpha((unsigned char)value[0])) {
    return false;
  }
  for (index = 1U; index < length; index++) {
    unsigned char current = (unsigned char)value[index];
    if (!ascii_alnum(current) && strchr(separators, (int)current) == NULL) {
      return false;
    }
  }
  return true;
}

static LogBrewStatus copy_hex_id(
    const char *label,
    const char *value,
    size_t length,
    char *destination,
    LogBrewError *error) {
  size_t index;
  bool non_zero = false;
  char message[192];
  if (value == NULL || strlen(value) != length) {
    (void)snprintf(message, sizeof(message), "%s must be a non-zero %lu-character hex value",
                   label, (unsigned long)length);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  for (index = 0U; index < length; index++) {
    unsigned char current = (unsigned char)value[index];
    if (!ascii_hex(current)) {
      (void)snprintf(message, sizeof(message), "%s must be a non-zero %lu-character hex value",
                     label, (unsigned long)length);
      logbrew_internal_set_error(error, "validation_error", message, false);
      return LOGBREW_VALIDATION_ERROR;
    }
    destination[index] = ascii_lower(current);
    non_zero = non_zero || current != '0';
  }
  if (!non_zero) {
    (void)snprintf(message, sizeof(message), "%s must be a non-zero %lu-character hex value",
                   label, (unsigned long)length);
    logbrew_internal_set_error(error, "validation_error", message, false);
    return LOGBREW_VALIDATION_ERROR;
  }
  destination[length] = '\0';
  return LOGBREW_OK;
}

static LogBrewStatus copy_named_version(
    const char *label,
    const LogBrewNamedVersion *value,
    StoredNamedVersion *destination,
    LogBrewError *error) {
  char name_label[192];
  char version_label[192];
  LogBrewStatus status;
  (void)snprintf(name_label, sizeof(name_label), "%s name", label);
  (void)snprintf(version_label, sizeof(version_label), "%s version", label);
  status = copy_context_string(name_label, value->name, 256U, destination->name, sizeof(destination->name), error);
  if (status == LOGBREW_OK) {
    status = copy_optional_string(version_label, value->version, 256U, destination->version,
                                  sizeof(destination->version), &destination->has_version, error);
  }
  if (status == LOGBREW_OK) {
    destination->present = true;
  }
  return status;
}

static LogBrewStatus context_from_public(
    const LogBrewTelemetryContext *context,
    LogBrewContextStorage *destination,
    LogBrewError *error) {
  const LogBrewTelemetryResource *resource;
  size_t index;
  LogBrewStatus status = LOGBREW_OK;
  bool has_any = false;
  memset(destination, 0, sizeof(*destination));
  if (context == NULL) {
    logbrew_internal_set_error(error, "config_error", "telemetry context is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (context->schema_version != LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION) {
    logbrew_internal_set_error(error, "validation_error", "telemetry context schema_version must be 1", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  resource = context->resource;
  if (resource != NULL) {
    if (resource->service != NULL) {
      status = copy_named_version("telemetry service", resource->service, &destination->service, error);
      has_any = status == LOGBREW_OK;
    }
    if (status == LOGBREW_OK && resource->deployment != NULL) {
      status = copy_optional_string("telemetry deployment environment", resource->deployment->environment, 256U,
          destination->deployment.environment, sizeof(destination->deployment.environment),
          &destination->deployment.has_environment, error);
      if (status == LOGBREW_OK) {
        status = copy_optional_string("telemetry deployment release", resource->deployment->release, 256U,
            destination->deployment.release, sizeof(destination->deployment.release),
            &destination->deployment.has_release, error);
      }
      destination->deployment.present = destination->deployment.has_environment || destination->deployment.has_release;
      if (status == LOGBREW_OK && !destination->deployment.present) {
        logbrew_internal_set_error(error, "validation_error", "telemetry deployment must not be empty", false);
        status = LOGBREW_VALIDATION_ERROR;
      }
      has_any = has_any || (status == LOGBREW_OK && destination->deployment.present);
    }
    if (status == LOGBREW_OK && resource->runtime != NULL) {
      status = copy_named_version("telemetry runtime", resource->runtime, &destination->runtime, error);
      has_any = has_any || status == LOGBREW_OK;
    }
    if (status == LOGBREW_OK && resource->framework != NULL) {
      status = copy_named_version("telemetry framework", resource->framework, &destination->framework, error);
      has_any = has_any || status == LOGBREW_OK;
    }
    if (status == LOGBREW_OK && resource->operating_system != NULL) {
      const LogBrewOperatingSystemContext *value = resource->operating_system;
      status = copy_context_string("telemetry operating system name", value->name, 256U,
          destination->operating_system.name, sizeof(destination->operating_system.name), error);
      destination->operating_system.has_name = status == LOGBREW_OK;
      if (status == LOGBREW_OK) {
        status = copy_optional_string("telemetry operating system version", value->version, 256U,
            destination->operating_system.version, sizeof(destination->operating_system.version),
            &destination->operating_system.has_version, error);
      }
      if (status == LOGBREW_OK) {
        status = copy_optional_string("telemetry operating system build", value->build, 256U,
            destination->operating_system.build, sizeof(destination->operating_system.build),
            &destination->operating_system.has_build, error);
      }
      destination->operating_system.present = status == LOGBREW_OK;
      has_any = has_any || status == LOGBREW_OK;
    }
    if (status == LOGBREW_OK && resource->device != NULL) {
      const LogBrewDeviceContext *value = resource->device;
      status = copy_optional_string("telemetry device family", value->family, 256U,
          destination->device.family, sizeof(destination->device.family), &destination->device.has_family, error);
      if (status == LOGBREW_OK) {
        status = copy_optional_string("telemetry device model", value->model, 256U,
            destination->device.model, sizeof(destination->device.model), &destination->device.has_model, error);
      }
      if (status == LOGBREW_OK) {
        status = copy_optional_string("telemetry device architecture", value->architecture, 256U,
            destination->device.architecture, sizeof(destination->device.architecture),
            &destination->device.has_architecture, error);
      }
      destination->device.present = destination->device.has_family || destination->device.has_model ||
          destination->device.has_architecture;
      if (status == LOGBREW_OK && !destination->device.present) {
        logbrew_internal_set_error(error, "validation_error", "telemetry device must not be empty", false);
        status = LOGBREW_VALIDATION_ERROR;
      }
      has_any = has_any || (status == LOGBREW_OK && destination->device.present);
    }
    if (status == LOGBREW_OK && resource->application != NULL) {
      const LogBrewApplicationContext *value = resource->application;
      status = copy_optional_string("telemetry application name", value->name, 256U,
          destination->application.name, sizeof(destination->application.name), &destination->application.has_name, error);
      if (status == LOGBREW_OK) {
        status = copy_optional_string("telemetry application version", value->version, 256U,
            destination->application.version, sizeof(destination->application.version),
            &destination->application.has_version, error);
      }
      if (status == LOGBREW_OK) {
        status = copy_optional_string("telemetry application build", value->build, 256U,
            destination->application.build, sizeof(destination->application.build),
            &destination->application.has_build, error);
      }
      destination->application.present = destination->application.has_name || destination->application.has_version ||
          destination->application.has_build;
      if (status == LOGBREW_OK && !destination->application.present) {
        logbrew_internal_set_error(error, "validation_error", "telemetry application must not be empty", false);
        status = LOGBREW_VALIDATION_ERROR;
      }
      has_any = has_any || (status == LOGBREW_OK && destination->application.present);
    }
    if (status == LOGBREW_OK && !destination->service.present && !destination->deployment.present &&
        !destination->runtime.present && !destination->framework.present && !destination->operating_system.present &&
        !destination->device.present && !destination->application.present) {
      logbrew_internal_set_error(error, "validation_error", "telemetry resource must not be empty", false);
      status = LOGBREW_VALIDATION_ERROR;
    }
  }
  if (status == LOGBREW_OK && context->trace != NULL) {
    const LogBrewTelemetryTraceContext *value = context->trace;
    status = copy_hex_id("telemetry trace trace_id", value->trace_id, LOGBREW_TRACE_ID_LENGTH,
                         destination->trace.trace_id, error);
    if (status == LOGBREW_OK && value->span_id != NULL) {
      status = copy_hex_id("telemetry trace span_id", value->span_id, LOGBREW_SPAN_ID_LENGTH,
                           destination->trace.span_id, error);
      destination->trace.has_span_id = status == LOGBREW_OK;
    }
    if (status == LOGBREW_OK && value->parent_span_id != NULL) {
      status = copy_hex_id("telemetry trace parent_span_id", value->parent_span_id, LOGBREW_SPAN_ID_LENGTH,
                           destination->trace.parent_span_id, error);
      destination->trace.has_parent_span_id = status == LOGBREW_OK;
    }
    destination->trace.sampled = value->sampled;
    destination->trace.has_sampled = value->has_sampled;
    destination->trace.present = status == LOGBREW_OK;
    has_any = has_any || status == LOGBREW_OK;
  }
  if (status == LOGBREW_OK && context->session != NULL) {
    status = copy_context_string("telemetry session id", context->session->id, 200U,
        destination->session.id, sizeof(destination->session.id), error);
    if (status == LOGBREW_OK) {
      status = copy_optional_string("telemetry session previous_id", context->session->previous_id, 200U,
          destination->session.previous_id, sizeof(destination->session.previous_id),
          &destination->session.has_previous_id, error);
    }
    if (status == LOGBREW_OK && destination->session.has_previous_id &&
        strcmp(destination->session.id, destination->session.previous_id) == 0) {
      logbrew_internal_set_error(error, "validation_error", "telemetry session previous_id must differ from id", false);
      status = LOGBREW_VALIDATION_ERROR;
    }
    destination->session.present = status == LOGBREW_OK;
    has_any = has_any || status == LOGBREW_OK;
  }
  if (status == LOGBREW_OK && context->subject != NULL) {
    status = copy_context_string("telemetry subject id", context->subject->id, 200U,
        destination->subject.id, sizeof(destination->subject.id), error);
    if (status == LOGBREW_OK && context->subject->kind != LOGBREW_SUBJECT_ANONYMOUS &&
        context->subject->kind != LOGBREW_SUBJECT_USER) {
      logbrew_internal_set_error(error, "validation_error", "telemetry subject kind is invalid", false);
      status = LOGBREW_VALIDATION_ERROR;
    }
    destination->subject.kind = context->subject->kind;
    destination->subject.present = status == LOGBREW_OK;
    has_any = has_any || status == LOGBREW_OK;
  }
  if (status == LOGBREW_OK && context->tag_count > 0U) {
    if (context->tags == NULL || context->tag_count > LOGBREW_MAX_CONTEXT_TAGS) {
      logbrew_internal_set_error(error, "validation_error", "telemetry tags must contain 1-32 entries", false);
      status = LOGBREW_VALIDATION_ERROR;
    }
    for (index = 0U; status == LOGBREW_OK && index < context->tag_count; index++) {
      size_t prior;
      const LogBrewTelemetryTag *tag = &context->tags[index];
      if (!machine_key(tag->key, 64U, "_.-")) {
        logbrew_internal_set_error(error, "validation_error", "telemetry tag key is invalid", false);
        status = LOGBREW_VALIDATION_ERROR;
        break;
      }
      for (prior = 0U; prior < index; prior++) {
        if (strcmp(context->tags[prior].key, tag->key) == 0) {
          logbrew_internal_set_error(error, "validation_error", "telemetry tags contain a duplicate key", false);
          status = LOGBREW_VALIDATION_ERROR;
          break;
        }
      }
      if (status == LOGBREW_OK) {
        (void)snprintf(destination->tags[index].key, sizeof(destination->tags[index].key), "%s", tag->key);
        status = copy_context_string("telemetry tag value", tag->value, 256U,
            destination->tags[index].value, sizeof(destination->tags[index].value), error);
      }
    }
    if (status == LOGBREW_OK) {
      destination->tag_count = context->tag_count;
      has_any = true;
    }
  } else if (status == LOGBREW_OK && context->tags != NULL) {
    logbrew_internal_set_error(error, "validation_error", "telemetry tags must contain 1-32 entries", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status == LOGBREW_OK && !has_any) {
    logbrew_internal_set_error(error, "validation_error",
        "telemetry context must include resource, trace, session, subject, or tags", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  return status;
}

static void merge_named(StoredNamedVersion *destination, const StoredNamedVersion *source) {
  if (!source->present) {
    return;
  }
  destination->present = true;
  (void)snprintf(destination->name, sizeof(destination->name), "%s", source->name);
  if (source->has_version) {
    destination->has_version = true;
    (void)snprintf(destination->version, sizeof(destination->version), "%s", source->version);
  }
}

static void merge_context(LogBrewContextStorage *destination, const LogBrewContextStorage *source) {
  size_t index;
  merge_named(&destination->service, &source->service);
  merge_named(&destination->runtime, &source->runtime);
  merge_named(&destination->framework, &source->framework);
  if (source->deployment.present) {
    destination->deployment.present = true;
    if (source->deployment.has_environment) {
      destination->deployment.has_environment = true;
      (void)snprintf(destination->deployment.environment, sizeof(destination->deployment.environment), "%s",
                     source->deployment.environment);
    }
    if (source->deployment.has_release) {
      destination->deployment.has_release = true;
      (void)snprintf(destination->deployment.release, sizeof(destination->deployment.release), "%s",
                     source->deployment.release);
    }
  }
#define MERGE_TRIPLE_FIELD(target, incoming, field) \
  do { \
    if ((incoming)->has_##field) { \
      (target)->has_##field = true; \
      (void)snprintf((target)->field, sizeof((target)->field), "%s", (incoming)->field); \
    } \
  } while (0)
  if (source->operating_system.present) {
    destination->operating_system.present = true;
    MERGE_TRIPLE_FIELD(&destination->operating_system, &source->operating_system, name);
    MERGE_TRIPLE_FIELD(&destination->operating_system, &source->operating_system, version);
    MERGE_TRIPLE_FIELD(&destination->operating_system, &source->operating_system, build);
  }
  if (source->application.present) {
    destination->application.present = true;
    MERGE_TRIPLE_FIELD(&destination->application, &source->application, name);
    MERGE_TRIPLE_FIELD(&destination->application, &source->application, version);
    MERGE_TRIPLE_FIELD(&destination->application, &source->application, build);
  }
#undef MERGE_TRIPLE_FIELD
  if (source->device.present) {
    destination->device.present = true;
    if (source->device.has_family) {
      destination->device.has_family = true;
      (void)snprintf(destination->device.family, sizeof(destination->device.family), "%s", source->device.family);
    }
    if (source->device.has_model) {
      destination->device.has_model = true;
      (void)snprintf(destination->device.model, sizeof(destination->device.model), "%s", source->device.model);
    }
    if (source->device.has_architecture) {
      destination->device.has_architecture = true;
      (void)snprintf(destination->device.architecture, sizeof(destination->device.architecture), "%s",
                     source->device.architecture);
    }
  }
  if (source->trace.present) {
    if (!destination->trace.present || strcmp(destination->trace.trace_id, source->trace.trace_id) != 0) {
      memset(&destination->trace, 0, sizeof(destination->trace));
    } else if (source->trace.has_span_id &&
        (!destination->trace.has_span_id ||
         strcmp(destination->trace.span_id, source->trace.span_id) != 0)) {
      destination->trace.has_parent_span_id = false;
      destination->trace.parent_span_id[0] = '\0';
    }
    destination->trace.present = true;
    (void)snprintf(destination->trace.trace_id, sizeof(destination->trace.trace_id), "%s", source->trace.trace_id);
    if (source->trace.has_span_id) {
      destination->trace.has_span_id = true;
      (void)snprintf(destination->trace.span_id, sizeof(destination->trace.span_id), "%s", source->trace.span_id);
    }
    if (source->trace.has_parent_span_id) {
      destination->trace.has_parent_span_id = true;
      (void)snprintf(destination->trace.parent_span_id, sizeof(destination->trace.parent_span_id), "%s",
                     source->trace.parent_span_id);
    }
    if (source->trace.has_sampled) {
      destination->trace.has_sampled = true;
      destination->trace.sampled = source->trace.sampled;
    }
  }
  if (source->session.present) {
    destination->session = source->session;
  }
  if (source->subject.present) {
    destination->subject = source->subject;
  }
  for (index = 0U; index < source->tag_count; index++) {
    size_t target_index;
    bool replaced = false;
    for (target_index = 0U; target_index < destination->tag_count; target_index++) {
      if (strcmp(destination->tags[target_index].key, source->tags[index].key) == 0) {
        destination->tags[target_index] = source->tags[index];
        replaced = true;
        break;
      }
    }
    if (!replaced && destination->tag_count < LOGBREW_MAX_CONTEXT_TAGS) {
      destination->tags[destination->tag_count++] = source->tags[index];
    } else if (!replaced) {
      destination->tag_overflow = true;
    }
  }
  destination->tag_overflow = destination->tag_overflow || source->tag_overflow;
}

static void automatic_context(LogBrewContextStorage *destination) {
  memset(destination, 0, sizeof(*destination));
  destination->runtime.present = true;
  (void)snprintf(destination->runtime.name, sizeof(destination->runtime.name), "%s", "c");
  destination->runtime.has_version = true;
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L
  (void)snprintf(destination->runtime.version, sizeof(destination->runtime.version), "%s", "c23");
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201710L
  (void)snprintf(destination->runtime.version, sizeof(destination->runtime.version), "%s", "c17");
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
  (void)snprintf(destination->runtime.version, sizeof(destination->runtime.version), "%s", "c11");
#else
  (void)snprintf(destination->runtime.version, sizeof(destination->runtime.version), "%s", "c99");
#endif
#if defined(__APPLE__)
  destination->operating_system.present = true;
  destination->operating_system.has_name = true;
  (void)snprintf(destination->operating_system.name, sizeof(destination->operating_system.name), "%s", "Darwin");
#elif defined(_WIN32)
  destination->operating_system.present = true;
  destination->operating_system.has_name = true;
  (void)snprintf(destination->operating_system.name, sizeof(destination->operating_system.name), "%s", "Windows");
#elif defined(__linux__)
  destination->operating_system.present = true;
  destination->operating_system.has_name = true;
  (void)snprintf(destination->operating_system.name, sizeof(destination->operating_system.name), "%s", "Linux");
#elif defined(__FreeBSD__)
  destination->operating_system.present = true;
  destination->operating_system.has_name = true;
  (void)snprintf(destination->operating_system.name, sizeof(destination->operating_system.name), "%s", "FreeBSD");
#endif
#if defined(__aarch64__) || defined(_M_ARM64)
  destination->device.present = true;
  destination->device.has_architecture = true;
  (void)snprintf(destination->device.architecture, sizeof(destination->device.architecture), "%s", "arm64");
#elif defined(__x86_64__) || defined(_M_X64)
  destination->device.present = true;
  destination->device.has_architecture = true;
  (void)snprintf(destination->device.architecture, sizeof(destination->device.architecture), "%s", "x86_64");
#elif defined(__i386__) || defined(_M_IX86)
  destination->device.present = true;
  destination->device.has_architecture = true;
  (void)snprintf(destination->device.architecture, sizeof(destination->device.architecture), "%s", "x86");
#elif defined(__arm__) || defined(_M_ARM)
  destination->device.present = true;
  destination->device.has_architecture = true;
  (void)snprintf(destination->device.architecture, sizeof(destination->device.architecture), "%s", "arm");
#endif
}

LogBrewStatus logbrew_context_storage_create(
    const LogBrewTelemetryContext *context,
    bool include_automatic_context,
    LogBrewContextStorage **out_storage,
    LogBrewError *error) {
  LogBrewContextStorage provided;
  LogBrewStatus status = LOGBREW_OK;
  if (out_storage == NULL) {
    logbrew_internal_set_error(error, "config_error", "out_storage is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  *out_storage = (LogBrewContextStorage *)calloc(1U, sizeof(LogBrewContextStorage));
  if (*out_storage == NULL) {
    logbrew_internal_set_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  if (include_automatic_context) {
    automatic_context(*out_storage);
  }
  if (context != NULL) {
    status = context_from_public(context, &provided, error);
    if (status == LOGBREW_OK) {
      merge_context(*out_storage, &provided);
      if ((*out_storage)->tag_overflow) {
        logbrew_internal_set_error(error, "validation_error", "merged telemetry tags exceed 32 entries", false);
        status = LOGBREW_VALIDATION_ERROR;
      }
    }
  }
  if (status != LOGBREW_OK) {
    logbrew_context_storage_free(*out_storage);
    *out_storage = NULL;
  }
  return status;
}

void logbrew_context_storage_free(LogBrewContextStorage *storage) {
  free(storage);
}

LogBrewStatus logbrew_telemetry_context_validate(
    const LogBrewTelemetryContext *context,
    LogBrewError *error) {
  LogBrewContextStorage storage;
  return context_from_public(context, &storage, error);
}

LogBrewStatus logbrew_telemetry_scope_enter(
    LogBrewTelemetryScope *scope,
    const LogBrewTelemetryContext *context,
    LogBrewError *error) {
  LogBrewContextStorage *snapshot = NULL;
  LogBrewStatus status;
  if (scope == NULL) {
    logbrew_internal_set_error(error, "config_error", "telemetry scope is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (context == NULL) {
    logbrew_internal_set_error(error, "config_error", "telemetry context is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (scope->active || scope->snapshot != NULL || scope->previous != NULL) {
    logbrew_internal_set_error(error, "config_error",
        "telemetry scope must be initialized and inactive", false);
    return LOGBREW_CONFIG_ERROR;
  }
  status = logbrew_context_storage_create(context, false, &snapshot, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  if (current_context != NULL) {
    LogBrewContextStorage provided = *snapshot;
    *snapshot = *current_context;
    merge_context(snapshot, &provided);
    if (snapshot->tag_overflow) {
      logbrew_context_storage_free(snapshot);
      logbrew_internal_set_error(error, "validation_error", "merged telemetry tags exceed 32 entries", false);
      return LOGBREW_VALIDATION_ERROR;
    }
  }
  scope->snapshot = snapshot;
  scope->previous = current_context;
  scope->active = true;
  snapshot->scope_owner = scope;
  current_context = snapshot;
  return LOGBREW_OK;
}

void logbrew_telemetry_scope_exit(LogBrewTelemetryScope *scope) {
  if (scope == NULL || !scope->active) {
    return;
  }
  if (current_context != scope->snapshot) {
    return;
  }
  if (((const LogBrewContextStorage *)scope->snapshot)->scope_owner != scope) {
    return;
  }
  current_context = (const LogBrewContextStorage *)scope->previous;
  logbrew_context_storage_free((LogBrewContextStorage *)scope->snapshot);
  scope->snapshot = NULL;
  scope->previous = NULL;
  scope->active = false;
}

static bool context_empty(const LogBrewContextStorage *context) {
  return !context->service.present && !context->deployment.present && !context->runtime.present &&
      !context->framework.present && !context->operating_system.present && !context->device.present &&
      !context->application.present && !context->trace.present && !context->session.present &&
      !context->subject.present && context->tag_count == 0U;
}

static void merge_trace_context(LogBrewContextStorage *destination, const LogBrewTraceContext *trace) {
  StoredTrace incoming;
  if (trace == NULL || trace->trace_id[0] == '\0' || trace->span_id[0] == '\0') {
    return;
  }
  memset(&incoming, 0, sizeof(incoming));
  incoming.present = true;
  incoming.has_span_id = true;
  incoming.has_sampled = true;
  incoming.sampled = trace->sampled;
  (void)snprintf(incoming.trace_id, sizeof(incoming.trace_id), "%s", trace->trace_id);
  (void)snprintf(incoming.span_id, sizeof(incoming.span_id), "%s", trace->span_id);
  if (trace->parent_span_id[0] != '\0') {
    incoming.has_parent_span_id = true;
    (void)snprintf(incoming.parent_span_id, sizeof(incoming.parent_span_id), "%s", trace->parent_span_id);
  }
  {
    LogBrewContextStorage layer;
    memset(&layer, 0, sizeof(layer));
    layer.trace = incoming;
    merge_context(destination, &layer);
  }
}

static void merge_signal_span_context(
    LogBrewContextStorage *destination,
    const LogBrewSpanAttributes *span) {
  LogBrewContextStorage layer;
  StoredTrace *incoming = &layer.trace;
  if (span == NULL) {
    return;
  }
  memset(&layer, 0, sizeof(layer));
  if (copy_hex_id("span trace_id", span->trace_id, LOGBREW_TRACE_ID_LENGTH,
          incoming->trace_id, NULL) != LOGBREW_OK ||
      copy_hex_id("span span_id", span->span_id, LOGBREW_SPAN_ID_LENGTH,
          incoming->span_id, NULL) != LOGBREW_OK ||
      (span->parent_span_id != NULL &&
       copy_hex_id("span parent_span_id", span->parent_span_id, LOGBREW_SPAN_ID_LENGTH,
           incoming->parent_span_id, NULL) != LOGBREW_OK)) {
    memset(&destination->trace, 0, sizeof(destination->trace));
    return;
  }
  incoming->present = true;
  incoming->has_span_id = true;
  incoming->has_parent_span_id = span->parent_span_id != NULL;
  merge_context(destination, &layer);
}

static LogBrewStatus append_named_version(
    LogBrewJsonBuffer *buffer,
    const char *name,
    const StoredNamedVersion *value,
    bool *needs_comma,
    LogBrewError *error) {
  bool item_comma = false;
  LogBrewStatus status = *needs_comma ? logbrew_json_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) status = logbrew_json_append_string(buffer, name, error);
  if (status == LOGBREW_OK) status = logbrew_json_append(buffer, ":{", error);
  if (status == LOGBREW_OK) status = logbrew_json_append_named_string(buffer, "name", value->name, &item_comma, error);
  if (status == LOGBREW_OK && value->has_version) {
    status = logbrew_json_append_named_string(buffer, "version", value->version, &item_comma, error);
  }
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  if (status == LOGBREW_OK) *needs_comma = true;
  return status;
}

static LogBrewStatus append_resource(
    LogBrewJsonBuffer *buffer,
    const LogBrewContextStorage *value,
    bool *needs_comma,
    LogBrewError *error) {
  bool item_comma = false;
  bool has_resource = value->service.present || value->deployment.present || value->runtime.present ||
      value->framework.present || value->operating_system.present || value->device.present || value->application.present;
  LogBrewStatus status;
  if (!has_resource) {
    return LOGBREW_OK;
  }
  status = *needs_comma ? logbrew_json_append_char(buffer, ',', error) : LOGBREW_OK;
  if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"resource\":{", error);
  if (status == LOGBREW_OK && value->service.present) {
    status = append_named_version(buffer, "service", &value->service, &item_comma, error);
  }
  if (status == LOGBREW_OK && value->deployment.present) {
    bool nested_comma = false;
    if (item_comma) status = logbrew_json_append_char(buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"deployment\":{", error);
    if (status == LOGBREW_OK && value->deployment.has_environment) {
      status = logbrew_json_append_named_string(buffer, "environment", value->deployment.environment, &nested_comma, error);
    }
    if (status == LOGBREW_OK && value->deployment.has_release) {
      status = logbrew_json_append_named_string(buffer, "release", value->deployment.release, &nested_comma, error);
    }
    if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
    if (status == LOGBREW_OK) item_comma = true;
  }
  if (status == LOGBREW_OK && value->runtime.present) {
    status = append_named_version(buffer, "runtime", &value->runtime, &item_comma, error);
  }
  if (status == LOGBREW_OK && value->framework.present) {
    status = append_named_version(buffer, "framework", &value->framework, &item_comma, error);
  }
#define APPEND_TRIPLE_OBJECT(object_name, object_value) \
  do { \
    bool nested_comma = false; \
    if (item_comma) status = logbrew_json_append_char(buffer, ',', error); \
    if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"" object_name "\":{", error); \
    if (status == LOGBREW_OK && (object_value).has_name) \
      status = logbrew_json_append_named_string(buffer, "name", (object_value).name, &nested_comma, error); \
    if (status == LOGBREW_OK && (object_value).has_version) \
      status = logbrew_json_append_named_string(buffer, "version", (object_value).version, &nested_comma, error); \
    if (status == LOGBREW_OK && (object_value).has_build) \
      status = logbrew_json_append_named_string(buffer, "build", (object_value).build, &nested_comma, error); \
    if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error); \
    if (status == LOGBREW_OK) item_comma = true; \
  } while (0)
  if (status == LOGBREW_OK && value->operating_system.present) {
    APPEND_TRIPLE_OBJECT("operatingSystem", value->operating_system);
  }
  if (status == LOGBREW_OK && value->device.present) {
    bool nested_comma = false;
    if (item_comma) status = logbrew_json_append_char(buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(buffer, "\"device\":{", error);
    if (status == LOGBREW_OK && value->device.has_family)
      status = logbrew_json_append_named_string(buffer, "family", value->device.family, &nested_comma, error);
    if (status == LOGBREW_OK && value->device.has_model)
      status = logbrew_json_append_named_string(buffer, "model", value->device.model, &nested_comma, error);
    if (status == LOGBREW_OK && value->device.has_architecture)
      status = logbrew_json_append_named_string(buffer, "architecture", value->device.architecture, &nested_comma, error);
    if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
    if (status == LOGBREW_OK) item_comma = true;
  }
  if (status == LOGBREW_OK && value->application.present) {
    APPEND_TRIPLE_OBJECT("application", value->application);
  }
#undef APPEND_TRIPLE_OBJECT
  if (status == LOGBREW_OK) status = logbrew_json_append_char(buffer, '}', error);
  if (status == LOGBREW_OK) *needs_comma = true;
  return status;
}

static LogBrewStatus serialize_context(
    const LogBrewContextStorage *value,
    char **out_json,
    LogBrewError *error) {
  LogBrewJsonBuffer buffer = {0};
  bool needs_comma = false;
  LogBrewStatus status = logbrew_json_append_char(&buffer, '{', error);
  if (status == LOGBREW_OK) {
    status = logbrew_json_append(&buffer, "\"schemaVersion\":1", error);
    needs_comma = status == LOGBREW_OK;
  }
  if (status == LOGBREW_OK) status = append_resource(&buffer, value, &needs_comma, error);
  if (status == LOGBREW_OK && value->trace.present) {
    bool nested_comma = false;
    if (needs_comma) status = logbrew_json_append_char(&buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, "\"trace\":{", error);
    if (status == LOGBREW_OK) status = logbrew_json_append_named_string(&buffer, "traceId", value->trace.trace_id, &nested_comma, error);
    if (status == LOGBREW_OK && value->trace.has_span_id)
      status = logbrew_json_append_named_string(&buffer, "spanId", value->trace.span_id, &nested_comma, error);
    if (status == LOGBREW_OK && value->trace.has_parent_span_id)
      status = logbrew_json_append_named_string(&buffer, "parentSpanId", value->trace.parent_span_id, &nested_comma, error);
    if (status == LOGBREW_OK && value->trace.has_sampled)
      status = logbrew_json_append_named_bool(&buffer, "sampled", value->trace.sampled, &nested_comma, error);
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, '}', error);
    needs_comma = status == LOGBREW_OK;
  }
  if (status == LOGBREW_OK && value->session.present) {
    bool nested_comma = false;
    if (needs_comma) status = logbrew_json_append_char(&buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, "\"session\":{", error);
    if (status == LOGBREW_OK) status = logbrew_json_append_named_string(&buffer, "id", value->session.id, &nested_comma, error);
    if (status == LOGBREW_OK && value->session.has_previous_id)
      status = logbrew_json_append_named_string(&buffer, "previousId", value->session.previous_id, &nested_comma, error);
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, '}', error);
    needs_comma = status == LOGBREW_OK;
  }
  if (status == LOGBREW_OK && value->subject.present) {
    bool nested_comma = false;
    if (needs_comma) status = logbrew_json_append_char(&buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, "\"subject\":{", error);
    if (status == LOGBREW_OK) status = logbrew_json_append_named_string(&buffer, "id", value->subject.id, &nested_comma, error);
    if (status == LOGBREW_OK) status = logbrew_json_append_named_string(&buffer, "kind",
        value->subject.kind == LOGBREW_SUBJECT_USER ? "user" : "anonymous", &nested_comma, error);
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, '}', error);
    needs_comma = status == LOGBREW_OK;
  }
  if (status == LOGBREW_OK && value->tag_count > 0U) {
    bool nested_comma = false;
    size_t index;
    if (needs_comma) status = logbrew_json_append_char(&buffer, ',', error);
    if (status == LOGBREW_OK) status = logbrew_json_append(&buffer, "\"tags\":{", error);
    for (index = 0U; status == LOGBREW_OK && index < value->tag_count; index++) {
      status = logbrew_json_append_named_string(&buffer, value->tags[index].key, value->tags[index].value,
                                                 &nested_comma, error);
    }
    if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, '}', error);
  }
  if (status == LOGBREW_OK) status = logbrew_json_append_char(&buffer, '}', error);
  if (status != LOGBREW_OK) {
    logbrew_json_dispose(&buffer);
    return status;
  }
  *out_json = buffer.data;
  return LOGBREW_OK;
}

LogBrewStatus logbrew_context_build_json(
    const LogBrewContextStorage *base,
    const LogBrewSpanAttributes *signal_span,
    const LogBrewTelemetryContext *event_context,
    char **out_json,
    LogBrewError *error) {
  LogBrewContextStorage effective;
  LogBrewContextStorage event_storage;
  LogBrewStatus status = LOGBREW_OK;
  const LogBrewTraceContext *active_trace;
  if (out_json == NULL) {
    logbrew_internal_set_error(error, "config_error", "out_json is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  *out_json = NULL;
  memset(&effective, 0, sizeof(effective));
  if (base != NULL) merge_context(&effective, base);
  if (current_context != NULL) merge_context(&effective, current_context);
  active_trace = logbrew_trace_current_context();
  merge_trace_context(&effective, active_trace);
  merge_signal_span_context(&effective, signal_span);
  if (event_context != NULL) {
    status = context_from_public(event_context, &event_storage, error);
    if (status == LOGBREW_OK) merge_context(&effective, &event_storage);
  }
  if (status == LOGBREW_OK && effective.tag_overflow) {
    logbrew_internal_set_error(error, "validation_error", "merged telemetry tags exceed 32 entries", false);
    status = LOGBREW_VALIDATION_ERROR;
  }
  if (status != LOGBREW_OK || context_empty(&effective)) {
    return status;
  }
  return serialize_context(&effective, out_json, error);
}
