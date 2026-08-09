#ifndef LOGBREW_CPP_HPP
#define LOGBREW_CPP_HPP

#include <array>
#include <cstddef>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace logbrew {

inline constexpr const char *version = "0.2.1";
inline constexpr const char *http_transport_default_endpoint = "https://api.logbrew.co/v1/events";
inline constexpr std::size_t trace_id_length = 32U;
inline constexpr std::size_t span_id_length = 16U;
inline constexpr std::size_t trace_flags_length = 2U;
inline constexpr std::size_t traceparent_length = 55U;
inline constexpr unsigned int telemetry_context_schema_version = 1U;
inline constexpr std::size_t max_context_tags = 32U;
inline constexpr std::size_t max_breadcrumbs = 64U;
inline constexpr std::size_t max_stack_frames = 32U;
inline constexpr std::size_t max_span_events = 8U;
inline constexpr std::size_t max_span_links = 8U;
inline constexpr std::size_t max_metadata_entries = 128U;
inline constexpr std::size_t max_metadata_key_length = 128U;
inline constexpr std::size_t max_metadata_string_length = 4096U;
inline constexpr std::size_t max_metric_description_length = 1024U;

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
  explicit HttpTransport(std::string endpoint = http_transport_default_endpoint, std::vector<HttpHeader> headers = {},
                         long timeout_ms = 10000L);

  TransportResponse send(const std::string &api_key, const std::string &body) override;

private:
  std::string endpoint_;
  std::vector<HttpHeader> headers_;
  long timeout_ms_;
};

struct NamedVersion {
  std::string name;
  std::optional<std::string> version;
};

struct DeploymentContext {
  std::optional<std::string> environment;
  std::optional<std::string> release;
};

struct OperatingSystemContext {
  std::string name;
  std::optional<std::string> version;
  std::optional<std::string> build;
};

struct DeviceContext {
  std::optional<std::string> family;
  std::optional<std::string> model;
  std::optional<std::string> architecture;
};

struct ApplicationContext {
  std::optional<std::string> name;
  std::optional<std::string> version;
  std::optional<std::string> build;
};

struct TelemetryResource {
  std::optional<NamedVersion> service;
  std::optional<DeploymentContext> deployment;
  std::optional<NamedVersion> runtime;
  std::optional<NamedVersion> framework;
  std::optional<OperatingSystemContext> operating_system;
  std::optional<DeviceContext> device;
  std::optional<ApplicationContext> application;
};

struct TelemetryTraceContext {
  std::string trace_id;
  std::optional<std::string> span_id;
  std::optional<std::string> parent_span_id;
  std::optional<bool> sampled;
};

struct SessionContext {
  std::string id;
  std::optional<std::string> previous_id;
};

enum class SubjectKind {
  anonymous,
  user,
};

struct SubjectContext {
  std::string id;
  SubjectKind kind = SubjectKind::anonymous;
};

using Tags = std::map<std::string, std::string>;

struct TelemetryContext {
  unsigned int schema_version = telemetry_context_schema_version;
  std::optional<TelemetryResource> resource;
  std::optional<TelemetryTraceContext> trace;
  std::optional<SessionContext> session;
  std::optional<SubjectContext> subject;
  Tags tags;
};

struct ClientOptions {
  std::optional<TelemetryContext> context;
  bool disable_automatic_context = false;
};

namespace detail {

template <typename Context> struct ScopeState {
  Context context;
  std::shared_ptr<ScopeState<Context>> previous;
  bool active = true;
};

} // namespace detail

class TelemetryScope final {
public:
  explicit TelemetryScope(TelemetryContext context);
  ~TelemetryScope();

  TelemetryScope(const TelemetryScope &) = delete;
  TelemetryScope &operator=(const TelemetryScope &) = delete;
  TelemetryScope(TelemetryScope &&) = delete;
  TelemetryScope &operator=(TelemetryScope &&) = delete;

  [[nodiscard]] const TelemetryContext &context() const noexcept;

private:
  std::shared_ptr<detail::ScopeState<TelemetryContext>> state_;
};

void validate_telemetry_context(const TelemetryContext &context);
[[nodiscard]] const TelemetryContext *current_telemetry_context() noexcept;

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

struct EventOptions {
  Metadata metadata = {};
  std::optional<TelemetryContext> context;
};

struct IssueMechanism {
  std::string type;
  bool handled = true;
};

struct IssueException {
  std::string type;
  std::optional<IssueMechanism> mechanism;
};

struct IssueStackFrame {
  std::string filename;
  unsigned int line = 0U;
  unsigned int column = 0U;
  std::optional<std::string> function;
  std::optional<std::string> module;
  std::optional<bool> in_app;
  std::optional<std::string> debug_id;
};

struct IssueBreadcrumb {
  std::string timestamp;
  std::optional<std::string> type;
  std::string category;
  std::optional<std::string> level;
  std::optional<std::string> message;
  Metadata data = {};
};

struct IssueDetails {
  std::optional<IssueException> exception;
  std::vector<IssueStackFrame> stack_frames;
  std::vector<IssueBreadcrumb> breadcrumbs;
  bool breadcrumbs_truncated = false;
};

struct SpanEvent {
  std::string name;
  std::optional<std::string> timestamp;
  Metadata metadata = {};
};

struct SpanLink {
  std::string trace_id;
  std::string span_id;
  std::optional<bool> sampled;
  Metadata metadata = {};
};

struct SpanEvidence {
  std::vector<SpanEvent> events;
  std::vector<SpanLink> links;
};

[[nodiscard]] IssueStackFrame issue_frame_from_location(std::string file, unsigned int line, unsigned int column,
                                                        std::optional<std::string> function = std::nullopt,
                                                        std::optional<std::string> module = std::nullopt,
                                                        bool in_app = true);

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
  TraceScope(TraceScope &&) = delete;
  TraceScope &operator=(TraceScope &&) = delete;

  [[nodiscard]] const TraceContext &context() const noexcept;

private:
  std::shared_ptr<detail::ScopeState<TraceContext>> state_;
};

struct MetricAttributes {
  std::string name;
  std::string kind;
  double value = 0.0;
  std::string unit;
  std::string temporality;
  Metadata metadata = {};
  std::optional<std::string> description = std::nullopt;
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
  std::optional<std::string> route_template;
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
[[nodiscard]] OpenTelemetrySpanContext open_telemetry_span_context(std::string trace_id, std::string span_id,
                                                                   std::string trace_flags = "01");
[[nodiscard]] OpenTelemetrySpanContext open_telemetry_span_context_from_sampled(std::string trace_id,
                                                                                std::string span_id, bool sampled);
template <typename OpenTelemetrySpanContextLike>
[[nodiscard]] std::optional<OpenTelemetrySpanContext>
try_open_telemetry_span_context_from_span_context(const OpenTelemetrySpanContextLike &context) {
  if (!context.IsValid()) {
    return std::nullopt;
  }
  std::array<char, trace_id_length> trace_id{};
  std::array<char, span_id_length> span_id{};
  std::array<char, trace_flags_length> trace_flags{};
  context.trace_id().ToLowerBase16(trace_id);
  context.span_id().ToLowerBase16(span_id);
  context.trace_flags().ToLowerBase16(trace_flags);
  try {
    return open_telemetry_span_context(std::string(trace_id.data(), trace_id.size()),
                                       std::string(span_id.data(), span_id.size()),
                                       std::string(trace_flags.data(), trace_flags.size()));
  } catch (const SdkException &) {
    return std::nullopt;
  }
}

template <typename OpenTelemetrySpanContextLike>
[[nodiscard]] OpenTelemetrySpanContext
open_telemetry_span_context_from_span_context(const OpenTelemetrySpanContextLike &context) {
  auto copied = try_open_telemetry_span_context_from_span_context(context);
  if (!copied.has_value()) {
    throw SdkException("validation_error", "OpenTelemetry span context is invalid");
  }
  return *copied;
}

template <typename OpenTelemetrySpanLike>
[[nodiscard]] std::optional<OpenTelemetrySpanContext>
try_open_telemetry_span_context_from_span(const OpenTelemetrySpanLike &span) {
  return try_open_telemetry_span_context_from_span_context(span.GetContext());
}

template <typename OpenTelemetrySpanLike>
[[nodiscard]] OpenTelemetrySpanContext open_telemetry_span_context_from_span(const OpenTelemetrySpanLike &span) {
  auto copied = try_open_telemetry_span_context_from_span(span);
  if (!copied.has_value()) {
    throw SdkException("validation_error", "OpenTelemetry span is invalid");
  }
  return *copied;
}

template <typename OpenTelemetrySpanPointerLike>
[[nodiscard]] std::optional<OpenTelemetrySpanContext>
try_open_telemetry_span_context_from_span_pointer(const OpenTelemetrySpanPointerLike &span) {
  if (!span) {
    return std::nullopt;
  }
  return try_open_telemetry_span_context_from_span(*span);
}

template <typename OpenTelemetrySpanPointerLike>
[[nodiscard]] OpenTelemetrySpanContext
open_telemetry_span_context_from_span_pointer(const OpenTelemetrySpanPointerLike &span) {
  auto copied = try_open_telemetry_span_context_from_span_pointer(span);
  if (!copied.has_value()) {
    throw SdkException("validation_error", "OpenTelemetry span pointer is invalid");
  }
  return *copied;
}

[[nodiscard]] TraceContext trace_context_from_opentelemetry_span_context(const OpenTelemetrySpanContext &context);
[[nodiscard]] const TraceContext *current_trace_context() noexcept;
[[nodiscard]] Metadata trace_metadata(const TraceContext *context = nullptr);
[[nodiscard]] ProductTimelineContext trace_product_timeline_context(ProductTimelineContext context,
                                                                    const TraceContext *trace = nullptr);
[[nodiscard]] SpanAttributes trace_span_attributes(std::string name, std::string status,
                                                   std::optional<double> duration_ms = std::nullopt,
                                                   const TraceContext *context = nullptr);
[[nodiscard]] SpanAttributes
trace_span_attributes_from_opentelemetry_span_context(std::string name, std::string status,
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
  LogBrewClient(Config config, ClientOptions options);

  [[nodiscard]] std::size_t pending_events() const noexcept;
  [[nodiscard]] std::string preview_json() const;

  TransportResponse flush(Transport &transport);
  TransportResponse shutdown(Transport &transport);

  void add_breadcrumb(IssueBreadcrumb breadcrumb);
  void clear_breadcrumbs() noexcept;

  void release(std::string id, std::string timestamp, ReleaseAttributes attributes);
  void release(std::string id, std::string timestamp, ReleaseAttributes attributes, EventOptions options);
  void environment(std::string id, std::string timestamp, EnvironmentAttributes attributes);
  void environment(std::string id, std::string timestamp, EnvironmentAttributes attributes, EventOptions options);
  void issue(std::string id, std::string timestamp, IssueAttributes attributes);
  void issue(std::string id, std::string timestamp, IssueAttributes attributes, EventOptions options);
  void issue(std::string id, std::string timestamp, IssueAttributes attributes, IssueDetails details,
             EventOptions options = {});
  void log(std::string id, std::string timestamp, LogAttributes attributes);
  void log(std::string id, std::string timestamp, LogAttributes attributes, EventOptions options);
  void span(std::string id, std::string timestamp, SpanAttributes attributes);
  void span(std::string id, std::string timestamp, SpanAttributes attributes, EventOptions options);
  void span(std::string id, std::string timestamp, SpanAttributes attributes, SpanEvidence evidence,
            EventOptions options = {});
  void metric(std::string id, std::string timestamp, MetricAttributes attributes);
  void metric(std::string id, std::string timestamp, MetricAttributes attributes, EventOptions options);
  void action(std::string id, std::string timestamp, ActionAttributes attributes);
  void action(std::string id, std::string timestamp, ActionAttributes attributes, EventOptions options);
  void capture_product_action(std::string id, std::string timestamp, ProductActionAttributes attributes);
  void capture_product_action(std::string id, std::string timestamp, ProductActionAttributes attributes,
                              EventOptions options);
  void capture_network_milestone(std::string id, std::string timestamp, NetworkMilestoneAttributes attributes);
  void capture_network_milestone(std::string id, std::string timestamp, NetworkMilestoneAttributes attributes,
                                 EventOptions options);

private:
  struct Event {
    std::string type;
    std::string timestamp;
    std::string id;
    std::string attributes_json;
  };

  [[nodiscard]] static std::string event_json(const Event &event);
  void push_event(std::string type, std::string id, std::string timestamp, std::string attributes_json,
                  const std::optional<TelemetryContext> &event_context, const SpanAttributes *signal_span = nullptr);
  [[nodiscard]] TransportResponse flush_internal(Transport &transport);

  std::string api_key_;
  std::string sdk_name_;
  std::string sdk_version_;
  std::size_t max_retries_;
  bool closed_ = false;
  std::vector<Event> events_;
  std::optional<TelemetryContext> base_context_;
  std::vector<IssueBreadcrumb> breadcrumbs_;
  bool breadcrumbs_truncated_ = false;
};

} // namespace logbrew

#endif
