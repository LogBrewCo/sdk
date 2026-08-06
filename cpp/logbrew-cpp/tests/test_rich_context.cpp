#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {

int tests_run = 0;

#define EXPECT_TRUE(condition)                                                                                         \
  do {                                                                                                                 \
    tests_run++;                                                                                                       \
    if (!(condition)) {                                                                                                \
      std::cerr << "test failed at " << __FILE__ << ':' << __LINE__ << ": " << #condition << '\n';                     \
      std::exit(1);                                                                                                    \
    }                                                                                                                  \
  } while (false)

template <typename Callback> void expect_validation_error(Callback callback) {
  try {
    callback();
    EXPECT_TRUE(false);
  } catch (const logbrew::SdkException &error) {
    EXPECT_TRUE(error.code() == "validation_error");
  }
}

std::size_t count_occurrences(const std::string &value, const std::string &needle) {
  std::size_t count = 0U;
  std::size_t offset = 0U;
  while ((offset = value.find(needle, offset)) != std::string::npos) {
    count++;
    offset += needle.size();
  }
  return count;
}

logbrew::Config config() { return logbrew::Config{"LOGBREW_API_KEY", "logbrew-cpp-rich-test", logbrew::version, 2U}; }

logbrew::TelemetryContext service_context() {
  logbrew::TelemetryResource resource;
  resource.service = logbrew::NamedVersion{"checkout-api", "2.4.0"};
  resource.deployment = logbrew::DeploymentContext{"production", "2026.08.06"};
  resource.framework = logbrew::NamedVersion{"checkout-runtime", "4.1.0"};
  resource.application = logbrew::ApplicationContext{"checkout-app", "8.2.0", "820"};

  logbrew::TelemetryContext context;
  context.resource = std::move(resource);
  context.session = logbrew::SessionContext{"session_current", "session_previous"};
  context.subject = logbrew::SubjectContext{"subject_opaque_42", logbrew::SubjectKind::user};
  context.tags = {{"region", "eu-central"}, {"tier", "gold"}};
  return context;
}

void automatic_context_is_conservative_and_optional() {
  logbrew::LogBrewClient automatic(config());
  automatic.log("evt_auto_context", "2026-08-06T10:00:00Z",
                logbrew::LogAttributes{"automatic context", "info", "runtime"});
  const std::string automatic_json = automatic.preview_json();
  EXPECT_TRUE(automatic_json.find("\"context\":{\"schemaVersion\":1") != std::string::npos);
  EXPECT_TRUE(automatic_json.find("\"runtime\":{\"name\":\"cpp\",\"version\":\"c++17\"}") != std::string::npos);
  EXPECT_TRUE(automatic_json.find("\"operatingSystem\":{\"name\":") != std::string::npos);
  EXPECT_TRUE(automatic_json.find("\"architecture\":") != std::string::npos);

  logbrew::ClientOptions disabled_options;
  disabled_options.disable_automatic_context = true;
  logbrew::LogBrewClient disabled(config(), disabled_options);
  disabled.log("evt_no_auto_context", "2026-08-06T10:00:01Z",
               logbrew::LogAttributes{"no automatic context", "info", "runtime"});
  EXPECT_TRUE(disabled.preview_json().find("\"context\":") == std::string::npos);
}

void context_layers_are_copied_and_merged_deterministically() {
  logbrew::TelemetryContext base = service_context();
  logbrew::ClientOptions client_options;
  client_options.context = base;
  client_options.disable_automatic_context = true;
  logbrew::LogBrewClient client(config(), client_options);

  base.resource->service->name = "mutated-after-client-copy";
  base.tags["tier"] = "mutated";

  logbrew::TelemetryContext scoped;
  scoped.resource = logbrew::TelemetryResource{};
  scoped.resource->deployment = logbrew::DeploymentContext{"canary", std::nullopt};
  scoped.tags = {{"scope", "worker"}, {"tier", "silver"}};
  logbrew::TelemetryScope telemetry_scope(scoped);
  scoped.tags["scope"] = "mutated-after-scope-copy";

  const auto trace = logbrew::trace_context_from_traceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");
  logbrew::TraceScope trace_scope(trace);

  logbrew::TelemetryContext event_context;
  event_context.resource = logbrew::TelemetryResource{};
  event_context.resource->service = logbrew::NamedVersion{"checkout-api", "2.5.0"};
  event_context.session = logbrew::SessionContext{"session_event", std::nullopt};
  event_context.tags = {{"scope", "event"}, {"feature", "payments"}};
  logbrew::EventOptions event_options;
  event_options.context = event_context;
  event_options.metadata = {{"attempt", 2}, {"cacheHit", false}, {"nullable", nullptr}};

  client.log("evt_context_precedence", "2026-08-06T10:01:00Z",
             logbrew::LogAttributes{"payment authorization failed", "error", "checkout"}, event_options);

  const std::string json = client.preview_json();
  EXPECT_TRUE(json.find("mutated-after-client-copy") == std::string::npos);
  EXPECT_TRUE(json.find("mutated-after-scope-copy") == std::string::npos);
  EXPECT_TRUE(json.find("\"service\":{\"name\":\"checkout-api\",\"version\":\"2.5.0\"}") != std::string::npos);
  EXPECT_TRUE(json.find("\"deployment\":{\"environment\":\"canary\","
                        "\"release\":\"2026.08.06\"}") != std::string::npos);
  EXPECT_TRUE(json.find("\"framework\":{\"name\":\"checkout-runtime\","
                        "\"version\":\"4.1.0\"}") != std::string::npos);
  EXPECT_TRUE(json.find("\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e4736\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"spanId\":\"" + trace.span_id + "\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"parentSpanId\":\"00f067aa0ba902b7\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"sampled\":true") != std::string::npos);
  EXPECT_TRUE(json.find("\"session\":{\"id\":\"session_event\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"subject\":{\"id\":\"subject_opaque_42\",\"kind\":\"user\"}") != std::string::npos);
  EXPECT_TRUE(json.find("\"feature\":\"payments\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"region\":\"eu-central\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"scope\":\"event\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"tier\":\"silver\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"attempt\":2") != std::string::npos);
  EXPECT_TRUE(json.find("\"cacheHit\":false") != std::string::npos);
  EXPECT_TRUE(json.find("\"nullable\":null") != std::string::npos);
}

void context_and_trace_scopes_do_not_resurrect_destroyed_outer_scopes() {
  logbrew::TelemetryContext outer_context;
  outer_context.tags = {{"scope", "outer"}};
  logbrew::TelemetryContext inner_context;
  inner_context.tags = {{"scope", "inner"}};

  auto outer = std::make_unique<logbrew::TelemetryScope>(outer_context);
  auto inner = std::make_unique<logbrew::TelemetryScope>(inner_context);
  EXPECT_TRUE(logbrew::current_telemetry_context() != nullptr);
  EXPECT_TRUE(logbrew::current_telemetry_context()->tags.at("scope") == "inner");
  outer.reset();
  EXPECT_TRUE(logbrew::current_telemetry_context() != nullptr);
  EXPECT_TRUE(logbrew::current_telemetry_context()->tags.at("scope") == "inner");
  inner.reset();
  EXPECT_TRUE(logbrew::current_telemetry_context() == nullptr);

  auto outer_trace = std::make_unique<logbrew::TraceScope>(logbrew::create_trace_context());
  auto inner_trace = std::make_unique<logbrew::TraceScope>(logbrew::create_trace_context());
  const std::string inner_trace_id = inner_trace->context().trace_id;
  outer_trace.reset();
  EXPECT_TRUE(logbrew::current_trace_context() != nullptr);
  EXPECT_TRUE(logbrew::current_trace_context()->trace_id == inner_trace_id);
  inner_trace.reset();
  EXPECT_TRUE(logbrew::current_trace_context() == nullptr);
}

void every_signal_accepts_event_metadata_and_typed_context() {
  logbrew::ClientOptions client_options;
  client_options.disable_automatic_context = true;
  logbrew::LogBrewClient client(config(), client_options);
  logbrew::EventOptions options;
  options.context = service_context();
  options.metadata = {{"receipt", "present"}};

  client.release("evt_release", "2026-08-06T10:02:00Z",
                 logbrew::ReleaseAttributes{"2.5.0", "abcdef123456", std::nullopt}, options);
  client.environment("evt_environment", "2026-08-06T10:02:01Z",
                     logbrew::EnvironmentAttributes{"production", "eu-central"}, options);
  client.issue("evt_issue", "2026-08-06T10:02:02Z", logbrew::IssueAttributes{"payment failed", "error", std::nullopt},
               options);
  client.log("evt_log", "2026-08-06T10:02:03Z", logbrew::LogAttributes{"payment failed", "error", "checkout"}, options);
  client.span("evt_span", "2026-08-06T10:02:04Z",
              logbrew::SpanAttributes{"POST /payments/{id}", "11111111111111111111111111111111", "2222222222222222",
                                      std::nullopt, "error", 41.5},
              options);
  client.metric("evt_metric", "2026-08-06T10:02:05Z",
                logbrew::MetricAttributes{"payment.duration", "histogram", 41.5, "ms", "delta", {}}, options);
  client.action("evt_action", "2026-08-06T10:02:06Z", logbrew::ActionAttributes{"payment.authorize", "failure", {}},
                options);
  client.capture_product_action("evt_product_action", "2026-08-06T10:02:07Z",
                                logbrew::ProductActionAttributes{"checkout.submit", "failure", {}, {}}, options);
  client.capture_network_milestone(
      "evt_network", "2026-08-06T10:02:08Z",
      logbrew::NetworkMilestoneAttributes{"POST", "/payments/{id}", 503, 41.5, std::nullopt, {}, {}}, options);

  const std::string json = client.preview_json();
  EXPECT_TRUE(count_occurrences(json, "\"context\":{\"schemaVersion\":1") == 9U);
  EXPECT_TRUE(count_occurrences(json, "\"receipt\":\"present\"") == 9U);
  EXPECT_TRUE(json.find("\"source\":\"cpp.product_action\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"source\":\"cpp.network\"") != std::string::npos);
}

void rich_issue_evidence_is_bounded_and_privacy_safe() {
  logbrew::ClientOptions client_options;
  client_options.context = service_context();
  client_options.disable_automatic_context = true;
  logbrew::LogBrewClient client(config(), client_options);

  for (std::size_t index = 0U; index < logbrew::max_breadcrumbs + 1U; index++) {
    client.add_breadcrumb(logbrew::IssueBreadcrumb{
        "2026-08-06T10:03:00Z",
        "http",
        "payment.request." + std::to_string(index),
        "info",
        "request milestone " + std::to_string(index),
        {{"attempt", static_cast<int>(index)}},
    });
  }

  logbrew::IssueStackFrame frame =
      logbrew::issue_frame_from_location("/workspace/source/payment.cpp?redaction_canary=value#fragment", 413U, 9U,
                                         "authorize_payment", "checkout.payment", true);
  frame.debug_id = "12345678-1234-1234-1234-123456789abc";

  logbrew::IssueDetails details;
  details.exception = logbrew::IssueException{
      "PaymentDeclined",
      logbrew::IssueMechanism{"signal", false},
  };
  details.stack_frames = {frame};
  details.breadcrumbs = {
      logbrew::IssueBreadcrumb{
          "2026-08-06T10:03:01Z",
          "state",
          "payment.decision",
          "error",
          "authorization rejected",
          {{"retryable", false}},
      },
  };

  client.issue("evt_rich_issue", "2026-08-06T10:03:02Z",
               logbrew::IssueAttributes{"Payment authorization failed", "critical", std::nullopt}, details);

  const std::string json = client.preview_json();
  EXPECT_TRUE(json.find("\"exception\":{\"type\":\"PaymentDeclined\",\"mechanism\":{"
                        "\"type\":\"signal\",\"handled\":false}") != std::string::npos);
  EXPECT_TRUE(json.find("\"filename\":\"payment.cpp\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"function\":\"authorize_payment\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"module\":\"checkout.payment\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"inApp\":true") != std::string::npos);
  EXPECT_TRUE(json.find("\"debugId\":\"12345678-1234-1234-1234-123456789abc\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"category\":\"payment.request.0\"") == std::string::npos);
  EXPECT_TRUE(json.find("\"category\":\"payment.request.1\"") == std::string::npos);
  EXPECT_TRUE(json.find("\"category\":\"payment.request.65\"") == std::string::npos);
  EXPECT_TRUE(json.find("\"category\":\"payment.request.64\"") != std::string::npos);
  EXPECT_TRUE(json.find("payment.decision") != std::string::npos);
  EXPECT_TRUE(json.find("\"breadcrumbsTruncated\":true") != std::string::npos);
  EXPECT_TRUE(json.find("/private/workspace") == std::string::npos);
  EXPECT_TRUE(json.find("redaction_canary") == std::string::npos);

  logbrew::IssueDetails unsafe_details;
  unsafe_details.stack_frames = {
      logbrew::IssueStackFrame{
          "/private/workspace/payment.cpp",
          1U,
          1U,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          std::nullopt,
      },
  };
  expect_validation_error([&] {
    client.issue("evt_unsafe_frame", "2026-08-06T10:03:03Z",
                 logbrew::IssueAttributes{"unsafe frame", "error", std::nullopt}, unsafe_details);
  });
}

void span_events_and_links_are_structured_and_bounded() {
  logbrew::LogBrewClient client(config());
  logbrew::SpanEvidence evidence;
  evidence.events = {
      logbrew::SpanEvent{
          "payment.authorization.rejected",
          "2026-08-06T10:04:00Z",
          {{"provider", "gateway"}},
      },
  };
  evidence.links = {
      logbrew::SpanLink{
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "BBBBBBBBBBBBBBBB",
          false,
          {{"relationship", "retry_of"}},
      },
  };
  client.span("evt_rich_span", "2026-08-06T10:04:01Z",
              logbrew::SpanAttributes{"POST /payments/{id}/authorize", "11111111111111111111111111111111",
                                      "2222222222222222", "3333333333333333", "error", 184.5},
              evidence, logbrew::EventOptions{{{"route", "/payments/{id}/authorize"}}, std::nullopt});

  const std::string json = client.preview_json();
  EXPECT_TRUE(json.find("\"events\":[{\"name\":\"payment.authorization."
                        "rejected\",\"timestamp\":\"2026-08-06T10:04:00Z\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"links\":[{\"traceId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
                        "\"spanId\":\"bbbbbbbbbbbbbbbb\",\"sampled\":false") != std::string::npos);
  EXPECT_TRUE(json.find("\"relationship\":\"retry_of\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"route\":\"/payments/{id}/authorize\"") != std::string::npos);
  EXPECT_TRUE(json.find("\"context\":{\"schemaVersion\":1") != std::string::npos);

  logbrew::SpanEvidence too_many;
  too_many.events.resize(logbrew::max_span_events + 1U);
  for (auto &event : too_many.events) {
    event.name = "bounded.event";
  }
  expect_validation_error([&] {
    client.span("evt_too_many_span_events", "2026-08-06T10:04:02Z",
                logbrew::SpanAttributes{"bounded span", "11111111111111111111111111111111", "2222222222222222",
                                        std::nullopt, "ok", std::nullopt},
                too_many);
  });
}

void context_metadata_and_identifier_bounds_fail_before_queue_admission() {
  logbrew::ClientOptions disabled;
  disabled.disable_automatic_context = true;
  logbrew::LogBrewClient client(config(), disabled);

  logbrew::TelemetryContext empty;
  expect_validation_error([&] { logbrew::TelemetryScope scope(empty); });

  logbrew::TelemetryContext invalid_version;
  invalid_version.schema_version = 2U;
  invalid_version.tags = {{"valid", "value"}};
  expect_validation_error([&] { logbrew::TelemetryScope scope(invalid_version); });

  logbrew::TelemetryContext too_many_tags;
  for (std::size_t index = 0U; index < logbrew::max_context_tags + 1U; index++) {
    too_many_tags.tags["tag" + std::to_string(index)] = "value";
  }
  expect_validation_error([&] { logbrew::TelemetryScope scope(too_many_tags); });

  logbrew::EventOptions too_much_metadata;
  for (std::size_t index = 0U; index < logbrew::max_metadata_entries + 1U; index++) {
    too_much_metadata.metadata["key" + std::to_string(index)] = static_cast<int>(index);
  }
  expect_validation_error([&] {
    client.log("evt_too_much_metadata", "2026-08-06T10:05:00Z", logbrew::LogAttributes{"bounded", "info", std::nullopt},
               too_much_metadata);
  });
  EXPECT_TRUE(client.pending_events() == 0U);

  logbrew::TraceContext inconsistent{
      "11111111111111111111111111111111", "2222222222222222", std::nullopt, "00", true,
  };
  expect_validation_error([&] { logbrew::TraceScope scope(inconsistent); });

  logbrew::EventOptions oversized_string;
  oversized_string.metadata = {{"value", std::string(logbrew::max_metadata_string_length + 1U, 'x')}};
  expect_validation_error([&] {
    client.log("evt_oversized_metadata", "2026-08-06T10:05:01Z",
               logbrew::LogAttributes{"bounded", "info", std::nullopt}, oversized_string);
  });

  logbrew::IssueBreadcrumb oversized_breadcrumb{
      "2026-08-06T10:05:02Z", "state", "bounded.breadcrumb", "info", std::nullopt, {},
  };
  for (std::size_t index = 0U; index < 9U; index++) {
    oversized_breadcrumb.data["key" + std::to_string(index)] = static_cast<int>(index);
  }
  expect_validation_error([&] { client.add_breadcrumb(oversized_breadcrumb); });

  logbrew::IssueDetails too_many_frames;
  too_many_frames.stack_frames.resize(logbrew::max_stack_frames + 1U);
  for (auto &frame : too_many_frames.stack_frames) {
    frame = logbrew::IssueStackFrame{"checkout.cpp", 1U, 1U, std::nullopt, std::nullopt, true, std::nullopt};
  }
  expect_validation_error([&] {
    client.issue("evt_too_many_frames", "2026-08-06T10:05:03Z",
                 logbrew::IssueAttributes{"bounded frames", "error", std::nullopt}, too_many_frames);
  });

  logbrew::SpanEvidence invalid_link;
  invalid_link.links = {{"not-a-trace", "not-a-span", std::nullopt, {}}};
  expect_validation_error([&] {
    client.span("evt_invalid_link", "2026-08-06T10:05:04Z",
                logbrew::SpanAttributes{"bounded span", "11111111111111111111111111111111", "2222222222222222",
                                        std::nullopt, "ok", std::nullopt},
                invalid_link);
  });

  for (const auto &invalid_network : std::vector<logbrew::NetworkMilestoneAttributes>{
           {"POST\r\nInjected", "/payments", std::nullopt, std::nullopt, std::nullopt, {}, {}},
           {"POST", "//example.test/payments", std::nullopt, std::nullopt, std::nullopt, {}, {}},
           {"POST", "ftp://example.test/payments", std::nullopt, std::nullopt, std::nullopt, {}, {}},
           {"POST", "payments/{id}", std::nullopt, std::nullopt, std::nullopt, {}, {}},
           {"POST", "https://user@example.test/payments", std::nullopt, std::nullopt, std::nullopt, {}, {}},
           {"POST", "https://example.test\\payments", std::nullopt, std::nullopt, std::nullopt, {}, {}},
       }) {
    expect_validation_error(
        [&] { client.capture_network_milestone("evt_invalid_network", "2026-08-06T10:05:05Z", invalid_network); });
  }

  logbrew::TelemetryContext full_tag_context;
  for (std::size_t index = 0U; index < logbrew::max_context_tags; index++) {
    full_tag_context.tags["tag" + std::to_string(index)] = "value";
  }
  logbrew::ClientOptions full_tag_options;
  full_tag_options.context = full_tag_context;
  full_tag_options.disable_automatic_context = true;
  logbrew::LogBrewClient full_tag_client(config(), full_tag_options);
  logbrew::TelemetryContext extra_tag_context;
  extra_tag_context.tags = {{"overflow", "value"}};
  logbrew::TelemetryScope extra_tag_scope(extra_tag_context);
  expect_validation_error([&] {
    full_tag_client.log("evt_merged_tag_overflow", "2026-08-06T10:05:06Z",
                        logbrew::LogAttributes{"bounded tags", "info", std::nullopt});
  });
  EXPECT_TRUE(full_tag_client.pending_events() == 0U);
  EXPECT_TRUE(client.pending_events() == 0U);
}

} // namespace

int main() {
  automatic_context_is_conservative_and_optional();
  context_layers_are_copied_and_merged_deterministically();
  context_and_trace_scopes_do_not_resurrect_destroyed_outer_scopes();
  every_signal_accepts_event_metadata_and_typed_context();
  rich_issue_evidence_is_bounded_and_privacy_safe();
  span_events_and_links_are_structured_and_bounded();
  context_metadata_and_identifier_bounds_fail_before_queue_admission();
  std::cout << "c++ rich context tests ok (" << tests_run << " checks)\n";
  return 0;
}
