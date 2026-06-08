#include "logbrew.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <cctype>
#include <string>
#include <utility>

namespace logbrew {
namespace {

[[nodiscard]] bool is_blank_http(const std::string &value) {
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return std::isspace(character) != 0;
  });
}

[[nodiscard]] bool starts_with(const std::string &value, const std::string &prefix) {
  return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

[[nodiscard]] bool endpoint_has_host(const std::string &endpoint) {
  const auto scheme = endpoint.find("://");
  if (scheme == std::string::npos) {
    return false;
  }
  const auto host_start = scheme + 3U;
  return host_start < endpoint.size() && endpoint[host_start] != '/' && endpoint[host_start] != '?' &&
         endpoint[host_start] != '#';
}

[[nodiscard]] bool header_name_is_safe(const std::string &name) {
  if (is_blank_http(name)) {
    return false;
  }
  return std::all_of(name.begin(), name.end(), [](unsigned char character) {
    return character > 0x20U && character != 0x7FU && character != ':';
  });
}

[[nodiscard]] bool header_value_is_safe(const std::string &value) {
  return value.find('\r') == std::string::npos && value.find('\n') == std::string::npos;
}

[[nodiscard]] bool header_name_equals(const std::string &left, const std::string &right) {
  if (left.size() != right.size()) {
    return false;
  }
  for (std::size_t index = 0; index < left.size(); index++) {
    if (std::tolower(static_cast<unsigned char>(left[index])) !=
        std::tolower(static_cast<unsigned char>(right[index]))) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] bool header_name_is_reserved(const std::string &name) {
  return header_name_equals(name, "authorization") || header_name_equals(name, "content-type");
}

[[nodiscard]] std::string resolved_endpoint(const std::string &endpoint) {
  return is_blank_http(endpoint) ? std::string(http_transport_default_endpoint) : endpoint;
}

void validate_endpoint(const std::string &endpoint) {
  if (!starts_with(endpoint, "http://") && !starts_with(endpoint, "https://")) {
    throw SdkException("configuration_error", "HTTP transport endpoint must use http or https");
  }
  if (!endpoint_has_host(endpoint)) {
    throw SdkException("configuration_error", "HTTP transport endpoint must include a host");
  }
}

void validate_header(const HttpHeader &header) {
  if (!header_name_is_safe(header.name) || !header_value_is_safe(header.value)) {
    throw SdkException("configuration_error", "HTTP transport headers must have safe names and values");
  }
  if (header_name_is_reserved(header.name)) {
    throw SdkException("configuration_error", "HTTP transport headers cannot override authorization or content-type");
  }
}

size_t discard_response_body(char *ptr, size_t size, size_t nmemb, void *userdata) {
  (void)ptr;
  (void)userdata;
  return size * nmemb;
}

void append_header(curl_slist *&headers, const std::string &name, const std::string &value) {
  curl_slist *next = curl_slist_append(headers, (name + ": " + value).c_str());
  if (next == nullptr) {
    throw SdkException("allocation_error", "out of memory");
  }
  headers = next;
}

curl_slist *build_headers(const std::string &api_key, const std::vector<HttpHeader> &headers) {
  curl_slist *request_headers = nullptr;
  try {
    append_header(request_headers, "content-type", "application/json");
    append_header(request_headers, "authorization", "Bearer " + api_key);
    for (const auto &header : headers) {
      append_header(request_headers, header.name, header.value);
    }
  } catch (...) {
    curl_slist_free_all(request_headers);
    throw;
  }
  return request_headers;
}

} // namespace

HttpTransport::HttpTransport(std::string endpoint, std::vector<HttpHeader> headers, long timeout_ms)
    : endpoint_(resolved_endpoint(endpoint)), headers_(std::move(headers)), timeout_ms_(timeout_ms) {
  validate_endpoint(endpoint_);
  if (timeout_ms_ <= 0L) {
    throw SdkException("configuration_error", "HTTP transport timeout_ms must be positive");
  }
  for (const auto &header : headers_) {
    validate_header(header);
  }
}

TransportResponse HttpTransport::send(const std::string &api_key, const std::string &body) {
  if (is_blank_http(api_key)) {
    throw SdkException("validation_error", "api_key must be non-empty");
  }
  if (curl_global_init(CURL_GLOBAL_DEFAULT) != 0) {
    throw TransportError("network_failure", "curl global initialization failed", true);
  }
  CURL *curl = curl_easy_init();
  if (curl == nullptr) {
    throw TransportError("network_failure", "curl initialization failed", true);
  }
  curl_slist *request_headers = nullptr;
  try {
    request_headers = build_headers(api_key, headers_);
    curl_easy_setopt(curl, CURLOPT_URL, endpoint_.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, request_headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(body.size()));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeout_ms_);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, timeout_ms_);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discard_response_body);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    const CURLcode curl_status = curl_easy_perform(curl);
    if (curl_status != CURLE_OK) {
      throw TransportError("network_failure", curl_easy_strerror(curl_status), true);
    }
    long response_code = 0L;
    if (curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response_code) != CURLE_OK || response_code <= 0L) {
      throw TransportError("network_failure", "HTTP transport did not receive a response status", true);
    }
    curl_slist_free_all(request_headers);
    curl_easy_cleanup(curl);
    return TransportResponse{static_cast<int>(response_code), 1U};
  } catch (...) {
    curl_slist_free_all(request_headers);
    curl_easy_cleanup(curl);
    throw;
  }
}

} // namespace logbrew
