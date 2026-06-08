#include "logbrew.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void set_recording_error(LogBrewError *error, const char *code, const char *message, bool retryable) {
  if (error == NULL) {
    return;
  }
  (void)snprintf(error->code, sizeof(error->code), "%s", code == NULL ? "sdk_error" : code);
  (void)snprintf(error->message, sizeof(error->message), "%s", message == NULL ? "" : message);
  error->retryable = retryable;
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

static LogBrewStatus recording_transport_store_body(
    LogBrewRecordingTransport *transport,
    const char *body,
    LogBrewError *error) {
  char **next;
  char *copy;
  size_t next_capacity;
  if (transport->sent_count == transport->sent_capacity) {
    next_capacity = transport->sent_capacity == 0U ? 4U : transport->sent_capacity * 2U;
    next = (char **)realloc(transport->sent_bodies, next_capacity * sizeof(char *));
    if (next == NULL) {
      set_recording_error(error, "allocation_error", "out of memory", false);
      return LOGBREW_ALLOCATION_ERROR;
    }
    transport->sent_bodies = next;
    transport->sent_capacity = next_capacity;
  }
  copy = copy_string(body);
  if (copy == NULL) {
    set_recording_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  transport->sent_bodies[transport->sent_count] = copy;
  transport->sent_count++;
  return LOGBREW_OK;
}

static LogBrewStatus recording_transport_send(
    void *user_data,
    const char *api_key,
    const char *body,
    LogBrewTransportResponse *response,
    LogBrewError *error) {
  LogBrewRecordingTransport *transport = (LogBrewRecordingTransport *)user_data;
  LogBrewRecordingStep step = LOGBREW_RECORD_STATUS_CODE(202);
  LogBrewStatus status;
  if (transport == NULL) {
    set_recording_error(error, "config_error", "recording transport is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (is_blank(api_key)) {
    set_recording_error(error, "validation_error", "api_key must be non-empty", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  status = recording_transport_store_body(transport, body, error);
  if (status != LOGBREW_OK) {
    return status;
  }
  if (transport->cursor < transport->step_count) {
    step = transport->steps[transport->cursor];
    transport->cursor++;
  }
  if (step.kind == LOGBREW_RECORD_ERROR) {
    set_recording_error(error,
                        step.code == NULL ? "transport_error" : step.code,
                        step.message == NULL ? "transport failed" : step.message,
                        step.retryable);
    return LOGBREW_TRANSPORT_ERROR;
  }
  if (response != NULL) {
    response->status_code = step.status_code;
    response->attempts = 1U;
  }
  return LOGBREW_OK;
}

LogBrewTransport logbrew_recording_transport_as_transport(LogBrewRecordingTransport *transport) {
  LogBrewTransport public_transport;
  public_transport.send = recording_transport_send;
  public_transport.user_data = transport;
  return public_transport;
}

const char *logbrew_recording_transport_last_body(const LogBrewRecordingTransport *transport) {
  if (transport == NULL || transport->sent_count == 0U) {
    return NULL;
  }
  return transport->sent_bodies[transport->sent_count - 1U];
}

size_t logbrew_recording_transport_sent_count(const LogBrewRecordingTransport *transport) {
  return transport == NULL ? 0U : transport->sent_count;
}
