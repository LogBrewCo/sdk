#ifndef LOGBREW_CPP_HPP
#define LOGBREW_CPP_HPP

#include <cstddef>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace logbrew {

inline constexpr const char *version = "0.1.0";
inline constexpr const char *http_transport_default_endpoint = "https://api.logbrew.com/v1/events";
inline constexpr std::size_t trace_id_length = 32U;
inline constexpr std::size_t span_id_length = 16U;
inline constexpr std::size_t trace_flags_length = 2U;
inline constexpr std::size_t traceparent_length = 55U;

class SdkException final : public std::runtime_error {
public:
  SdkException(std::string code, std::string message);

  [[nodiscard]] const std::string &code() const noexcept;

private:
  std::string code_;
};

class TransportError final : public std::runtime_error {
public:
  TransportError(std::string code, std::string message, bool retryable);

  [[nodiscard]] const std::string &code() const noexcept;
  [[nodiscard]] bool retryable() const noexcept;

private:
  std::string code_;
  bool retryable_;
};

struct TransportResponse {
  int status_code = 0;
  std::size_t attempts = 0;
};

class Transport {
public:
  virtual ~Transport() = default;
  virtual TransportResponse send(const std::string &api_key, const std::string &body) = 0;
};

struct HttpHeader {
  std::string name;
  std::string value;
};

class HttpTransport final : public Transport {
public:
  explicit HttpTransport(
      std::string endpoint = http_transport_default_endpoint,
      std::vector<HttpHeader> headers = {},
      long timeout_ms = 10000L);

  TransportResponse send(const std::string &api_key, const std::string &body) override;

private:
  std::string endpoint_;
  std::vector<HttpHeader> headers_;
  long timeout_ms_;
};

struct Config {
  std::string api_key;
  std::string sdk_name = "logbrew-cpp";
  std::string sdk_version = version;
  std::size_t max_retries = 2;
};

struct ReleaseAttributes {
  std::string version;
  std::optional<std::string> commit;
  std::optional<std::string> notes;
};

struct EnvironmentAttributes {
  std::string name;
  std::optional<std::string> region;
};

struct IssueAttributes {
  std::string title;
  std::string level;
  std::optional<std::string> message;
};

struct LogAttributes {
  std::string message;
  std::string level;
  std::optional<std::string> logger;
};

struct SpanAttributes {
  std::string name;
  std::string trace_id;
  std::string span_id;
  std::optional<std::string> parent_span_id;
  std::string status;
  std::optional<double> duration_ms;
};

class MetadataValue final {
public:
  enum class Kind {
    null_value,
    boolean,
    number,
    string,
  };

  MetadataValue();
  MetadataValue(std::nullptr_t);
  MetadataValue(bool value);
  MetadataValue(int value);
  MetadataValue(long value);
  MetadataValue(long long value);
  MetadataValue(unsigned int value);
  MetadataValue(unsigned long value);
  MetadataValue(unsigned long long value);
  MetadataValue(double value);
  MetadataValue(const char *value);
  MetadataValue(std::string value);

  [[nodiscard]] Kind kind() const noexcept;
  [[nodiscard]] bool bool_value() const noexcept;
  [[nodiscard]] double number_value() const noexcept;
  [[nodiscard]] const std::string &string_value() const noexcept;

private:
  Kind kind_ = Kind::null_value;
  bool bool_value_ = false;
  double number_value_ = 0.0;
  std::string string_value_;
};

using Metadata = std::map<std::string, MetadataValue>;

struct OpenTelemetrySpanContext {
  std::string trace_id;
  std::string span_id;
  std::string trace_flags = "01";
  bool sampled = true;
};

struct TraceContext {
  std::string trace_id;
  std::string span_id;
  std::optional<std::string> parent_span_id;
  std::string trace_flags = "01";
  bool sampled = true;
};

class TraceScope final {
public:
  explicit TraceScope(TraceContext context);
  ~TraceScope();

  TraceScope(const TraceScope &) = delete;
  TraceScope &operator=(const TraceScope &) = delete;

  [[nodiscard]] const TraceContext &context() const noexcept;

private:
  TraceContext context_;
  const TraceContext *previous_ = nullptr;
};

struct MetricAttributes {
  std::string name;
  std::string kind;
  double value = 0.0;
  std::string unit;
  std::string temporality;
  Metadata metadata = {};
};

struct ActionAttributes {
  std::string name;
  std::string status;
  Metadata metadata = {};
};

struct ProductTimelineContext {
  std::optional<std::string> session_id;
  std::optional<std::string> screen;
  std::optional<std::string> trace_id;
  std::optional<std::string> funnel;
  std::optional<std::string> step;
  Metadata metadata = {};
};

struct ProductActionAttributes {
  std::string name;
  std::optional<std::string> status;
  ProductTimelineContext context = {};
  Metadata metadata = {};
};

struct NetworkMilestoneAttributes {
  std::string method;
  std::string route_template;
  std::optional<int> status_code;
  std::optional<double> duration_ms;
  std::optional<std::string> status;
  ProductTimelineContext context = {};
  Metadata metadata = {};
};

[[nodiscard]] TraceContext create_trace_context(std::string trace_flags = "01");
[[nodiscard]] TraceContext trace_context_from_traceparent(const std::string &traceparent);
[[nodiscard]] TraceContext continue_or_create_trace_context(const std::string &traceparent);
[[nodiscard]] OpenTelemetrySpanContext open_telemetry_span_context(
    std::string trace_id,
    std::string span_id,
    std::string trace_flags = "01");
[[nodiscard]] OpenTelemetrySpanContext open_telemetry_span_context_from_sampled(
    std::string trace_id,
    std::string span_id,
    bool sampled);
[[nodiscard]] TraceContext trace_context_from_opentelemetry_span_context(
    const OpenTelemetrySpanContext &context);
[[nodiscard]] const TraceContext *current_trace_context() noexcept;
[[nodiscard]] Metadata trace_metadata(const TraceContext *context = nullptr);
[[nodiscard]] ProductTimelineContext trace_product_timeline_context(
    ProductTimelineContext context,
    const TraceContext *trace = nullptr);
[[nodiscard]] SpanAttributes trace_span_attributes(
    std::string name,
    std::string status,
    std::optional<double> duration_ms = std::nullopt,
    const TraceContext *context = nullptr);
[[nodiscard]] SpanAttributes trace_span_attributes_from_opentelemetry_span_context(
    std::string name,
    std::string status,
    const OpenTelemetrySpanContext &context,
    std::optional<double> duration_ms = std::nullopt);
[[nodiscard]] std::map<std::string, std::string> traceparent_headers(const TraceContext *context = nullptr);

class RecordingTransport final : public Transport {
public:
  struct Step {
    enum class Kind {
      status,
      error,
    };

    Kind kind;
    int status_code = 0;
    std::string code;
    std::string message;
    bool retryable = false;

    static Step status_code_step(int status_code);
    static Step network_failure(std::string message);
  };

  explicit RecordingTransport(std::vector<Step> steps = {});

  TransportResponse send(const std::string &api_key, const std::string &body) override;

  [[nodiscard]] const std::vector<std::string> &sent_bodies() const noexcept;
  [[nodiscard]] const std::string *last_body() const noexcept;

private:
  std::vector<Step> steps_;
  std::size_t cursor_ = 0;
  std::vector<std::string> sent_bodies_;
};

class LogBrewClient final {
public:
  explicit LogBrewClient(Config config);

  [[nodiscard]] std::size_t pending_events() const noexcept;
  [[nodiscard]] std::string preview_json() const;

  TransportResponse flush(Transport &transport);
  TransportResponse shutdown(Transport &transport);

  void release(std::string id, std::string timestamp, ReleaseAttributes attributes);
  void environment(std::string id, std::string timestamp, EnvironmentAttributes attributes);
  void issue(std::string id, std::string timestamp, IssueAttributes attributes);
  void log(std::string id, std::string timestamp, LogAttributes attributes);
  void span(std::string id, std::string timestamp, SpanAttributes attributes);
  void metric(std::string id, std::string timestamp, MetricAttributes attributes);
  void action(std::string id, std::string timestamp, ActionAttributes attributes);
  void capture_product_action(std::string id, std::string timestamp, ProductActionAttributes attributes);
  void capture_network_milestone(std::string id, std::string timestamp, NetworkMilestoneAttributes attributes);

private:
  struct Event {
    std::string type;
    std::string timestamp;
    std::string id;
    std::string attributes_json;
  };

  [[nodiscard]] static std::string event_json(const Event &event);
  void push_event(std::string type, std::string id, std::string timestamp, std::string attributes_json);
  [[nodiscard]] TransportResponse flush_internal(Transport &transport);

  std::string api_key_;
  std::string sdk_name_;
  std::string sdk_version_;
  std::size_t max_retries_;
  bool closed_ = false;
  std::vector<Event> events_;
};

} // namespace logbrew

#endif
