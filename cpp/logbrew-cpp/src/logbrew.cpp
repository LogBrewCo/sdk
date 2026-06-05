#include "logbrew.hpp"

#include <algorithm>
#include <iomanip>
#include <sstream>

namespace logbrew {
namespace {

[[nodiscard]] bool is_blank(const std::string &value) {
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return std::isspace(character) != 0;
  });
}

void require_non_empty(const std::string &label, const std::string &value) {
  if (is_blank(value)) {
    throw SdkException("validation_error", label + " must be non-empty");
  }
}

void require_timestamp(const std::string &timestamp) {
  require_non_empty("timestamp", timestamp);
  const auto separator = timestamp.find('T');
  if (separator == std::string::npos) {
    throw SdkException("validation_error", "timestamp must include a time separator");
  }
  const auto time_part = timestamp.substr(separator + 1U);
  if (!timestamp.empty() && timestamp.back() == 'Z') {
    return;
  }
  if (time_part.find('+') != std::string::npos || time_part.find('-') != std::string::npos) {
    return;
  }
  throw SdkException("validation_error", "timestamp must include a timezone offset");
}

void require_allowed(const std::string &label, const std::string &value, const std::vector<std::string> &allowed) {
  require_non_empty(label, value);
  if (std::find(allowed.begin(), allowed.end(), value) != allowed.end()) {
    return;
  }
  throw SdkException("validation_error", label + " has unsupported value: " + value);
}

[[nodiscard]] std::string json_string(const std::string &value) {
  std::ostringstream output;
  output << '"';
  for (const unsigned char character : value) {
    switch (character) {
      case '"':
        output << "\\\"";
        break;
      case '\\':
        output << "\\\\";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (character < 0x20U) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(character)
                 << std::dec << std::setfill(' ');
        } else {
          output << static_cast<char>(character);
        }
        break;
    }
  }
  output << '"';
  return output.str();
}

void append_field(std::ostringstream &output, bool &needs_comma, const std::string &key, const std::string &value) {
  if (needs_comma) {
    output << ',';
  }
  output << json_string(key) << ':' << json_string(value);
  needs_comma = true;
}

void append_optional_field(
    std::ostringstream &output,
    bool &needs_comma,
    const std::string &key,
    const std::optional<std::string> &value,
    bool require_present_value) {
  if (!value.has_value()) {
    return;
  }
  if (require_present_value) {
    require_non_empty(key, *value);
  }
  append_field(output, needs_comma, key, *value);
}

[[nodiscard]] std::string object_json(const std::function<void(std::ostringstream &, bool &)> &write_fields) {
  std::ostringstream output;
  bool needs_comma = false;
  output << '{';
  write_fields(output, needs_comma);
  output << '}';
  return output.str();
}

[[nodiscard]] std::string double_json(double value) {
  std::ostringstream output;
  output << std::setprecision(15) << value;
  return output.str();
}

} // namespace

SdkException::SdkException(std::string code, std::string message)
    : std::runtime_error(std::move(message)), code_(std::move(code)) {}

const std::string &SdkException::code() const noexcept {
  return code_;
}

TransportError::TransportError(std::string code, std::string message, bool retryable)
    : std::runtime_error(std::move(message)), code_(std::move(code)), retryable_(retryable) {}

const std::string &TransportError::code() const noexcept {
  return code_;
}

bool TransportError::retryable() const noexcept {
  return retryable_;
}

RecordingTransport::Step RecordingTransport::Step::status_code_step(int status_code) {
  return Step{Kind::status, status_code, {}, {}, false};
}

RecordingTransport::Step RecordingTransport::Step::network_failure(std::string message) {
  return Step{Kind::error, 0, "network_failure", std::move(message), true};
}

RecordingTransport::RecordingTransport(std::vector<Step> steps) : steps_(std::move(steps)) {}

TransportResponse RecordingTransport::send(const std::string &api_key, const std::string &body) {
  require_non_empty("api_key", api_key);
  sent_bodies_.push_back(body);
  Step step = Step::status_code_step(202);
  if (cursor_ < steps_.size()) {
    step = steps_[cursor_];
    cursor_++;
  }
  if (step.kind == Step::Kind::error) {
    throw TransportError(
        step.code.empty() ? "transport_error" : step.code,
        step.message.empty() ? "transport failed" : step.message,
        step.retryable);
  }
  return TransportResponse{step.status_code, 1};
}

const std::vector<std::string> &RecordingTransport::sent_bodies() const noexcept {
  return sent_bodies_;
}

const std::string *RecordingTransport::last_body() const noexcept {
  if (sent_bodies_.empty()) {
    return nullptr;
  }
  return &sent_bodies_.back();
}

LogBrewClient::LogBrewClient(Config config)
    : api_key_(std::move(config.api_key)),
      sdk_name_(std::move(config.sdk_name)),
      sdk_version_(std::move(config.sdk_version)),
      max_retries_(config.max_retries == 0U ? 2U : config.max_retries) {
  require_non_empty("api_key", api_key_);
  require_non_empty("sdk_name", sdk_name_);
  require_non_empty("sdk_version", sdk_version_);
}

std::size_t LogBrewClient::pending_events() const noexcept {
  return events_.size();
}

std::string LogBrewClient::preview_json() const {
  std::ostringstream output;
  output << "{\"sdk\":{\"name\":" << json_string(sdk_name_) << ",\"language\":\"cpp\",\"version\":"
         << json_string(sdk_version_) << "},\"events\":[";
  for (std::size_t index = 0; index < events_.size(); index++) {
    if (index > 0U) {
      output << ',';
    }
    output << event_json(events_[index]);
  }
  output << "]}";
  return output.str();
}

TransportResponse LogBrewClient::flush(Transport &transport) {
  if (closed_) {
    throw SdkException("shutdown_error", "client is already shut down");
  }
  return flush_internal(transport);
}

TransportResponse LogBrewClient::shutdown(Transport &transport) {
  if (closed_) {
    throw SdkException("shutdown_error", "client is already shut down");
  }
  TransportResponse response = flush_internal(transport);
  closed_ = true;
  return response;
}

void LogBrewClient::release(std::string id, std::string timestamp, ReleaseAttributes attributes) {
  require_non_empty("release version", attributes.version);
  push_event("release", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "version", attributes.version);
               append_optional_field(output, needs_comma, "commit", attributes.commit, true);
               append_optional_field(output, needs_comma, "notes", attributes.notes, false);
             }));
}

void LogBrewClient::environment(std::string id, std::string timestamp, EnvironmentAttributes attributes) {
  require_non_empty("environment name", attributes.name);
  push_event("environment", std::move(id), std::move(timestamp),
             object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "name", attributes.name);
               append_optional_field(output, needs_comma, "region", attributes.region, false);
             }));
}

void LogBrewClient::issue(std::string id, std::string timestamp, IssueAttributes attributes) {
  require_non_empty("issue title", attributes.title);
  require_allowed("issue level", attributes.level, {"info", "warning", "error", "critical"});
  push_event("issue", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "title", attributes.title);
               append_field(output, needs_comma, "level", attributes.level);
               append_optional_field(output, needs_comma, "message", attributes.message, false);
             }));
}

void LogBrewClient::log(std::string id, std::string timestamp, LogAttributes attributes) {
  require_non_empty("log message", attributes.message);
  require_allowed("log level", attributes.level, {"debug", "info", "warning", "error"});
  push_event("log", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "message", attributes.message);
               append_field(output, needs_comma, "level", attributes.level);
               append_optional_field(output, needs_comma, "logger", attributes.logger, false);
             }));
}

void LogBrewClient::span(std::string id, std::string timestamp, SpanAttributes attributes) {
  require_non_empty("span name", attributes.name);
  require_non_empty("span trace_id", attributes.trace_id);
  require_non_empty("span span_id", attributes.span_id);
  require_allowed("span status", attributes.status, {"ok", "error"});
  if (attributes.duration_ms.has_value() && *attributes.duration_ms < 0.0) {
    throw SdkException("validation_error", "span duration_ms must be non-negative");
  }
  push_event("span", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "name", attributes.name);
               append_field(output, needs_comma, "traceId", attributes.trace_id);
               append_field(output, needs_comma, "spanId", attributes.span_id);
               append_optional_field(output, needs_comma, "parentSpanId", attributes.parent_span_id, true);
               append_field(output, needs_comma, "status", attributes.status);
               if (attributes.duration_ms.has_value()) {
                 if (needs_comma) {
                   output << ',';
                 }
                 output << "\"durationMs\":" << double_json(*attributes.duration_ms);
                 needs_comma = true;
               }
             }));
}

void LogBrewClient::action(std::string id, std::string timestamp, ActionAttributes attributes) {
  require_non_empty("action name", attributes.name);
  require_allowed("action status", attributes.status, {"queued", "running", "success", "failure"});
  push_event("action", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "name", attributes.name);
               append_field(output, needs_comma, "status", attributes.status);
             }));
}

std::string LogBrewClient::event_json(const Event &event) {
  std::ostringstream output;
  output << "{\"type\":" << json_string(event.type) << ",\"timestamp\":" << json_string(event.timestamp)
         << ",\"id\":" << json_string(event.id) << ",\"attributes\":" << event.attributes_json << '}';
  return output.str();
}

void LogBrewClient::push_event(std::string type, std::string id, std::string timestamp, std::string attributes_json) {
  if (closed_) {
    throw SdkException("shutdown_error", "client is already shut down");
  }
  require_non_empty("id", id);
  require_timestamp(timestamp);
  events_.push_back(Event{std::move(type), std::move(timestamp), std::move(id), std::move(attributes_json)});
}

TransportResponse LogBrewClient::flush_internal(Transport &transport) {
  if (events_.empty()) {
    return TransportResponse{204, 0};
  }
  const std::string body = preview_json();
  const std::size_t max_attempts = max_retries_ + 1U;
  for (std::size_t attempt = 1; attempt <= max_attempts; attempt++) {
    try {
      TransportResponse response = transport.send(api_key_, body);
      response.attempts = attempt;
      if (response.status_code == 401) {
        throw SdkException("unauthenticated", "transport rejected the API key");
      }
      if (response.status_code >= 200 && response.status_code < 300) {
        events_.clear();
        return response;
      }
      if (response.status_code >= 500 && attempt < max_attempts) {
        continue;
      }
      throw SdkException("transport_error", "unexpected transport status");
    } catch (const TransportError &error) {
      if (error.retryable() && attempt < max_attempts) {
        continue;
      }
      throw SdkException(error.code(), error.what());
    }
  }
  throw SdkException("transport_error", "exhausted retry budget");
}

} // namespace logbrew
