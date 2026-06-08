#include "logbrew.h"

#include <curl/curl.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void set_http_error(LogBrewError *error, const char *code, const char *message, bool retryable) {
  if (error == NULL) {
    return;
  }
  (void)snprintf(error->code, sizeof(error->code), "%s", code == NULL ? "transport_error" : code);
  (void)snprintf(error->message, sizeof(error->message), "%s", message == NULL ? "" : message);
  error->retryable = retryable;
}

static bool is_blank_http(const char *value) {
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

static bool starts_with(const char *value, const char *prefix) {
  return strncmp(value, prefix, strlen(prefix)) == 0;
}

static bool endpoint_has_host(const char *endpoint) {
  const char *host_start = strstr(endpoint, "://");
  if (host_start == NULL) {
    return false;
  }
  host_start += 3;
  return *host_start != '\0' && *host_start != '/' && *host_start != '?' && *host_start != '#';
}

static char *copy_http_string(const char *value) {
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

static bool header_name_is_safe(const char *name) {
  const unsigned char *cursor = (const unsigned char *)name;
  if (is_blank_http(name)) {
    return false;
  }
  while (*cursor != '\0') {
    if (*cursor <= 0x20U || *cursor == 0x7FU || *cursor == ':') {
      return false;
    }
    cursor++;
  }
  return true;
}

static bool header_value_is_safe(const char *value) {
  const unsigned char *cursor = (const unsigned char *)value;
  if (value == NULL) {
    return false;
  }
  while (*cursor != '\0') {
    if (*cursor == '\r' || *cursor == '\n') {
      return false;
    }
    cursor++;
  }
  return true;
}

static bool header_name_equals(const char *left, const char *right) {
  while (*left != '\0' && *right != '\0') {
    if (tolower((unsigned char)*left) != tolower((unsigned char)*right)) {
      return false;
    }
    left++;
    right++;
  }
  return *left == '\0' && *right == '\0';
}

static bool header_name_is_reserved(const char *name) {
  return header_name_equals(name, "authorization") || header_name_equals(name, "content-type");
}

static void clear_http_transport(LogBrewHttpTransport *transport) {
  size_t index;
  if (transport == NULL) {
    return;
  }
  free(transport->endpoint);
  transport->endpoint = NULL;
  if (transport->headers != NULL) {
    for (index = 0U; index < transport->header_count; index++) {
      free((char *)transport->headers[index].name);
      free((char *)transport->headers[index].value);
    }
  }
  free(transport->headers);
  transport->headers = NULL;
  transport->header_count = 0U;
  transport->timeout_ms = 0L;
}

static LogBrewStatus copy_headers(
    LogBrewHttpTransport *transport,
    const LogBrewHttpHeader *headers,
    size_t header_count,
    LogBrewError *error) {
  size_t index;
  if (header_count == 0U) {
    transport->headers = NULL;
    return LOGBREW_OK;
  }
  if (headers == NULL) {
    set_http_error(error, "configuration_error", "HTTP transport headers are required when header_count is non-zero", false);
    return LOGBREW_CONFIG_ERROR;
  }
  transport->headers = (LogBrewHttpHeader *)calloc(header_count, sizeof(LogBrewHttpHeader));
  if (transport->headers == NULL) {
    set_http_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  for (index = 0U; index < header_count; index++) {
    if (!header_name_is_safe(headers[index].name) || !header_value_is_safe(headers[index].value)) {
      set_http_error(error, "configuration_error", "HTTP transport headers must have safe names and values", false);
      return LOGBREW_CONFIG_ERROR;
    }
    if (header_name_is_reserved(headers[index].name)) {
      set_http_error(error, "configuration_error", "HTTP transport headers cannot override authorization or content-type", false);
      return LOGBREW_CONFIG_ERROR;
    }
    transport->headers[index].name = copy_http_string(headers[index].name);
    transport->headers[index].value = copy_http_string(headers[index].value);
    if (transport->headers[index].name == NULL || transport->headers[index].value == NULL) {
      set_http_error(error, "allocation_error", "out of memory", false);
      return LOGBREW_ALLOCATION_ERROR;
    }
    transport->header_count++;
  }
  return LOGBREW_OK;
}

LogBrewStatus logbrew_http_transport_init(
    LogBrewHttpTransport *transport,
    const char *endpoint,
    const LogBrewHttpHeader *headers,
    size_t header_count,
    long timeout_ms,
    LogBrewError *error) {
  LogBrewStatus status;
  const char *resolved_endpoint;
  if (transport == NULL) {
    set_http_error(error, "configuration_error", "HTTP transport is required", false);
    return LOGBREW_CONFIG_ERROR;
  }
  transport->endpoint = NULL;
  transport->headers = NULL;
  transport->header_count = 0U;
  transport->timeout_ms = 0L;
  resolved_endpoint = is_blank_http(endpoint) ? LOGBREW_HTTP_TRANSPORT_DEFAULT_ENDPOINT : endpoint;
  if (!starts_with(resolved_endpoint, "http://") && !starts_with(resolved_endpoint, "https://")) {
    set_http_error(error, "configuration_error", "HTTP transport endpoint must use http or https", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (!endpoint_has_host(resolved_endpoint)) {
    set_http_error(error, "configuration_error", "HTTP transport endpoint must include a host", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (timeout_ms <= 0L) {
    set_http_error(error, "configuration_error", "HTTP transport timeout_ms must be positive", false);
    return LOGBREW_CONFIG_ERROR;
  }
  transport->endpoint = copy_http_string(resolved_endpoint);
  if (transport->endpoint == NULL) {
    set_http_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  transport->timeout_ms = timeout_ms;
  status = copy_headers(transport, headers, header_count, error);
  if (status != LOGBREW_OK) {
    clear_http_transport(transport);
  }
  return status;
}

void logbrew_http_transport_free(LogBrewHttpTransport *transport) {
  clear_http_transport(transport);
}

static size_t discard_response_body(char *ptr, size_t size, size_t nmemb, void *userdata) {
  (void)ptr;
  (void)userdata;
  return size * nmemb;
}

static LogBrewStatus append_header(struct curl_slist **headers, const char *name, const char *value, LogBrewError *error) {
  size_t name_length = strlen(name);
  size_t value_length = strlen(value);
  size_t length;
  char *line;
  struct curl_slist *next;
  if (name_length > ((size_t)-1) - value_length - 3U) {
    set_http_error(error, "allocation_error", "header size overflow", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  length = name_length + value_length + 3U;
  line = (char *)malloc(length + 1U);
  if (line == NULL) {
    set_http_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  (void)snprintf(line, length + 1U, "%s: %s", name, value);
  next = curl_slist_append(*headers, line);
  free(line);
  if (next == NULL) {
    set_http_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  *headers = next;
  return LOGBREW_OK;
}

static LogBrewStatus build_request_headers(
    LogBrewHttpTransport *transport,
    const char *api_key,
    struct curl_slist **out_headers,
    LogBrewError *error) {
  size_t index;
  LogBrewStatus status;
  char *authorization;
  size_t api_key_length;
  *out_headers = NULL;
  status = append_header(out_headers, "content-type", "application/json", error);
  if (status != LOGBREW_OK) {
    return status;
  }
  api_key_length = strlen(api_key);
  authorization = (char *)malloc(api_key_length + 8U);
  if (authorization == NULL) {
    set_http_error(error, "allocation_error", "out of memory", false);
    return LOGBREW_ALLOCATION_ERROR;
  }
  (void)snprintf(authorization, api_key_length + 8U, "Bearer %s", api_key);
  status = append_header(out_headers, "authorization", authorization, error);
  free(authorization);
  if (status != LOGBREW_OK) {
    return status;
  }
  for (index = 0U; index < transport->header_count; index++) {
    status = append_header(out_headers, transport->headers[index].name, transport->headers[index].value, error);
    if (status != LOGBREW_OK) {
      return status;
    }
  }
  return LOGBREW_OK;
}

static LogBrewStatus http_transport_send(
    void *user_data,
    const char *api_key,
    const char *body,
    LogBrewTransportResponse *response,
    LogBrewError *error) {
  LogBrewHttpTransport *transport = (LogBrewHttpTransport *)user_data;
  CURL *curl;
  CURLcode curl_status;
  long response_code = 0L;
  struct curl_slist *headers = NULL;
  LogBrewStatus status;
  if (response != NULL) {
    response->status_code = 0;
    response->attempts = 1U;
  }
  if (transport == NULL || is_blank_http(transport->endpoint)) {
    set_http_error(error, "configuration_error", "HTTP transport is not initialized", false);
    return LOGBREW_CONFIG_ERROR;
  }
  if (is_blank_http(api_key)) {
    set_http_error(error, "validation_error", "api_key must be non-empty", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (body == NULL) {
    set_http_error(error, "validation_error", "body must be non-null", false);
    return LOGBREW_VALIDATION_ERROR;
  }
  if (curl_global_init(CURL_GLOBAL_DEFAULT) != 0) {
    set_http_error(error, "network_failure", "curl global initialization failed", true);
    return LOGBREW_TRANSPORT_ERROR;
  }
  curl = curl_easy_init();
  if (curl == NULL) {
    set_http_error(error, "network_failure", "curl initialization failed", true);
    return LOGBREW_TRANSPORT_ERROR;
  }
  status = build_request_headers(transport, api_key, &headers, error);
  if (status == LOGBREW_OK) {
    curl_easy_setopt(curl, CURLOPT_URL, transport->endpoint);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)strlen(body));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, transport->timeout_ms);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, transport->timeout_ms);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discard_response_body);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_status = curl_easy_perform(curl);
    if (curl_status != CURLE_OK) {
      set_http_error(error, "network_failure", curl_easy_strerror(curl_status), true);
      status = LOGBREW_TRANSPORT_ERROR;
    } else if (curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response_code) != CURLE_OK || response_code <= 0L) {
      set_http_error(error, "network_failure", "HTTP transport did not receive a response status", true);
      status = LOGBREW_TRANSPORT_ERROR;
    } else if (response != NULL) {
      response->status_code = (int)response_code;
    }
  }
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  return status;
}

LogBrewTransport logbrew_http_transport_as_transport(LogBrewHttpTransport *transport) {
  LogBrewTransport result;
  result.send = http_transport_send;
  result.user_data = transport;
  return result;
}
