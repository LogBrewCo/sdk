#include "logbrew.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <functional>
#include <iomanip>
#include <random>
#include <sstream>

namespace logbrew {
namespace {

thread_local const TraceContext *active_trace_context = nullptr;

[[nodiscard]] bool is_blank(const std::string &value) {
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return std::isspace(character) != 0;
  });
}

[[nodiscard]] bool is_hex_character(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F');
}

[[nodiscard]] int hex_value(char value) {
  if (value >= '0' && value <= '9') {
    return value - '0';
  }
  return static_cast<int>(std::tolower(static_cast<unsigned char>(value)) - 'a') + 10;
}

[[nodiscard]] std::string lower_hex(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

[[nodiscard]] bool valid_non_zero_hex(const std::string &value, std::size_t length) {
  bool any_non_zero = false;
  if (value.size() != length) {
    return false;
  }
  for (const char character : value) {
    if (!is_hex_character(character)) {
      return false;
    }
    if (character != '0') {
      any_non_zero = true;
    }
  }
  return any_non_zero;
}

void require_valid_trace_context(const TraceContext &context) {
  if (!valid_non_zero_hex(context.trace_id, trace_id_length)) {
    throw SdkException("validation_error", "trace context trace_id is invalid");
  }
  if (!valid_non_zero_hex(context.span_id, span_id_length)) {
    throw SdkException("validation_error", "trace context span_id is invalid");
  }
  if (context.parent_span_id.has_value() && !valid_non_zero_hex(*context.parent_span_id, span_id_length)) {
    throw SdkException("validation_error", "trace context parent_span_id is invalid");
  }
  if (context.trace_flags.size() != trace_flags_length ||
      !std::all_of(context.trace_flags.begin(), context.trace_flags.end(), is_hex_character)) {
    throw SdkException("validation_error", "trace context trace_flags are invalid");
  }
}

[[nodiscard]] std::string generated_hex(std::size_t length) {
  static constexpr char hex[] = "0123456789abcdef";
  static thread_local std::mt19937_64 generator{std::random_device{}()};
  std::uniform_int_distribution<int> distribution(0, 15);
  std::string value;
  bool any_non_zero = false;
  value.reserve(length);
  for (std::size_t index = 0; index < length; index++) {
    const int nibble = distribution(generator);
    value.push_back(hex[nibble]);
    any_non_zero = any_non_zero || nibble != 0;
  }
  if (!any_non_zero && !value.empty()) {
    value.back() = '1';
  }
  return value;
}

[[nodiscard]] std::string trim_copy(const std::string &value) {
  const auto begin = std::find_if_not(value.begin(), value.end(), [](unsigned char character) {
    return std::isspace(character) != 0;
  });
  if (begin == value.end()) {
    return {};
  }
  const auto end = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char character) {
                     return std::isspace(character) != 0;
                   }).base();
  return std::string(begin, end);
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

std::string normalize_severity(const std::string &label, const std::string &value) {
  require_allowed(label, value, {"trace", "debug", "info", "warn", "warning", "error", "fatal", "critical"});
  if (value == "trace" || value == "debug" || value == "info") {
    return "info";
  }
  if (value == "warn" || value == "warning") {
    return "warning";
  }
  if (value == "error") {
    return "error";
  }
  return "critical";
}

void require_finite(const std::string &label, double value) {
  if (!std::isfinite(value)) {
    throw SdkException("validation_error", label + " must be finite");
  }
}

[[nodiscard]] std::string normalized_method(const std::string &method) {
  std::string normalized = trim_copy(method);
  require_non_empty("network method", normalized);
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return normalized;
}

[[nodiscard]] bool starts_with(const std::string &value, const std::string &prefix) {
  return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

[[nodiscard]] std::string strip_query_and_fragment(std::string route) {
  const auto query = route.find('?');
  const auto fragment = route.find('#');
  const auto first_sensitive_offset = std::min(
      query == std::string::npos ? route.size() : query,
      fragment == std::string::npos ? route.size() : fragment);
  route.erase(first_sensitive_offset);
  return route;
}

[[nodiscard]] std::string sanitized_route_template(const std::string &route_template) {
  std::string route = trim_copy(route_template);
  require_non_empty("network route_template", route);
  if (starts_with(route, "http://") || starts_with(route, "https://")) {
    const auto authority_start = route.find("://") + 3U;
    const auto path_start = route.find_first_of("/?#", authority_start);
    if (path_start == std::string::npos) {
      route = "/";
    } else if (route[path_start] == '/') {
      route = route.substr(path_start);
    } else {
      route = "/";
    }
  } else if (route.find("://") != std::string::npos) {
    throw SdkException("validation_error", "network route_template must be an HTTP path or URL");
  }
  route = strip_query_and_fragment(route);
  require_non_empty("network route_template", route);
  return route;
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
  require_finite("number", value);
  std::ostringstream output;
  output << std::setprecision(15) << value;
  return output.str();
}

void append_number_field(std::ostringstream &output, bool &needs_comma, const std::string &key, double value) {
  if (needs_comma) {
    output << ',';
  }
  output << json_string(key) << ':' << double_json(value);
  needs_comma = true;
}

[[nodiscard]] std::string metadata_value_json(const MetadataValue &value) {
  switch (value.kind()) {
    case MetadataValue::Kind::null_value:
      return "null";
    case MetadataValue::Kind::boolean:
      return value.bool_value() ? "true" : "false";
    case MetadataValue::Kind::number:
      return double_json(value.number_value());
    case MetadataValue::Kind::string:
      return json_string(value.string_value());
  }
  return "null";
}

void append_metadata_field(
    std::ostringstream &output,
    bool &needs_comma,
    const std::string &key,
    const MetadataValue &value) {
  require_non_empty("metadata key", key);
  if (value.kind() == MetadataValue::Kind::number) {
    require_finite("metadata value", value.number_value());
  }
  if (needs_comma) {
    output << ',';
  }
  output << json_string(key) << ':' << metadata_value_json(value);
  needs_comma = true;
}

void append_metadata_object(std::ostringstream &output, bool &needs_comma, const Metadata &metadata) {
  if (metadata.empty()) {
    return;
  }
  if (needs_comma) {
    output << ',';
  }
  bool metadata_needs_comma = false;
  output << "\"metadata\":{";
  for (const auto &entry : metadata) {
    append_metadata_field(output, metadata_needs_comma, entry.first, entry.second);
  }
  output << '}';
  needs_comma = true;
}

[[nodiscard]] Metadata merge_active_trace_metadata(Metadata metadata) {
  Metadata trace = trace_metadata();
  for (const auto &entry : trace) {
    metadata[entry.first] = entry.second;
  }
  return metadata;
}

[[nodiscard]] Metadata timeline_metadata(
    const std::string &source,
    const ProductTimelineContext &context,
    const Metadata &metadata) {
  Metadata merged = context.metadata;
  for (const auto &entry : metadata) {
    merged[entry.first] = entry.second;
  }
  if (context.session_id.has_value()) {
    require_non_empty("session_id", *context.session_id);
    merged["sessionId"] = *context.session_id;
  }
  if (context.screen.has_value()) {
    require_non_empty("screen", *context.screen);
    merged["screen"] = *context.screen;
  }
  if (context.trace_id.has_value()) {
    require_non_empty("trace_id", *context.trace_id);
    merged["traceId"] = *context.trace_id;
  }
  if (context.funnel.has_value()) {
    require_non_empty("funnel", *context.funnel);
    merged["funnel"] = *context.funnel;
  }
  if (context.step.has_value()) {
    require_non_empty("step", *context.step);
    merged["step"] = *context.step;
  }
  merged["source"] = source;
  return merged;
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

MetadataValue::MetadataValue() = default;

MetadataValue::MetadataValue(std::nullptr_t) : kind_(Kind::null_value) {}

MetadataValue::MetadataValue(bool value) : kind_(Kind::boolean), bool_value_(value) {}

MetadataValue::MetadataValue(int value) : MetadataValue(static_cast<long long>(value)) {}

MetadataValue::MetadataValue(long value) : MetadataValue(static_cast<long long>(value)) {}

MetadataValue::MetadataValue(long long value) : kind_(Kind::number), number_value_(static_cast<double>(value)) {}

MetadataValue::MetadataValue(unsigned int value) : MetadataValue(static_cast<unsigned long long>(value)) {}

MetadataValue::MetadataValue(unsigned long value) : MetadataValue(static_cast<unsigned long long>(value)) {}

MetadataValue::MetadataValue(unsigned long long value)
    : kind_(Kind::number), number_value_(static_cast<double>(value)) {}

MetadataValue::MetadataValue(double value) : kind_(Kind::number), number_value_(value) {}

MetadataValue::MetadataValue(const char *value) : MetadataValue(std::string(value == nullptr ? "" : value)) {}

MetadataValue::MetadataValue(std::string value) : kind_(Kind::string), string_value_(std::move(value)) {}

MetadataValue::Kind MetadataValue::kind() const noexcept {
  return kind_;
}

bool MetadataValue::bool_value() const noexcept {
  return bool_value_;
}

double MetadataValue::number_value() const noexcept {
  return number_value_;
}

const std::string &MetadataValue::string_value() const noexcept {
  return string_value_;
}

TraceContext create_trace_context(std::string trace_flags) {
  trace_flags = lower_hex(trim_copy(trace_flags));
  if (trace_flags.size() != trace_flags_length ||
      !std::all_of(trace_flags.begin(), trace_flags.end(), is_hex_character)) {
    throw SdkException("validation_error", "trace flags must be two hex characters");
  }
  return TraceContext{
      generated_hex(trace_id_length),
      generated_hex(span_id_length),
      std::nullopt,
      trace_flags,
      (hex_value(trace_flags.back()) & 0x01) == 0x01,
  };
}

TraceContext trace_context_from_traceparent(const std::string &traceparent) {
  const std::string value = trim_copy(traceparent);
  if (value.size() != traceparent_length || value[2] != '-' || value[35] != '-' || value[52] != '-') {
    throw SdkException("validation_error", "traceparent must use W3C version-traceid-spanid-flags shape");
  }
  const std::string version = lower_hex(value.substr(0, 2));
  const std::string trace_id = lower_hex(value.substr(3, trace_id_length));
  const std::string parent_span_id = lower_hex(value.substr(36, span_id_length));
  const std::string trace_flags = lower_hex(value.substr(53, trace_flags_length));
  if (version == "ff" || !std::all_of(version.begin(), version.end(), is_hex_character)) {
    throw SdkException("validation_error", "traceparent version is invalid");
  }
  if (!valid_non_zero_hex(trace_id, trace_id_length)) {
    throw SdkException("validation_error", "traceparent trace id is invalid");
  }
  if (!valid_non_zero_hex(parent_span_id, span_id_length)) {
    throw SdkException("validation_error", "traceparent span id is invalid");
  }
  if (!std::all_of(trace_flags.begin(), trace_flags.end(), is_hex_character)) {
    throw SdkException("validation_error", "traceparent trace flags are invalid");
  }
  return TraceContext{
      trace_id,
      generated_hex(span_id_length),
      parent_span_id,
      trace_flags,
      (hex_value(trace_flags.back()) & 0x01) == 0x01,
  };
}

TraceContext continue_or_create_trace_context(const std::string &traceparent) {
  if (!is_blank(traceparent)) {
    try {
      return trace_context_from_traceparent(traceparent);
    } catch (const SdkException &) {
      return create_trace_context();
    }
  }
  return create_trace_context();
}

const TraceContext *current_trace_context() noexcept {
  return active_trace_context;
}

TraceScope::TraceScope(TraceContext context)
    : context_(std::move(context)), previous_(active_trace_context) {
  require_valid_trace_context(context_);
  active_trace_context = &context_;
}

TraceScope::~TraceScope() {
  active_trace_context = previous_;
}

const TraceContext &TraceScope::context() const noexcept {
  return context_;
}

Metadata trace_metadata(const TraceContext *context) {
  if (context == nullptr) {
    context = active_trace_context;
  }
  if (context == nullptr || is_blank(context->trace_id) || is_blank(context->span_id)) {
    return {};
  }
  require_valid_trace_context(*context);
  Metadata metadata{
      {"traceId", context->trace_id},
      {"spanId", context->span_id},
      {"sampled", context->sampled},
      {"traceFlags", context->trace_flags},
  };
  if (context->parent_span_id.has_value()) {
    metadata["parentSpanId"] = *context->parent_span_id;
  }
  return metadata;
}

ProductTimelineContext trace_product_timeline_context(ProductTimelineContext context, const TraceContext *trace) {
  if (trace == nullptr) {
    trace = active_trace_context;
  }
  if (trace != nullptr && !is_blank(trace->trace_id)) {
    require_valid_trace_context(*trace);
    context.trace_id = trace->trace_id;
  }
  return context;
}

SpanAttributes trace_span_attributes(
    std::string name,
    std::string status,
    std::optional<double> duration_ms,
    const TraceContext *context) {
  if (context == nullptr) {
    context = active_trace_context;
  }
  if (context == nullptr || is_blank(context->trace_id) || is_blank(context->span_id)) {
    throw SdkException("validation_error", "trace context is required");
  }
  require_valid_trace_context(*context);
  return SpanAttributes{
      std::move(name),
      context->trace_id,
      context->span_id,
      context->parent_span_id,
      std::move(status),
      duration_ms,
  };
}

std::map<std::string, std::string> traceparent_headers(const TraceContext *context) {
  if (context == nullptr) {
    context = active_trace_context;
  }
  if (context == nullptr || is_blank(context->trace_id) || is_blank(context->span_id) ||
      is_blank(context->trace_flags)) {
    throw SdkException("validation_error", "trace context is required");
  }
  require_valid_trace_context(*context);
  return {{"traceparent", "00-" + context->trace_id + "-" + context->span_id + "-" + context->trace_flags}};
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
  std::string level = normalize_severity("issue level", attributes.level);
  push_event("issue", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "title", attributes.title);
               append_field(output, needs_comma, "level", level);
               append_optional_field(output, needs_comma, "message", attributes.message, false);
               append_metadata_object(output, needs_comma, trace_metadata());
             }));
}

void LogBrewClient::log(std::string id, std::string timestamp, LogAttributes attributes) {
  require_non_empty("log message", attributes.message);
  std::string level = normalize_severity("log level", attributes.level);
  push_event("log", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "message", attributes.message);
               append_field(output, needs_comma, "level", level);
               append_optional_field(output, needs_comma, "logger", attributes.logger, false);
               append_metadata_object(output, needs_comma, trace_metadata());
             }));
}

void LogBrewClient::span(std::string id, std::string timestamp, SpanAttributes attributes) {
  require_non_empty("span name", attributes.name);
  require_non_empty("span trace_id", attributes.trace_id);
  require_non_empty("span span_id", attributes.span_id);
  require_allowed("span status", attributes.status, {"ok", "error"});
  if (attributes.duration_ms.has_value()) {
    require_finite("span duration_ms", *attributes.duration_ms);
  }
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
                 append_number_field(output, needs_comma, "durationMs", *attributes.duration_ms);
               }
             }));
}

void LogBrewClient::metric(std::string id, std::string timestamp, MetricAttributes attributes) {
  require_non_empty("metric name", attributes.name);
  require_allowed("metric kind", attributes.kind, {"counter", "gauge", "histogram"});
  require_finite("metric value", attributes.value);
  require_non_empty("metric unit", attributes.unit);
  if (attributes.kind == "gauge") {
    require_allowed("metric temporality", attributes.temporality, {"instant"});
  } else {
    require_allowed("metric temporality", attributes.temporality, {"delta", "cumulative"});
    if (attributes.value < 0.0) {
      throw SdkException("validation_error", "metric value must be non-negative for counter and histogram");
    }
  }
  push_event("metric", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "name", attributes.name);
               append_field(output, needs_comma, "kind", attributes.kind);
               append_number_field(output, needs_comma, "value", attributes.value);
               append_field(output, needs_comma, "unit", attributes.unit);
               append_field(output, needs_comma, "temporality", attributes.temporality);
               append_metadata_object(output, needs_comma, merge_active_trace_metadata(std::move(attributes.metadata)));
             }));
}

void LogBrewClient::action(std::string id, std::string timestamp, ActionAttributes attributes) {
  require_non_empty("action name", attributes.name);
  require_allowed("action status", attributes.status, {"queued", "running", "success", "failure"});
  push_event("action", std::move(id), std::move(timestamp), object_json([&](std::ostringstream &output, bool &needs_comma) {
               append_field(output, needs_comma, "name", attributes.name);
               append_field(output, needs_comma, "status", attributes.status);
               append_metadata_object(output, needs_comma, merge_active_trace_metadata(std::move(attributes.metadata)));
             }));
}

void LogBrewClient::capture_product_action(
    std::string id,
    std::string timestamp,
    ProductActionAttributes attributes) {
  require_non_empty("product action name", attributes.name);
  action(
      std::move(id),
      std::move(timestamp),
      ActionAttributes{
          attributes.name,
          attributes.status.value_or("success"),
          timeline_metadata("cpp.product_action", attributes.context, attributes.metadata),
      });
}

void LogBrewClient::capture_network_milestone(
    std::string id,
    std::string timestamp,
    NetworkMilestoneAttributes attributes) {
  const std::string method = normalized_method(attributes.method);
  const std::string route_template = sanitized_route_template(attributes.route_template);
  Metadata metadata = attributes.metadata;
  metadata["method"] = method;
  metadata["routeTemplate"] = route_template;
  if (attributes.status_code.has_value()) {
    if (*attributes.status_code < 100 || *attributes.status_code > 599) {
      throw SdkException("validation_error", "network status_code must be between 100 and 599");
    }
    metadata["statusCode"] = *attributes.status_code;
  }
  if (attributes.duration_ms.has_value()) {
    require_finite("network duration_ms", *attributes.duration_ms);
    if (*attributes.duration_ms < 0.0) {
      throw SdkException("validation_error", "network duration_ms must be non-negative");
    }
    metadata["durationMs"] = *attributes.duration_ms;
  }
  const std::string status = attributes.status.value_or(
      attributes.status_code.has_value() && *attributes.status_code >= 400 ? "failure" : "success");
  action(
      std::move(id),
      std::move(timestamp),
      ActionAttributes{
          method + " " + route_template,
          status,
          timeline_metadata("cpp.network", attributes.context, metadata),
      });
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
