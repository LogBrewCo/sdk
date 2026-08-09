#include "logbrew.hpp"

#include <algorithm>
#include <cctype>
#include <climits>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iomanip>
#include <memory>
#include <random>
#include <sstream>

namespace logbrew {
namespace {

thread_local std::shared_ptr<detail::ScopeState<TraceContext>> active_trace_scope;
thread_local std::shared_ptr<detail::ScopeState<TelemetryContext>> active_telemetry_scope;

constexpr std::size_t max_product_analytics_surface_length = 256U;
constexpr std::size_t max_context_string_length = 256U;
constexpr std::size_t max_context_id_length = 200U;
constexpr std::size_t max_tag_key_length = 64U;
constexpr std::size_t max_tag_value_length = 256U;

[[nodiscard]] bool is_blank(const std::string &value) {
  return std::all_of(value.begin(), value.end(), [](unsigned char character) { return std::isspace(character) != 0; });
}

[[nodiscard]] bool is_hex_character(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F');
}

[[nodiscard]] bool is_ascii_alpha(unsigned char value) {
  return (value >= static_cast<unsigned char>('A') && value <= static_cast<unsigned char>('Z')) ||
         (value >= static_cast<unsigned char>('a') && value <= static_cast<unsigned char>('z'));
}

[[nodiscard]] bool is_ascii_digit(unsigned char value) {
  return value >= static_cast<unsigned char>('0') && value <= static_cast<unsigned char>('9');
}

[[nodiscard]] int hex_value(char value) {
  if (value >= '0' && value <= '9') {
    return value - '0';
  }
  return static_cast<int>(std::tolower(static_cast<unsigned char>(value)) - 'a') + 10;
}

[[nodiscard]] std::string lower_hex(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
  return value;
}

[[nodiscard]] std::string trim_copy(const std::string &value);

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

[[nodiscard]] std::string require_valid_hex_id(const std::string &label, std::string value, std::size_t length) {
  value = lower_hex(trim_copy(value));
  if (!valid_non_zero_hex(value, length)) {
    throw SdkException("validation_error", label + " is invalid");
  }
  return value;
}

[[nodiscard]] std::string require_valid_trace_flags(const std::string &label, std::string value) {
  value = lower_hex(trim_copy(value));
  if (value.size() != trace_flags_length || !std::all_of(value.begin(), value.end(), is_hex_character)) {
    throw SdkException("validation_error", label + " are invalid");
  }
  return value;
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
  if (context.sampled != ((hex_value(context.trace_flags.back()) & 0x01) == 0x01)) {
    throw SdkException("validation_error", "trace context sampled state must match trace_flags");
  }
}

[[nodiscard]] TraceContext normalized_trace_context(TraceContext context) {
  context.trace_id = require_valid_hex_id("trace context trace_id", std::move(context.trace_id), trace_id_length);
  context.span_id = require_valid_hex_id("trace context span_id", std::move(context.span_id), span_id_length);
  if (context.parent_span_id.has_value()) {
    context.parent_span_id =
        require_valid_hex_id("trace context parent_span_id", std::move(*context.parent_span_id), span_id_length);
  }
  context.trace_flags = require_valid_trace_flags("trace context trace_flags", std::move(context.trace_flags));
  require_valid_trace_context(context);
  return context;
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
  const auto begin = std::find_if_not(value.begin(), value.end(),
                                      [](unsigned char character) { return std::isspace(character) != 0; });
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

[[nodiscard]] bool has_forbidden_control(const std::string &value) {
  return std::any_of(value.begin(), value.end(), [](unsigned char character) {
    return character <= 0x1FU || (character >= 0x7FU && character <= 0x9FU);
  });
}

void require_bounded_text(const std::string &label, const std::string &value, std::size_t maximum_length,
                          bool forbid_query_fragment = false) {
  require_non_empty(label, value);
  if (value.size() > maximum_length || has_forbidden_control(value) ||
      (forbid_query_fragment && value.find_first_of("?#") != std::string::npos)) {
    throw SdkException("validation_error", label + " is invalid");
  }
}

[[nodiscard]] std::string normalized_metric_description(std::string value) {
  value = trim_copy(value);
  if (value.empty()) {
    throw SdkException("validation_error", "metric description must be non-empty");
  }

  std::size_t scalar_count = 0U;
  for (std::size_t index = 0U; index < value.size();) {
    const auto first = static_cast<unsigned char>(value[index]);
    std::uint32_t scalar = 0U;
    std::size_t width = 0U;
    if (first <= 0x7FU) {
      scalar = first;
      width = 1U;
    } else if (first >= 0xC2U && first <= 0xDFU && index + 1U < value.size()) {
      const auto second = static_cast<unsigned char>(value[index + 1U]);
      if ((second & 0xC0U) != 0x80U) {
        throw SdkException("validation_error", "metric description contains invalid UTF-8");
      }
      scalar = (static_cast<std::uint32_t>(first & 0x1FU) << 6U) | static_cast<std::uint32_t>(second & 0x3FU);
      width = 2U;
    } else if (first >= 0xE0U && first <= 0xEFU && index + 2U < value.size()) {
      const auto second = static_cast<unsigned char>(value[index + 1U]);
      const auto third = static_cast<unsigned char>(value[index + 2U]);
      const bool valid_second = (second & 0xC0U) == 0x80U && !(first == 0xE0U && second < 0xA0U) &&
                                !(first == 0xEDU && second >= 0xA0U);
      if (!valid_second || (third & 0xC0U) != 0x80U) {
        throw SdkException("validation_error", "metric description contains invalid UTF-8");
      }
      scalar = (static_cast<std::uint32_t>(first & 0x0FU) << 12U) |
               (static_cast<std::uint32_t>(second & 0x3FU) << 6U) | static_cast<std::uint32_t>(third & 0x3FU);
      width = 3U;
    } else if (first >= 0xF0U && first <= 0xF4U && index + 3U < value.size()) {
      const auto second = static_cast<unsigned char>(value[index + 1U]);
      const auto third = static_cast<unsigned char>(value[index + 2U]);
      const auto fourth = static_cast<unsigned char>(value[index + 3U]);
      const bool valid_second = (second & 0xC0U) == 0x80U && !(first == 0xF0U && second < 0x90U) &&
                                !(first == 0xF4U && second >= 0x90U);
      if (!valid_second || (third & 0xC0U) != 0x80U || (fourth & 0xC0U) != 0x80U) {
        throw SdkException("validation_error", "metric description contains invalid UTF-8");
      }
      scalar = (static_cast<std::uint32_t>(first & 0x07U) << 18U) |
               (static_cast<std::uint32_t>(second & 0x3FU) << 12U) |
               (static_cast<std::uint32_t>(third & 0x3FU) << 6U) | static_cast<std::uint32_t>(fourth & 0x3FU);
      width = 4U;
    } else {
      throw SdkException("validation_error", "metric description contains invalid UTF-8");
    }

    if (scalar <= 0x1FU || (scalar >= 0x7FU && scalar <= 0x9FU) || scalar == 0x2028U || scalar == 0x2029U) {
      throw SdkException("validation_error", "metric description contains forbidden control characters");
    }
    scalar_count += 1U;
    if (scalar_count > max_metric_description_length) {
      throw SdkException("validation_error", "metric description is too long");
    }
    index += width;
  }
  return value;
}

[[nodiscard]] bool is_machine_key(const std::string &value, std::size_t maximum_length,
                                  const std::string &extra_characters) {
  if (value.empty() || value.size() > maximum_length || !is_ascii_alpha(static_cast<unsigned char>(value.front()))) {
    return false;
  }
  return std::all_of(value.begin() + 1, value.end(), [&](unsigned char character) {
    return is_ascii_alpha(character) || is_ascii_digit(character) ||
           extra_characters.find(static_cast<char>(character)) != std::string::npos;
  });
}

[[nodiscard]] bool is_absolute_path(const std::string &value) {
  if (value.empty()) {
    return false;
  }
  if (value.front() == '/' || value.front() == '\\') {
    return true;
  }
  return value.size() >= 3U && is_ascii_alpha(static_cast<unsigned char>(value[0])) && value[1] == ':' &&
         (value[2] == '/' || value[2] == '\\');
}

[[nodiscard]] bool is_uuid(const std::string &value) {
  if (value.size() != 36U) {
    return false;
  }
  for (std::size_t index = 0U; index < value.size(); index++) {
    if (index == 8U || index == 13U || index == 18U || index == 23U) {
      if (value[index] != '-') {
        return false;
      }
    } else if (!is_hex_character(value[index])) {
      return false;
    }
  }
  return true;
}

void validate_metadata(const Metadata &metadata, const std::string &label = "metadata",
                       std::size_t maximum_entries = max_metadata_entries, bool strict_machine_keys = false,
                       std::size_t maximum_string_length = max_metadata_string_length) {
  if (metadata.size() > maximum_entries) {
    throw SdkException("validation_error", label + " contains too many entries");
  }
  for (const auto &entry : metadata) {
    if (entry.first.empty() || entry.first.size() > max_metadata_key_length || is_blank(entry.first) ||
        has_forbidden_control(entry.first) || (strict_machine_keys && !is_machine_key(entry.first, 64U, "_.-"))) {
      throw SdkException("validation_error", label + " key is invalid");
    }
    if (entry.second.kind() == MetadataValue::Kind::string) {
      const std::string &value = entry.second.string_value();
      if (is_blank(value) || value.size() > maximum_string_length ||
          (strict_machine_keys && has_forbidden_control(value))) {
        throw SdkException("validation_error", label + " string value is invalid");
      }
    } else if (entry.second.kind() == MetadataValue::Kind::number && !std::isfinite(entry.second.number_value())) {
      throw SdkException("validation_error", label + " number must be finite");
    }
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

void validate_named_version(const std::string &label, const NamedVersion &value) {
  require_bounded_text(label + " name", value.name, max_context_string_length);
  if (value.version.has_value()) {
    require_bounded_text(label + " version", *value.version, max_context_string_length);
  }
}

[[nodiscard]] TelemetryContext normalized_telemetry_context(TelemetryContext context) {
  if (context.schema_version != telemetry_context_schema_version) {
    throw SdkException("validation_error", "telemetry context schema_version must be 1");
  }
  bool has_any = false;
  if (context.resource.has_value()) {
    auto &resource = *context.resource;
    bool has_resource = false;
    if (resource.service.has_value()) {
      validate_named_version("telemetry service", *resource.service);
      has_resource = true;
    }
    if (resource.deployment.has_value()) {
      auto &deployment = *resource.deployment;
      if (!deployment.environment.has_value() && !deployment.release.has_value()) {
        throw SdkException("validation_error", "telemetry deployment must include environment or release");
      }
      if (deployment.environment.has_value()) {
        require_bounded_text("telemetry deployment environment", *deployment.environment, max_context_string_length);
      }
      if (deployment.release.has_value()) {
        require_bounded_text("telemetry deployment release", *deployment.release, max_context_string_length);
      }
      has_resource = true;
    }
    if (resource.runtime.has_value()) {
      validate_named_version("telemetry runtime", *resource.runtime);
      has_resource = true;
    }
    if (resource.framework.has_value()) {
      validate_named_version("telemetry framework", *resource.framework);
      has_resource = true;
    }
    if (resource.operating_system.has_value()) {
      auto &operating_system = *resource.operating_system;
      require_bounded_text("telemetry operating system name", operating_system.name, max_context_string_length);
      if (operating_system.version.has_value()) {
        require_bounded_text("telemetry operating system version", *operating_system.version,
                             max_context_string_length);
      }
      if (operating_system.build.has_value()) {
        require_bounded_text("telemetry operating system build", *operating_system.build, max_context_string_length);
      }
      has_resource = true;
    }
    if (resource.device.has_value()) {
      auto &device = *resource.device;
      if (!device.family.has_value() && !device.model.has_value() && !device.architecture.has_value()) {
        throw SdkException("validation_error", "telemetry device must include a populated field");
      }
      if (device.family.has_value()) {
        require_bounded_text("telemetry device family", *device.family, max_context_string_length);
      }
      if (device.model.has_value()) {
        require_bounded_text("telemetry device model", *device.model, max_context_string_length);
      }
      if (device.architecture.has_value()) {
        require_bounded_text("telemetry device architecture", *device.architecture, max_context_string_length);
      }
      has_resource = true;
    }
    if (resource.application.has_value()) {
      auto &application = *resource.application;
      if (!application.name.has_value() && !application.version.has_value() && !application.build.has_value()) {
        throw SdkException("validation_error", "telemetry application must include a populated field");
      }
      if (application.name.has_value()) {
        require_bounded_text("telemetry application name", *application.name, max_context_string_length);
      }
      if (application.version.has_value()) {
        require_bounded_text("telemetry application version", *application.version, max_context_string_length);
      }
      if (application.build.has_value()) {
        require_bounded_text("telemetry application build", *application.build, max_context_string_length);
      }
      has_resource = true;
    }
    if (!has_resource) {
      throw SdkException("validation_error", "telemetry resource must include a populated field");
    }
    has_any = true;
  }
  if (context.trace.has_value()) {
    auto &trace = *context.trace;
    trace.trace_id = require_valid_hex_id("telemetry trace_id", std::move(trace.trace_id), trace_id_length);
    if (trace.span_id.has_value()) {
      trace.span_id = require_valid_hex_id("telemetry span_id", std::move(*trace.span_id), span_id_length);
    }
    if (trace.parent_span_id.has_value()) {
      if (!trace.span_id.has_value()) {
        throw SdkException("validation_error", "telemetry parent_span_id requires span_id");
      }
      trace.parent_span_id =
          require_valid_hex_id("telemetry parent_span_id", std::move(*trace.parent_span_id), span_id_length);
    }
    has_any = true;
  }
  if (context.session.has_value()) {
    auto &session = *context.session;
    require_bounded_text("telemetry session id", session.id, max_context_id_length);
    if (session.previous_id.has_value()) {
      require_bounded_text("telemetry previous session id", *session.previous_id, max_context_id_length);
    }
    has_any = true;
  }
  if (context.subject.has_value()) {
    auto &subject = *context.subject;
    require_bounded_text("telemetry subject id", subject.id, max_context_id_length);
    switch (subject.kind) {
    case SubjectKind::anonymous:
    case SubjectKind::user:
      break;
    default:
      throw SdkException("validation_error", "telemetry subject kind is invalid");
    }
    has_any = true;
  }
  if (context.tags.size() > max_context_tags) {
    throw SdkException("validation_error", "telemetry context contains too many tags");
  }
  for (const auto &tag : context.tags) {
    if (!is_machine_key(tag.first, max_tag_key_length, "_.-")) {
      throw SdkException("validation_error", "telemetry tag key is invalid");
    }
    require_bounded_text("telemetry tag value", tag.second, max_tag_value_length);
  }
  has_any = has_any || !context.tags.empty();
  if (!has_any) {
    throw SdkException("validation_error", "telemetry context must include resource, trace, "
                                           "session, subject, or tags");
  }
  return context;
}

template <typename Value>
void merge_optional_value(std::optional<Value> &destination, const std::optional<Value> &source) {
  if (source.has_value()) {
    destination = source;
  }
}

void merge_named_version(std::optional<NamedVersion> &destination, const std::optional<NamedVersion> &source) {
  if (!source.has_value()) {
    return;
  }
  if (!destination.has_value()) {
    destination = source;
    return;
  }
  destination->name = source->name;
  merge_optional_value(destination->version, source->version);
}

void merge_resource(TelemetryResource &destination, const TelemetryResource &source) {
  merge_named_version(destination.service, source.service);
  merge_named_version(destination.runtime, source.runtime);
  merge_named_version(destination.framework, source.framework);
  if (source.deployment.has_value()) {
    if (!destination.deployment.has_value()) {
      destination.deployment = DeploymentContext{};
    }
    merge_optional_value(destination.deployment->environment, source.deployment->environment);
    merge_optional_value(destination.deployment->release, source.deployment->release);
  }
  if (source.operating_system.has_value()) {
    if (!destination.operating_system.has_value()) {
      destination.operating_system = source.operating_system;
    } else {
      destination.operating_system->name = source.operating_system->name;
      merge_optional_value(destination.operating_system->version, source.operating_system->version);
      merge_optional_value(destination.operating_system->build, source.operating_system->build);
    }
  }
  if (source.device.has_value()) {
    if (!destination.device.has_value()) {
      destination.device = DeviceContext{};
    }
    merge_optional_value(destination.device->family, source.device->family);
    merge_optional_value(destination.device->model, source.device->model);
    merge_optional_value(destination.device->architecture, source.device->architecture);
  }
  if (source.application.has_value()) {
    if (!destination.application.has_value()) {
      destination.application = ApplicationContext{};
    }
    merge_optional_value(destination.application->name, source.application->name);
    merge_optional_value(destination.application->version, source.application->version);
    merge_optional_value(destination.application->build, source.application->build);
  }
}

void merge_telemetry_context(TelemetryContext &destination, const TelemetryContext &source) {
  if (source.resource.has_value()) {
    if (!destination.resource.has_value()) {
      destination.resource = TelemetryResource{};
    }
    merge_resource(*destination.resource, *source.resource);
  }
  if (source.trace.has_value()) {
    if (!destination.trace.has_value() || destination.trace->trace_id != source.trace->trace_id) {
      destination.trace = source.trace;
    } else {
      if (source.trace->span_id.has_value() &&
          (!destination.trace->span_id.has_value() || destination.trace->span_id != source.trace->span_id)) {
        destination.trace->parent_span_id.reset();
      }
      merge_optional_value(destination.trace->span_id, source.trace->span_id);
      merge_optional_value(destination.trace->parent_span_id, source.trace->parent_span_id);
      merge_optional_value(destination.trace->sampled, source.trace->sampled);
    }
  }
  merge_optional_value(destination.session, source.session);
  merge_optional_value(destination.subject, source.subject);
  for (const auto &tag : source.tags) {
    destination.tags[tag.first] = tag.second;
  }
  if (destination.tags.size() > max_context_tags) {
    throw SdkException("validation_error", "merged telemetry tags exceed 32 entries");
  }
}

[[nodiscard]] TelemetryContext automatic_telemetry_context() {
  TelemetryContext context;
  TelemetryResource resource;
#if __cplusplus >= 202302L
  resource.runtime = NamedVersion{"cpp", "c++23"};
#elif __cplusplus >= 202002L
  resource.runtime = NamedVersion{"cpp", "c++20"};
#else
  resource.runtime = NamedVersion{"cpp", "c++17"};
#endif
#if defined(__APPLE__)
  resource.operating_system = OperatingSystemContext{"Darwin", std::nullopt, std::nullopt};
#elif defined(_WIN32)
  resource.operating_system = OperatingSystemContext{"Windows", std::nullopt, std::nullopt};
#elif defined(__linux__)
  resource.operating_system = OperatingSystemContext{"Linux", std::nullopt, std::nullopt};
#elif defined(__FreeBSD__)
  resource.operating_system = OperatingSystemContext{"FreeBSD", std::nullopt, std::nullopt};
#endif
#if defined(__aarch64__) || defined(_M_ARM64)
  resource.device = DeviceContext{std::nullopt, std::nullopt, "arm64"};
#elif defined(__x86_64__) || defined(_M_X64)
  resource.device = DeviceContext{std::nullopt, std::nullopt, "x86_64"};
#elif defined(__i386__) || defined(_M_IX86)
  resource.device = DeviceContext{std::nullopt, std::nullopt, "x86"};
#elif defined(__arm__) || defined(_M_ARM)
  resource.device = DeviceContext{std::nullopt, std::nullopt, "arm"};
#endif
  context.resource = std::move(resource);
  return normalized_telemetry_context(std::move(context));
}

template <typename Context> void unwind_inactive_scopes(std::shared_ptr<detail::ScopeState<Context>> &active) noexcept {
  while (active != nullptr && !active->active) {
    active = active->previous;
  }
}

[[nodiscard]] std::optional<TelemetryTraceContext> telemetry_trace_from_active_trace() {
  unwind_inactive_scopes(active_trace_scope);
  if (active_trace_scope == nullptr) {
    return std::nullopt;
  }
  const TraceContext &trace = active_trace_scope->context;
  return TelemetryTraceContext{
      trace.trace_id,
      trace.span_id,
      trace.parent_span_id,
      trace.sampled,
  };
}

[[nodiscard]] bool valid_signal_span_context(const SpanAttributes &span) {
  return valid_non_zero_hex(span.trace_id, trace_id_length) && valid_non_zero_hex(span.span_id, span_id_length) &&
         (!span.parent_span_id.has_value() || valid_non_zero_hex(*span.parent_span_id, span_id_length));
}

[[nodiscard]] std::optional<TelemetryContext>
effective_telemetry_context(const std::optional<TelemetryContext> &base,
                            const std::optional<TelemetryContext> &event_context, const SpanAttributes *signal_span) {
  std::optional<TelemetryContext> effective;
  const auto merge_layer = [&](const TelemetryContext &layer) {
    const TelemetryContext normalized = normalized_telemetry_context(layer);
    if (!effective.has_value()) {
      effective = normalized;
    } else {
      merge_telemetry_context(*effective, normalized);
    }
  };
  if (base.has_value()) {
    merge_layer(*base);
  }
  unwind_inactive_scopes(active_telemetry_scope);
  if (active_telemetry_scope != nullptr) {
    merge_layer(active_telemetry_scope->context);
  }
  const auto active_trace = telemetry_trace_from_active_trace();
  if (active_trace.has_value()) {
    TelemetryContext trace_layer;
    trace_layer.trace = active_trace;
    merge_layer(trace_layer);
  }
  if (signal_span != nullptr) {
    if (effective.has_value() && !valid_signal_span_context(*signal_span)) {
      effective->trace.reset();
    } else if (valid_signal_span_context(*signal_span)) {
      TelemetryContext span_layer;
      span_layer.trace = TelemetryTraceContext{
          lower_hex(signal_span->trace_id),
          lower_hex(signal_span->span_id),
          signal_span->parent_span_id.has_value() ? std::optional<std::string>(lower_hex(*signal_span->parent_span_id))
                                                  : std::nullopt,
          std::nullopt,
      };
      merge_layer(span_layer);
    }
  }
  if (event_context.has_value()) {
    merge_layer(*event_context);
  }
  if (effective.has_value()) {
    effective = normalized_telemetry_context(std::move(*effective));
  }
  return effective;
}

[[nodiscard]] std::string normalized_method(const std::string &method) {
  std::string normalized = trim_copy(method);
  require_non_empty("network method", normalized);
  if (normalized.size() > 15U || !std::all_of(normalized.begin(), normalized.end(), [](unsigned char character) {
        return is_ascii_alpha(character) || is_ascii_digit(character) ||
               std::string("!#$%&'*+-.^_`|~").find(static_cast<char>(character)) != std::string::npos;
      })) {
    throw SdkException("validation_error", "network method contains unsupported HTTP method characters");
  }
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char character) {
    if (character >= static_cast<unsigned char>('a') && character <= static_cast<unsigned char>('z')) {
      return static_cast<char>(character - (static_cast<unsigned char>('a') - static_cast<unsigned char>('A')));
    }
    return static_cast<char>(character);
  });
  return normalized;
}

[[nodiscard]] bool starts_with(const std::string &value, const std::string &prefix) {
  return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

[[nodiscard]] std::string strip_query_and_fragment(std::string route) {
  const auto query = route.find('?');
  const auto fragment = route.find('#');
  const auto first_sensitive_offset = std::min(query == std::string::npos ? route.size() : query,
                                               fragment == std::string::npos ? route.size() : fragment);
  route.erase(first_sensitive_offset);
  return route;
}

[[nodiscard]] std::string sanitized_route_template(const std::string &route_template) {
  std::string route = trim_copy(route_template);
  require_bounded_text("network route_template", route, 2048U);
  if (route.find('\\') != std::string::npos) {
    throw SdkException("validation_error", "network route_template must not contain backslashes");
  }
  if (starts_with(route, "//")) {
    throw SdkException("validation_error", "network route_template must not be protocol-relative");
  }
  const auto colon = route.find(':');
  const auto first_delimiter = route.find_first_of("/?#");
  const bool has_scheme =
      colon != std::string::npos && (first_delimiter == std::string::npos || colon < first_delimiter);
  if (has_scheme) {
    const std::string scheme = lower_hex(route.substr(0U, colon));
    if ((scheme != "http" && scheme != "https") || colon + 2U >= route.size() || route[colon + 1U] != '/' ||
        route[colon + 2U] != '/') {
      throw SdkException("validation_error", "network route_template must be an HTTP path or URL");
    }
    if (!is_machine_key(scheme, 16U, "+-.")) {
      throw SdkException("validation_error", "network route_template scheme is invalid");
    }
    const std::size_t authority_start = colon + 3U;
    const auto path_start = route.find_first_of("/?#", authority_start);
    const std::size_t authority_end = path_start == std::string::npos ? route.size() : path_start;
    if (authority_end == authority_start || route.find('@', authority_start) < authority_end) {
      throw SdkException("validation_error", "network route_template authority is invalid");
    }
    if (path_start == std::string::npos || route[path_start] != '/') {
      route = "/";
    } else {
      route = route.substr(path_start);
    }
  } else if (route.empty() || route.front() != '/' || starts_with(route, "//")) {
    throw SdkException("validation_error", "network route_template must be an absolute HTTP path");
  }
  route = strip_query_and_fragment(route);
  require_bounded_text("network route_template", route, 2048U);
  return route;
}

[[nodiscard]] std::optional<std::string> bounded_product_analytics_surface(const std::optional<std::string> &surface) {
  if (!surface.has_value()) {
    return std::nullopt;
  }
  const std::string normalized = trim_copy(*surface);
  if (normalized.empty()) {
    return std::nullopt;
  }

  std::size_t index = 0U;
  std::size_t character_count = 0U;
  while (index < normalized.size()) {
    const auto first = static_cast<unsigned char>(normalized[index]);
    std::uint32_t code_point = 0U;
    std::size_t width = 0U;
    if (first <= 0x7FU) {
      code_point = first;
      width = 1U;
    } else if ((first & 0xE0U) == 0xC0U) {
      code_point = first & 0x1FU;
      width = 2U;
    } else if ((first & 0xF0U) == 0xE0U) {
      code_point = first & 0x0FU;
      width = 3U;
    } else if ((first & 0xF8U) == 0xF0U) {
      code_point = first & 0x07U;
      width = 4U;
    } else {
      return std::nullopt;
    }
    if (index + width > normalized.size()) {
      return std::nullopt;
    }
    for (std::size_t offset = 1U; offset < width; offset++) {
      const auto continuation = static_cast<unsigned char>(normalized[index + offset]);
      if ((continuation & 0xC0U) != 0x80U) {
        return std::nullopt;
      }
      code_point = (code_point << 6U) | (continuation & 0x3FU);
    }
    if (code_point <= 31U || (code_point >= 127U && code_point <= 159U)) {
      return std::nullopt;
    }
    character_count++;
    if (character_count > max_product_analytics_surface_length) {
      return std::nullopt;
    }
    index += width;
  }
  return normalized;
}

[[nodiscard]] std::string json_string(const std::string &value) {
  std::ostringstream output;
  output << '"';
  for (const char raw_character : value) {
    const auto character = static_cast<unsigned char>(raw_character);
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
        output << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(character) << std::dec
               << std::setfill(' ');
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

void append_optional_field(std::ostringstream &output, bool &needs_comma, const std::string &key,
                           const std::optional<std::string> &value, bool require_present_value) {
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

void append_unsigned_field(std::ostringstream &output, bool &needs_comma, const std::string &key, unsigned int value) {
  if (needs_comma) {
    output << ',';
  }
  output << json_string(key) << ':' << value;
  needs_comma = true;
}

void append_bool_field(std::ostringstream &output, bool &needs_comma, const std::string &key, bool value) {
  if (needs_comma) {
    output << ',';
  }
  output << json_string(key) << ':' << (value ? "true" : "false");
  needs_comma = true;
}

void append_raw_field(std::ostringstream &output, bool &needs_comma, const std::string &key,
                      const std::string &raw_json) {
  if (needs_comma) {
    output << ',';
  }
  output << json_string(key) << ':' << raw_json;
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

void append_metadata_field(std::ostringstream &output, bool &needs_comma, const std::string &key,
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
  validate_metadata(metadata);
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

[[nodiscard]] std::string metadata_json(const Metadata &metadata) {
  validate_metadata(metadata);
  return object_json([&](std::ostringstream &output, bool &needs_comma) {
    for (const auto &entry : metadata) {
      append_metadata_field(output, needs_comma, entry.first, entry.second);
    }
  });
}

[[nodiscard]] std::string named_version_json(const NamedVersion &value) {
  return object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "name", value.name);
    append_optional_field(output, needs_comma, "version", value.version, true);
  });
}

[[nodiscard]] std::string telemetry_resource_json(const TelemetryResource &resource) {
  return object_json([&](std::ostringstream &output, bool &needs_comma) {
    if (resource.service.has_value()) {
      append_raw_field(output, needs_comma, "service", named_version_json(*resource.service));
    }
    if (resource.deployment.has_value()) {
      append_raw_field(
          output, needs_comma, "deployment", object_json([&](std::ostringstream &nested, bool &nested_comma) {
            append_optional_field(nested, nested_comma, "environment", resource.deployment->environment, true);
            append_optional_field(nested, nested_comma, "release", resource.deployment->release, true);
          }));
    }
    if (resource.runtime.has_value()) {
      append_raw_field(output, needs_comma, "runtime", named_version_json(*resource.runtime));
    }
    if (resource.framework.has_value()) {
      append_raw_field(output, needs_comma, "framework", named_version_json(*resource.framework));
    }
    if (resource.operating_system.has_value()) {
      append_raw_field(
          output, needs_comma, "operatingSystem", object_json([&](std::ostringstream &nested, bool &nested_comma) {
            append_field(nested, nested_comma, "name", resource.operating_system->name);
            append_optional_field(nested, nested_comma, "version", resource.operating_system->version, true);
            append_optional_field(nested, nested_comma, "build", resource.operating_system->build, true);
          }));
    }
    if (resource.device.has_value()) {
      append_raw_field(output, needs_comma, "device", object_json([&](std::ostringstream &nested, bool &nested_comma) {
                         append_optional_field(nested, nested_comma, "family", resource.device->family, true);
                         append_optional_field(nested, nested_comma, "model", resource.device->model, true);
                         append_optional_field(nested, nested_comma, "architecture", resource.device->architecture,
                                               true);
                       }));
    }
    if (resource.application.has_value()) {
      append_raw_field(output, needs_comma, "application",
                       object_json([&](std::ostringstream &nested, bool &nested_comma) {
                         append_optional_field(nested, nested_comma, "name", resource.application->name, true);
                         append_optional_field(nested, nested_comma, "version", resource.application->version, true);
                         append_optional_field(nested, nested_comma, "build", resource.application->build, true);
                       }));
    }
  });
}

[[nodiscard]] std::string telemetry_context_json(const TelemetryContext &unnormalized) {
  const TelemetryContext context = normalized_telemetry_context(unnormalized);
  return object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_unsigned_field(output, needs_comma, "schemaVersion", context.schema_version);
    if (context.resource.has_value()) {
      append_raw_field(output, needs_comma, "resource", telemetry_resource_json(*context.resource));
    }
    if (context.trace.has_value()) {
      append_raw_field(output, needs_comma, "trace", object_json([&](std::ostringstream &nested, bool &nested_comma) {
                         append_field(nested, nested_comma, "traceId", context.trace->trace_id);
                         append_optional_field(nested, nested_comma, "spanId", context.trace->span_id, true);
                         append_optional_field(nested, nested_comma, "parentSpanId", context.trace->parent_span_id,
                                               true);
                         if (context.trace->sampled.has_value()) {
                           append_bool_field(nested, nested_comma, "sampled", *context.trace->sampled);
                         }
                       }));
    }
    if (context.session.has_value()) {
      append_raw_field(output, needs_comma, "session", object_json([&](std::ostringstream &nested, bool &nested_comma) {
                         append_field(nested, nested_comma, "id", context.session->id);
                         append_optional_field(nested, nested_comma, "previousId", context.session->previous_id, true);
                       }));
    }
    if (context.subject.has_value()) {
      append_raw_field(output, needs_comma, "subject", object_json([&](std::ostringstream &nested, bool &nested_comma) {
                         append_field(nested, nested_comma, "id", context.subject->id);
                         append_field(nested, nested_comma, "kind",
                                      context.subject->kind == SubjectKind::user ? "user" : "anonymous");
                       }));
    }
    if (!context.tags.empty()) {
      append_raw_field(output, needs_comma, "tags", object_json([&](std::ostringstream &nested, bool &nested_comma) {
                         for (const auto &tag : context.tags) {
                           append_field(nested, nested_comma, tag.first, tag.second);
                         }
                       }));
    }
  });
}

void validate_issue_stack_frame(const IssueStackFrame &frame) {
  require_bounded_text("issue frame filename", frame.filename, 2048U, true);
  if (is_absolute_path(frame.filename)) {
    throw SdkException("validation_error", "issue frame filename must be relative or sanitized "
                                           "with issue_frame_from_location");
  }
  if (frame.line == 0U || frame.line > static_cast<unsigned int>(INT_MAX) || frame.column == 0U ||
      frame.column > static_cast<unsigned int>(INT_MAX)) {
    throw SdkException("validation_error", "issue frame line and column must be positive");
  }
  if (frame.function.has_value()) {
    require_bounded_text("issue frame function", *frame.function, 256U);
  }
  if (frame.module.has_value()) {
    require_bounded_text("issue frame module", *frame.module, 512U, true);
  }
  if (frame.debug_id.has_value() && !is_uuid(*frame.debug_id)) {
    throw SdkException("validation_error", "issue frame debug_id is invalid");
  }
}

[[nodiscard]] std::string issue_stack_frame_json(const IssueStackFrame &frame) {
  validate_issue_stack_frame(frame);
  return object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "filename", frame.filename);
    append_unsigned_field(output, needs_comma, "line", frame.line);
    append_unsigned_field(output, needs_comma, "column", frame.column);
    append_optional_field(output, needs_comma, "function", frame.function, true);
    append_optional_field(output, needs_comma, "module", frame.module, true);
    if (frame.in_app.has_value()) {
      append_bool_field(output, needs_comma, "inApp", *frame.in_app);
    }
    append_optional_field(output, needs_comma, "debugId", frame.debug_id, true);
  });
}

[[nodiscard]] std::string issue_breadcrumb_json(const IssueBreadcrumb &breadcrumb) {
  require_timestamp(breadcrumb.timestamp);
  if (!is_machine_key(breadcrumb.category, 64U, "_.:-")) {
    throw SdkException("validation_error", "issue breadcrumb category is invalid");
  }
  if (breadcrumb.type.has_value() && !is_machine_key(*breadcrumb.type, 64U, "_.:-")) {
    throw SdkException("validation_error", "issue breadcrumb type is invalid");
  }
  if (breadcrumb.level.has_value()) {
    require_allowed("issue breadcrumb level", *breadcrumb.level, {"debug", "info", "warning", "error", "critical"});
  }
  if (breadcrumb.message.has_value()) {
    require_bounded_text("issue breadcrumb message", *breadcrumb.message, 512U);
  }
  validate_metadata(breadcrumb.data, "issue breadcrumb data", 8U, true, 256U);
  return object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "timestamp", breadcrumb.timestamp);
    append_optional_field(output, needs_comma, "type", breadcrumb.type, true);
    append_field(output, needs_comma, "category", breadcrumb.category);
    append_optional_field(output, needs_comma, "level", breadcrumb.level, true);
    append_optional_field(output, needs_comma, "message", breadcrumb.message, true);
    if (!breadcrumb.data.empty()) {
      append_raw_field(output, needs_comma, "data", metadata_json(breadcrumb.data));
    }
  });
}

void append_issue_evidence(std::ostringstream &output, bool &needs_comma, const IssueDetails &details,
                           const std::vector<IssueBreadcrumb> &stored_breadcrumbs, bool stored_breadcrumbs_truncated) {
  if (details.exception.has_value()) {
    require_bounded_text("issue exception type", details.exception->type, 256U, true);
    append_raw_field(output, needs_comma, "exception", object_json([&](std::ostringstream &nested, bool &nested_comma) {
                       append_field(nested, nested_comma, "type", details.exception->type);
                       if (details.exception->mechanism.has_value()) {
                         const auto &mechanism = *details.exception->mechanism;
                         if (!is_machine_key(mechanism.type, 64U, "_.:-")) {
                           throw SdkException("validation_error", "issue exception mechanism type is invalid");
                         }
                         append_raw_field(nested, nested_comma, "mechanism",
                                          object_json([&](std::ostringstream &mechanism_output, bool &mechanism_comma) {
                                            append_field(mechanism_output, mechanism_comma, "type", mechanism.type);
                                            append_bool_field(mechanism_output, mechanism_comma, "handled",
                                                              mechanism.handled);
                                          }));
                       }
                     }));
  }
  if (details.stack_frames.size() > max_stack_frames) {
    throw SdkException("validation_error", "issue stack frames must contain at most 32 entries");
  }
  if (!details.stack_frames.empty()) {
    std::ostringstream frames;
    frames << '[';
    for (std::size_t index = 0U; index < details.stack_frames.size(); index++) {
      if (index > 0U) {
        frames << ',';
      }
      frames << issue_stack_frame_json(details.stack_frames[index]);
    }
    frames << ']';
    append_raw_field(output, needs_comma, "stackFrames", frames.str());
  }

  const std::size_t explicit_start =
      details.breadcrumbs.size() > max_breadcrumbs ? details.breadcrumbs.size() - max_breadcrumbs : 0U;
  std::vector<IssueBreadcrumb> combined = stored_breadcrumbs;
  combined.insert(combined.end(), details.breadcrumbs.begin() + static_cast<std::ptrdiff_t>(explicit_start),
                  details.breadcrumbs.end());
  const bool truncated = details.breadcrumbs_truncated || stored_breadcrumbs_truncated ||
                         details.breadcrumbs.size() > max_breadcrumbs || combined.size() > max_breadcrumbs;
  const std::size_t combined_start = combined.size() > max_breadcrumbs ? combined.size() - max_breadcrumbs : 0U;
  if (combined_start < combined.size()) {
    std::ostringstream breadcrumbs;
    breadcrumbs << '[';
    for (std::size_t index = combined_start; index < combined.size(); index++) {
      if (index > combined_start) {
        breadcrumbs << ',';
      }
      breadcrumbs << issue_breadcrumb_json(combined[index]);
    }
    breadcrumbs << ']';
    append_raw_field(output, needs_comma, "breadcrumbs", breadcrumbs.str());
  }
  if (truncated) {
    append_bool_field(output, needs_comma, "breadcrumbsTruncated", true);
  }
}

void append_span_evidence(std::ostringstream &output, bool &needs_comma, const SpanEvidence &evidence) {
  if (evidence.events.size() > max_span_events) {
    throw SdkException("validation_error", "span events must contain at most 8 entries");
  }
  if (evidence.links.size() > max_span_links) {
    throw SdkException("validation_error", "span links must contain at most 8 entries");
  }
  if (!evidence.events.empty()) {
    std::ostringstream events;
    events << '[';
    for (std::size_t index = 0U; index < evidence.events.size(); index++) {
      const SpanEvent &event = evidence.events[index];
      require_bounded_text("span event name", event.name, 512U);
      if (event.timestamp.has_value()) {
        require_timestamp(*event.timestamp);
      }
      validate_metadata(event.metadata, "span event metadata", 64U);
      if (index > 0U) {
        events << ',';
      }
      events << object_json([&](std::ostringstream &nested, bool &nested_comma) {
        append_field(nested, nested_comma, "name", event.name);
        append_optional_field(nested, nested_comma, "timestamp", event.timestamp, true);
        if (!event.metadata.empty()) {
          append_raw_field(nested, nested_comma, "metadata", metadata_json(event.metadata));
        }
      });
    }
    events << ']';
    append_raw_field(output, needs_comma, "events", events.str());
  }
  if (!evidence.links.empty()) {
    std::ostringstream links;
    links << '[';
    for (std::size_t index = 0U; index < evidence.links.size(); index++) {
      const SpanLink &link = evidence.links[index];
      const std::string trace_id = require_valid_hex_id("span link trace_id", link.trace_id, trace_id_length);
      const std::string span_id = require_valid_hex_id("span link span_id", link.span_id, span_id_length);
      validate_metadata(link.metadata, "span link metadata", 64U);
      if (index > 0U) {
        links << ',';
      }
      links << object_json([&](std::ostringstream &nested, bool &nested_comma) {
        append_field(nested, nested_comma, "traceId", trace_id);
        append_field(nested, nested_comma, "spanId", span_id);
        if (link.sampled.has_value()) {
          append_bool_field(nested, nested_comma, "sampled", *link.sampled);
        }
        if (!link.metadata.empty()) {
          append_raw_field(nested, nested_comma, "metadata", metadata_json(link.metadata));
        }
      });
    }
    links << ']';
    append_raw_field(output, needs_comma, "links", links.str());
  }
}

[[nodiscard]] Metadata merge_metadata(Metadata base, const Metadata &override_metadata) {
  validate_metadata(base);
  validate_metadata(override_metadata);
  for (const auto &entry : override_metadata) {
    base[entry.first] = entry.second;
  }
  validate_metadata(base);
  return base;
}

[[nodiscard]] Metadata merge_active_trace_metadata(Metadata metadata) {
  validate_metadata(metadata);
  const Metadata trace = trace_metadata();
  for (const auto &entry : trace) {
    metadata[entry.first] = entry.second;
  }
  validate_metadata(metadata);
  return metadata;
}

[[nodiscard]] Metadata timeline_metadata(const std::string &source, const ProductTimelineContext &context,
                                         const Metadata &metadata, const Metadata &override_metadata) {
  Metadata merged = merge_metadata(context.metadata, metadata);
  merged = merge_metadata(std::move(merged), override_metadata);
  if (context.session_id.has_value()) {
    require_bounded_text("session_id", *context.session_id, max_context_id_length);
    merged["sessionId"] = *context.session_id;
  }
  if (context.screen.has_value()) {
    require_bounded_text("screen", *context.screen, max_context_string_length);
    merged["screen"] = *context.screen;
  }
  if (context.trace_id.has_value()) {
    require_bounded_text("trace_id", *context.trace_id, max_context_id_length);
    merged["traceId"] = *context.trace_id;
  }
  if (context.route_template.has_value()) {
    merged["routeTemplate"] = sanitized_route_template(*context.route_template);
  }
  if (context.funnel.has_value()) {
    require_bounded_text("funnel", *context.funnel, max_context_string_length);
    merged["funnel"] = *context.funnel;
  }
  if (context.step.has_value()) {
    require_bounded_text("step", *context.step, max_context_string_length);
    merged["step"] = *context.step;
  }
  merged["source"] = source;
  validate_metadata(merged);
  return merged;
}

} // namespace

SdkException::SdkException(std::string code, std::string message)
    : std::runtime_error(std::move(message)), code_(std::move(code)) {}

const std::string &SdkException::code() const noexcept { return code_; }

TransportError::TransportError(std::string code, std::string message, bool retryable)
    : std::runtime_error(std::move(message)), code_(std::move(code)), retryable_(retryable) {}

const std::string &TransportError::code() const noexcept { return code_; }

bool TransportError::retryable() const noexcept { return retryable_; }

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

MetadataValue::Kind MetadataValue::kind() const noexcept { return kind_; }

bool MetadataValue::bool_value() const noexcept { return bool_value_; }

double MetadataValue::number_value() const noexcept { return number_value_; }

const std::string &MetadataValue::string_value() const noexcept { return string_value_; }

void validate_telemetry_context(const TelemetryContext &context) {
  static_cast<void>(normalized_telemetry_context(context));
}

TelemetryScope::TelemetryScope(TelemetryContext context)
    : state_(std::make_shared<detail::ScopeState<TelemetryContext>>()) {
  state_->context = normalized_telemetry_context(std::move(context));
  unwind_inactive_scopes(active_telemetry_scope);
  state_->previous = active_telemetry_scope;
  active_telemetry_scope = state_;
}

TelemetryScope::~TelemetryScope() {
  if (state_ == nullptr) {
    return;
  }
  state_->active = false;
  if (active_telemetry_scope == state_) {
    active_telemetry_scope = state_->previous;
    unwind_inactive_scopes(active_telemetry_scope);
  }
}

const TelemetryContext &TelemetryScope::context() const noexcept { return state_->context; }

const TelemetryContext *current_telemetry_context() noexcept {
  unwind_inactive_scopes(active_telemetry_scope);
  return active_telemetry_scope == nullptr ? nullptr : &active_telemetry_scope->context;
}

IssueStackFrame issue_frame_from_location(std::string file, unsigned int line, unsigned int column,
                                          std::optional<std::string> function, std::optional<std::string> module,
                                          bool in_app) {
  require_non_empty("issue frame file", file);
  const auto sensitive_offset = file.find_first_of("?#");
  if (sensitive_offset != std::string::npos) {
    file.erase(sensitive_offset);
  }
  const auto separator = file.find_last_of("/\\");
  std::string filename = separator == std::string::npos ? file : file.substr(separator + 1U);
  IssueStackFrame frame{
      std::move(filename), line, column, std::move(function), std::move(module), in_app, std::nullopt,
  };
  validate_issue_stack_frame(frame);
  return frame;
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
  const std::string trace_version = lower_hex(value.substr(0, 2));
  const std::string trace_id = lower_hex(value.substr(3, trace_id_length));
  const std::string parent_span_id = lower_hex(value.substr(36, span_id_length));
  const std::string trace_flags = lower_hex(value.substr(53, trace_flags_length));
  if (trace_version == "ff" ||
      !std::all_of(trace_version.begin(), trace_version.end(), is_hex_character)) {
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

OpenTelemetrySpanContext open_telemetry_span_context(std::string trace_id, std::string span_id,
                                                     std::string trace_flags) {
  trace_id = require_valid_hex_id("OpenTelemetry trace id", std::move(trace_id), trace_id_length);
  span_id = require_valid_hex_id("OpenTelemetry span id", std::move(span_id), span_id_length);
  trace_flags = require_valid_trace_flags("OpenTelemetry trace flags", std::move(trace_flags));
  return OpenTelemetrySpanContext{
      std::move(trace_id),
      std::move(span_id),
      trace_flags,
      (hex_value(trace_flags.back()) & 0x01) == 0x01,
  };
}

OpenTelemetrySpanContext open_telemetry_span_context_from_sampled(std::string trace_id, std::string span_id,
                                                                  bool sampled) {
  return open_telemetry_span_context(std::move(trace_id), std::move(span_id), sampled ? "01" : "00");
}

TraceContext trace_context_from_opentelemetry_span_context(const OpenTelemetrySpanContext &context) {
  const OpenTelemetrySpanContext normalized =
      open_telemetry_span_context(context.trace_id, context.span_id, context.trace_flags);
  return TraceContext{
      normalized.trace_id, generated_hex(span_id_length), normalized.span_id, normalized.trace_flags,
      normalized.sampled,
  };
}

const TraceContext *current_trace_context() noexcept {
  unwind_inactive_scopes(active_trace_scope);
  return active_trace_scope == nullptr ? nullptr : &active_trace_scope->context;
}

TraceScope::TraceScope(TraceContext context) : state_(std::make_shared<detail::ScopeState<TraceContext>>()) {
  state_->context = normalized_trace_context(std::move(context));
  unwind_inactive_scopes(active_trace_scope);
  state_->previous = active_trace_scope;
  active_trace_scope = state_;
}

TraceScope::~TraceScope() {
  if (state_ == nullptr) {
    return;
  }
  state_->active = false;
  if (active_trace_scope == state_) {
    active_trace_scope = state_->previous;
    unwind_inactive_scopes(active_trace_scope);
  }
}

const TraceContext &TraceScope::context() const noexcept { return state_->context; }

Metadata trace_metadata(const TraceContext *context) {
  if (context == nullptr) {
    context = current_trace_context();
  }
  if (context == nullptr || is_blank(context->trace_id) || is_blank(context->span_id)) {
    return {};
  }
  const TraceContext normalized = normalized_trace_context(*context);
  Metadata metadata{
      {"traceId", normalized.trace_id},
      {"spanId", normalized.span_id},
      {"sampled", normalized.sampled},
      {"traceFlags", normalized.trace_flags},
  };
  if (normalized.parent_span_id.has_value()) {
    metadata["parentSpanId"] = *normalized.parent_span_id;
  }
  return metadata;
}

ProductTimelineContext trace_product_timeline_context(ProductTimelineContext context, const TraceContext *trace) {
  if (trace == nullptr) {
    trace = current_trace_context();
  }
  if (trace != nullptr && !is_blank(trace->trace_id)) {
    const TraceContext normalized = normalized_trace_context(*trace);
    context.trace_id = normalized.trace_id;
  }
  return context;
}

SpanAttributes trace_span_attributes(std::string name, std::string status, std::optional<double> duration_ms,
                                     const TraceContext *context) {
  if (context == nullptr) {
    context = current_trace_context();
  }
  if (context == nullptr || is_blank(context->trace_id) || is_blank(context->span_id)) {
    throw SdkException("validation_error", "trace context is required");
  }
  const TraceContext normalized = normalized_trace_context(*context);
  return SpanAttributes{
      std::move(name),           normalized.trace_id, normalized.span_id,
      normalized.parent_span_id, std::move(status),   duration_ms,
  };
}

SpanAttributes trace_span_attributes_from_opentelemetry_span_context(std::string name, std::string status,
                                                                     const OpenTelemetrySpanContext &context,
                                                                     std::optional<double> duration_ms) {
  const TraceContext trace = trace_context_from_opentelemetry_span_context(context);
  return trace_span_attributes(std::move(name), std::move(status), duration_ms, &trace);
}

std::map<std::string, std::string> traceparent_headers(const TraceContext *context) {
  if (context == nullptr) {
    context = current_trace_context();
  }
  if (context == nullptr || is_blank(context->trace_id) || is_blank(context->span_id) ||
      is_blank(context->trace_flags)) {
    throw SdkException("validation_error", "trace context is required");
  }
  const TraceContext normalized = normalized_trace_context(*context);
  return {{"traceparent", "00-" + normalized.trace_id + "-" + normalized.span_id + "-" + normalized.trace_flags}};
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
    throw TransportError(step.code.empty() ? "transport_error" : step.code,
                         step.message.empty() ? "transport failed" : step.message, step.retryable);
  }
  return TransportResponse{step.status_code, 1};
}

const std::vector<std::string> &RecordingTransport::sent_bodies() const noexcept { return sent_bodies_; }

const std::string *RecordingTransport::last_body() const noexcept {
  if (sent_bodies_.empty()) {
    return nullptr;
  }
  return &sent_bodies_.back();
}

LogBrewClient::LogBrewClient(Config config) : LogBrewClient(std::move(config), ClientOptions{}) {}

LogBrewClient::LogBrewClient(Config config, ClientOptions options)
    : api_key_(std::move(config.api_key)), sdk_name_(std::move(config.sdk_name)),
      sdk_version_(std::move(config.sdk_version)), max_retries_(config.max_retries == 0U ? 2U : config.max_retries) {
  require_non_empty("api_key", api_key_);
  require_non_empty("sdk_name", sdk_name_);
  require_non_empty("sdk_version", sdk_version_);
  if (!options.disable_automatic_context) {
    base_context_ = automatic_telemetry_context();
  }
  if (options.context.has_value()) {
    const TelemetryContext provided = normalized_telemetry_context(std::move(*options.context));
    if (!base_context_.has_value()) {
      base_context_ = provided;
    } else {
      merge_telemetry_context(*base_context_, provided);
      base_context_ = normalized_telemetry_context(std::move(*base_context_));
    }
  }
}

std::size_t LogBrewClient::pending_events() const noexcept { return events_.size(); }

std::string LogBrewClient::preview_json() const {
  std::ostringstream output;
  output << "{\"sdk\":{\"name\":" << json_string(sdk_name_)
         << ",\"language\":\"cpp\",\"version\":" << json_string(sdk_version_) << "},\"events\":[";
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

void LogBrewClient::add_breadcrumb(IssueBreadcrumb breadcrumb) {
  if (closed_) {
    throw SdkException("shutdown_error", "client is already shut down");
  }
  static_cast<void>(issue_breadcrumb_json(breadcrumb));
  if (breadcrumbs_.size() == max_breadcrumbs) {
    breadcrumbs_.erase(breadcrumbs_.begin());
    breadcrumbs_truncated_ = true;
  }
  breadcrumbs_.push_back(std::move(breadcrumb));
}

void LogBrewClient::clear_breadcrumbs() noexcept {
  breadcrumbs_.clear();
  breadcrumbs_truncated_ = false;
}

void LogBrewClient::release(std::string id, std::string timestamp, ReleaseAttributes attributes) {
  release(std::move(id), std::move(timestamp), std::move(attributes), EventOptions{});
}

void LogBrewClient::release(std::string id, std::string timestamp, ReleaseAttributes attributes, EventOptions options) {
  require_non_empty("release version", attributes.version);
  const std::string attributes_json = object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "version", attributes.version);
    append_optional_field(output, needs_comma, "commit", attributes.commit, true);
    append_optional_field(output, needs_comma, "notes", attributes.notes, false);
    append_metadata_object(output, needs_comma, options.metadata);
  });
  push_event("release", std::move(id), std::move(timestamp), attributes_json, options.context);
}

void LogBrewClient::environment(std::string id, std::string timestamp, EnvironmentAttributes attributes) {
  environment(std::move(id), std::move(timestamp), std::move(attributes), EventOptions{});
}

void LogBrewClient::environment(std::string id, std::string timestamp, EnvironmentAttributes attributes,
                                EventOptions options) {
  require_non_empty("environment name", attributes.name);
  const std::string attributes_json = object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "name", attributes.name);
    append_optional_field(output, needs_comma, "region", attributes.region, false);
    append_metadata_object(output, needs_comma, options.metadata);
  });
  push_event("environment", std::move(id), std::move(timestamp), attributes_json, options.context);
}

void LogBrewClient::issue(std::string id, std::string timestamp, IssueAttributes attributes) {
  issue(std::move(id), std::move(timestamp), std::move(attributes), IssueDetails{}, EventOptions{});
}

void LogBrewClient::issue(std::string id, std::string timestamp, IssueAttributes attributes, EventOptions options) {
  issue(std::move(id), std::move(timestamp), std::move(attributes), IssueDetails{}, std::move(options));
}

void LogBrewClient::issue(std::string id, std::string timestamp, IssueAttributes attributes, IssueDetails details,
                          EventOptions options) {
  require_non_empty("issue title", attributes.title);
  const std::string level = normalize_severity("issue level", attributes.level);
  const Metadata metadata = merge_active_trace_metadata(std::move(options.metadata));
  const std::string attributes_json = object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "title", attributes.title);
    append_field(output, needs_comma, "level", level);
    append_optional_field(output, needs_comma, "message", attributes.message, false);
    append_issue_evidence(output, needs_comma, details, breadcrumbs_, breadcrumbs_truncated_);
    append_metadata_object(output, needs_comma, metadata);
  });
  push_event("issue", std::move(id), std::move(timestamp), attributes_json, options.context);
}

void LogBrewClient::log(std::string id, std::string timestamp, LogAttributes attributes) {
  log(std::move(id), std::move(timestamp), std::move(attributes), EventOptions{});
}

void LogBrewClient::log(std::string id, std::string timestamp, LogAttributes attributes, EventOptions options) {
  require_non_empty("log message", attributes.message);
  const std::string level = normalize_severity("log level", attributes.level);
  const Metadata metadata = merge_active_trace_metadata(std::move(options.metadata));
  const std::string attributes_json = object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "message", attributes.message);
    append_field(output, needs_comma, "level", level);
    append_optional_field(output, needs_comma, "logger", attributes.logger, false);
    append_metadata_object(output, needs_comma, metadata);
  });
  push_event("log", std::move(id), std::move(timestamp), attributes_json, options.context);
}

void LogBrewClient::span(std::string id, std::string timestamp, SpanAttributes attributes) {
  span(std::move(id), std::move(timestamp), std::move(attributes), SpanEvidence{}, EventOptions{});
}

void LogBrewClient::span(std::string id, std::string timestamp, SpanAttributes attributes, EventOptions options) {
  span(std::move(id), std::move(timestamp), std::move(attributes), SpanEvidence{}, std::move(options));
}

void LogBrewClient::span(std::string id, std::string timestamp, SpanAttributes attributes, SpanEvidence evidence,
                         EventOptions options) {
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
  const std::string attributes_json = object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "name", attributes.name);
    append_field(output, needs_comma, "traceId", attributes.trace_id);
    append_field(output, needs_comma, "spanId", attributes.span_id);
    append_optional_field(output, needs_comma, "parentSpanId", attributes.parent_span_id, true);
    append_field(output, needs_comma, "status", attributes.status);
    if (attributes.duration_ms.has_value()) {
      append_number_field(output, needs_comma, "durationMs", *attributes.duration_ms);
    }
    append_span_evidence(output, needs_comma, evidence);
    append_metadata_object(output, needs_comma, options.metadata);
  });
  push_event("span", std::move(id), std::move(timestamp), attributes_json, options.context, &attributes);
}

void LogBrewClient::metric(std::string id, std::string timestamp, MetricAttributes attributes) {
  metric(std::move(id), std::move(timestamp), std::move(attributes), EventOptions{});
}

void LogBrewClient::metric(std::string id, std::string timestamp, MetricAttributes attributes, EventOptions options) {
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
  if (attributes.description.has_value()) {
    attributes.description = normalized_metric_description(std::move(*attributes.description));
  }
  const Metadata metadata =
      merge_active_trace_metadata(merge_metadata(std::move(attributes.metadata), options.metadata));
  const std::string attributes_json = object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "name", attributes.name);
    append_optional_field(output, needs_comma, "description", attributes.description, true);
    append_field(output, needs_comma, "kind", attributes.kind);
    append_number_field(output, needs_comma, "value", attributes.value);
    append_field(output, needs_comma, "unit", attributes.unit);
    append_field(output, needs_comma, "temporality", attributes.temporality);
    append_metadata_object(output, needs_comma, metadata);
  });
  push_event("metric", std::move(id), std::move(timestamp), attributes_json, options.context);
}

void LogBrewClient::action(std::string id, std::string timestamp, ActionAttributes attributes) {
  action(std::move(id), std::move(timestamp), std::move(attributes), EventOptions{});
}

void LogBrewClient::action(std::string id, std::string timestamp, ActionAttributes attributes, EventOptions options) {
  require_non_empty("action name", attributes.name);
  require_allowed("action status", attributes.status, {"queued", "running", "success", "failure"});
  const Metadata metadata =
      merge_active_trace_metadata(merge_metadata(std::move(attributes.metadata), options.metadata));
  const std::string attributes_json = object_json([&](std::ostringstream &output, bool &needs_comma) {
    append_field(output, needs_comma, "name", attributes.name);
    append_field(output, needs_comma, "status", attributes.status);
    append_metadata_object(output, needs_comma, metadata);
  });
  push_event("action", std::move(id), std::move(timestamp), attributes_json, options.context);
}

void LogBrewClient::capture_product_action(std::string id, std::string timestamp, ProductActionAttributes attributes) {
  capture_product_action(std::move(id), std::move(timestamp), std::move(attributes), EventOptions{});
}

void LogBrewClient::capture_product_action(std::string id, std::string timestamp, ProductActionAttributes attributes,
                                           EventOptions options) {
  require_non_empty("product action name", attributes.name);
  Metadata metadata =
      timeline_metadata("cpp.product_action", attributes.context, attributes.metadata, options.metadata);
  metadata["analyticsSchemaVersion"] = 1;
  metadata["analyticsKind"] = "interaction";
  const auto surface = bounded_product_analytics_surface(attributes.context.screen);
  if (surface.has_value()) {
    metadata["analyticsSurface"] = *surface;
  } else {
    metadata.erase("analyticsSurface");
  }
  action(std::move(id), std::move(timestamp),
         ActionAttributes{
             attributes.name,
             attributes.status.value_or("success"),
             std::move(metadata),
         },
         EventOptions{{}, std::move(options.context)});
}

void LogBrewClient::capture_network_milestone(std::string id, std::string timestamp,
                                              NetworkMilestoneAttributes attributes) {
  capture_network_milestone(std::move(id), std::move(timestamp), std::move(attributes), EventOptions{});
}

void LogBrewClient::capture_network_milestone(std::string id, std::string timestamp,
                                              NetworkMilestoneAttributes attributes, EventOptions options) {
  const std::string method = normalized_method(attributes.method);
  const std::string route_template = sanitized_route_template(attributes.route_template);
  Metadata metadata = timeline_metadata("cpp.network", attributes.context, attributes.metadata, options.metadata);
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
  action(std::move(id), std::move(timestamp),
         ActionAttributes{
             method + " " + route_template,
             status,
             std::move(metadata),
         },
         EventOptions{{}, std::move(options.context)});
}

std::string LogBrewClient::event_json(const Event &event) {
  std::ostringstream output;
  output << "{\"type\":" << json_string(event.type) << ",\"timestamp\":" << json_string(event.timestamp)
         << ",\"id\":" << json_string(event.id) << ",\"attributes\":" << event.attributes_json << '}';
  return output.str();
}

void LogBrewClient::push_event(std::string type, std::string id, std::string timestamp, std::string attributes_json,
                               const std::optional<TelemetryContext> &event_context,
                               const SpanAttributes *signal_span) {
  if (closed_) {
    throw SdkException("shutdown_error", "client is already shut down");
  }
  require_non_empty("id", id);
  require_timestamp(timestamp);
  const auto context = effective_telemetry_context(base_context_, event_context, signal_span);
  if (context.has_value()) {
    if (attributes_json.size() < 2U || attributes_json.front() != '{' || attributes_json.back() != '}') {
      throw SdkException("serialization_error", "event attributes are invalid");
    }
    attributes_json.pop_back();
    if (attributes_json.size() > 1U) {
      attributes_json.push_back(',');
    }
    attributes_json += "\"context\":" + telemetry_context_json(*context) + '}';
  }
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
