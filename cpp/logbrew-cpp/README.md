# LogBrew C++ SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public C++17 SDK for building, validating, previewing, and sending LogBrew event batches from native applications.

The SDK is dependency-free and ships as source plus header. Add `include/logbrew.hpp` and `src/logbrew.cpp` to your application build:

```bash
c++ -std=c++17 -Wall -Wextra -Wpedantic -Iinclude src/logbrew.cpp your_app.cpp -o your_app
```

## Minimal Usage

```cpp
#include "logbrew.hpp"

logbrew::LogBrewClient client(
    logbrew::Config{"LOGBREW_API_KEY", "logbrew-cpp", logbrew::version, 2});

client.release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    logbrew::ReleaseAttributes{"1.2.3", "abc123def456", "Public release marker"});

logbrew::RecordingTransport transport;
logbrew::TransportResponse response = client.flush(transport);
```

`logbrew::SdkException` exposes a stable `code()` plus the exception message. `logbrew::Transport` is an abstract callback surface for app-owned delivery, while `logbrew::RecordingTransport` lets your app inspect queued JSON before network delivery.

## Sending To LogBrew

Use `logbrew::HttpTransport` when your application is ready to send events to the hosted LogBrew intake:

```cpp
logbrew::HttpTransport transport(
    logbrew::http_transport_default_endpoint,
    {{"x-logbrew-source", "native-cpp-app"}},
    10000L);

logbrew::TransportResponse response = client.flush(transport);
```

The HTTP transport is optional and uses libcurl. Keep the default source build dependency-free if your app only previews payloads or supplies its own transport:

```bash
c++ -std=c++17 -Wall -Wextra -Wpedantic \
  -Iinclude $(curl-config --cflags) \
  src/logbrew.cpp src/logbrew_http_transport.cpp your_app.cpp \
  $(curl-config --libs) \
  -o your_app
```

`HttpTransport` validates `http://` and `https://` endpoints, sends `authorization: Bearer <api key>` and `content-type: application/json`, rejects custom overrides for those reserved headers, supports safe additional headers, and maps libcurl request failures into retryable transport errors. It does not patch global HTTP clients, inspect application traffic, collect request or response payloads, or capture arbitrary headers from your app.

## Rich Investigation Context

Use `TelemetryContext` to give people and AI coding assistants the stable facts needed to connect an issue, log, trace, action, release, and metric without repeating unstructured metadata on every event.

```cpp
logbrew::TelemetryResource resource;
resource.service = logbrew::NamedVersion{"checkout-api", "2.4.0"};
resource.deployment = logbrew::DeploymentContext{"production", "2026.08.06"};
resource.framework = logbrew::NamedVersion{"checkout-runtime", "4.1.0"};

logbrew::TelemetryContext context;
context.resource = resource;
context.session = logbrew::SessionContext{"session_opaque_current", std::nullopt};
context.subject = logbrew::SubjectContext{"subject_opaque_42", logbrew::SubjectKind::user};
context.tags = {{"region", "eu-central"}, {"tier", "gold"}};

logbrew::ClientOptions client_options;
client_options.context = context;
logbrew::LogBrewClient client(
    logbrew::Config{"LOGBREW_API_KEY", "checkout-native", logbrew::version, 2},
    client_options);
```

The default client adds only conservative process facts that are safe and useful across events: the C++ language level, OS family, and CPU architecture. It never infers user or account identity, machine-unique values, location, or application-owned values. Set `ClientOptions::disable_automatic_context` when even those process facts are not appropriate.

`TelemetryScope` adds a copied thread-local layer for one request or operation. `EventOptions` can add final per-event metadata and context:

```cpp
logbrew::TelemetryContext operation;
operation.tags = {{"worker", "payment-authorizer"}};
logbrew::TelemetryScope scope(operation);

logbrew::EventOptions event_options;
event_options.metadata = {{"attempt", 2}, {"cacheHit", false}};
event_options.context = logbrew::TelemetryContext{
    logbrew::telemetry_context_schema_version,
    std::nullopt,
    std::nullopt,
    logbrew::SessionContext{"session_opaque_retry", "session_opaque_current"},
    std::nullopt,
    {{"feature", "payments"}},
};

client.log(
    "evt_payment_retry",
    "2026-08-06T10:01:00Z",
    logbrew::LogAttributes{"payment authorization retry", "warning", "checkout"},
    event_options);
```

Context precedence is deterministic: conservative automatic facts, client context, the active `TelemetryScope`, active W3C `TraceScope`, the span's own identity for span events, then the event override. Values are copied at client/scope construction, tags merge by key, and the final payload is validated before queue admission.

## Issue Evidence

Issues can include type-only exception identity, mechanism and handled state, structured source frames, and the newest 64 privacy-safe breadcrumbs:

```cpp
client.add_breadcrumb(logbrew::IssueBreadcrumb{
    "2026-08-06T10:01:05Z",
    "http",
    "payment.request",
    "info",
    "authorization request completed",
    {{"statusClass", "5xx"}},
});

logbrew::IssueDetails details;
details.exception = logbrew::IssueException{
    "PaymentDeclined",
    logbrew::IssueMechanism{"signal", false},
};
details.stack_frames = {logbrew::issue_frame_from_location(
    __FILE__, __LINE__, 1U, "authorize_payment", "checkout.payment", true)};

client.issue(
    "evt_payment_failed",
    "2026-08-06T10:01:06Z",
    logbrew::IssueAttributes{"Payment authorization failed", "error", std::nullopt},
    details);
```

`issue_frame_from_location(...)` removes query and fragment data and keeps only the source basename. Manually supplied absolute frame paths are rejected. Breadcrumbs allow at most eight flat primitive data values each; the client retains the newest 64 and emits `breadcrumbsTruncated` when older evidence was dropped. Exception messages, raw stacks, locals, arguments, request bodies, and environment values are never inferred.

Portable C++ has no universal nested-exception interface. When application
code owns that evidence, set `IssueDetails::exception_chain` with one to eight
parent-first `IssueExceptionChainEntry` values. Relationships, message states,
stack states, and the reported root are validated against the legacy
exception/frames before queue admission, so the SDK preserves a useful graph
without guessing from `what()` text. See the shared
[exception-chain contract](../../docs/exception-chain-evidence.md).

## Span Evidence

Attach bounded milestones and causal links when a trace needs more than timing and status:

```cpp
logbrew::SpanEvidence evidence;
evidence.events = {{
    "payment.authorization.rejected",
    "2026-08-06T10:01:05.900Z",
    {{"provider", "gateway"}},
}};
evidence.links = {{
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbb",
    false,
    {{"relationship", "retry_of"}},
}};

client.span(
    "evt_payment_span",
    "2026-08-06T10:01:07Z",
    logbrew::SpanAttributes{
        "POST /payments/{id}/authorize",
        "11111111111111111111111111111111",
        "2222222222222222",
        "3333333333333333",
        "error",
        184.5,
    },
    evidence);
```

Each span accepts at most eight events and eight links. Link identifiers must be non-zero W3C hex values and are normalized to lowercase. Event and link metadata is flat, primitive, finite, and bounded.

Across all signals, event metadata is limited to 128 entries, keys to 128 bytes, strings to 4096 bytes, and context tags to 32 low-cardinality entries. Screenshots, attachments, replay, view hierarchy, raw stack text, and automatic user identity are not part of this SDK contract.

## Metrics

Use `client.metric(...)` for explicit application-owned measurements that should appear alongside logs, errors, traces, and product timelines.

```cpp
client.metric(
    "evt_metric_queue_depth",
    "2026-06-02T10:00:06Z",
    logbrew::MetricAttributes{
        "queue.depth",
        "gauge",
        42.0,
        "{items}",
        "instant",
        {{"queue", "checkout"}},
        std::string{"Number of work items currently waiting in the checkout queue."}});
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms require `delta` or `cumulative` temporality and non-negative values; gauges require `instant` temporality. The optional `description` is trimmed, limited to 1024 Unicode scalar values, and must explain the metric's stable generic meaning. It is not a query dimension: do not put identifiers, personal data, request values, or other changing content in it. Keep metric metadata primitive and low-cardinality, such as stable route templates, queue names, feature names, regions, or coarse result categories. Do not attach user IDs, request IDs, per-session identifiers, raw URLs, payloads, or unbounded labels as metric metadata.

The C++ SDK does not automatically collect runtime or framework metrics. Add the measurements your application owns, then send them with the same `client.flush(...)` path as other events.

## Product Timelines

Use product timeline helpers when you want LogBrew and AI coding assistants to understand what happened inside a user flow without recording the screen or collecting request payloads.

```cpp
logbrew::ProductTimelineContext context;
context.session_id = "session_123";
context.screen = "Checkout";
context.trace_id = "trace_001";
context.funnel = "checkout";
context.step = "submit";

logbrew::ProductActionAttributes action;
action.name = "checkout submit";
action.context = context;
action.metadata = {{"component", "pay-button"}};
client.capture_product_action("evt_action_checkout_submit", "2026-06-02T10:00:06Z", action);

logbrew::NetworkMilestoneAttributes network;
network.method = "POST";
network.route_template = "/checkout/confirm";
network.status_code = 503;
network.duration_ms = 42.75;
network.context = context;
client.capture_network_milestone("evt_network_checkout_confirm", "2026-06-02T10:00:07Z", network);
```

Timeline helpers are app-owned and explicit. They do not patch HTTP clients, auto-capture clicks, collect request or response bodies, capture headers, or include URL query strings and hashes. Keep metadata primitive and low-cardinality, such as `sessionId`, `screen`, `traceId`, `funnel`, `step`, status codes, durations, and stable route templates.

## W3C Trace Correlation

Use `TraceContext` and `TraceScope` when one native request or operation should connect logs, issues, product actions, metrics, spans, and downstream calls into the same trace:

```cpp
auto trace = logbrew::continue_or_create_trace_context(incomingTraceparent);
logbrew::TraceScope scope(trace);

client.log(
    "evt_log_checkout_failed",
    "2026-06-02T10:00:03Z",
    logbrew::LogAttributes{"checkout failed", "warning", "checkout"});

client.span(
    "evt_span_checkout",
    "2026-06-02T10:00:04Z",
    logbrew::trace_span_attributes("POST /checkout/{cart_id}", "error", 37.5));

auto headers = logbrew::traceparent_headers();
```

`trace_context_from_traceparent(...)` strictly validates the W3C `version-traceId-parentSpanId-traceFlags` shape, rejects forbidden and all-zero IDs, normalizes IDs to lowercase, preserves sampled state, and creates a fresh local span ID. `continue_or_create_trace_context(...)` falls back to a local root trace when the incoming value is missing or malformed, so bad propagation does not break application work.

If your application already owns an OpenTelemetry C++ span context, copy only its W3C trace ID, span ID, and trace flags into LogBrew:

```cpp
std::string otelTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
std::string otelSpanId = "00f067aa0ba902b7";
std::string otelTraceFlags = "01";

auto otel_parent = logbrew::open_telemetry_span_context(
    otelTraceId,    // 32 lowercase or uppercase hex chars from your OTel SpanContext
    otelSpanId,     // 16 lowercase or uppercase hex chars from your OTel SpanContext
    otelTraceFlags  // W3C trace flags, such as "01" or "00"
);

auto logbrew_trace = logbrew::trace_context_from_opentelemetry_span_context(otel_parent);
logbrew::TraceScope scope(logbrew_trace);
```

If your app already includes OpenTelemetry C++ headers, you can also copy a live OTel context without adding OpenTelemetry to LogBrew itself:

```cpp
auto maybe_parent = logbrew::try_open_telemetry_span_context_from_span_pointer(
    opentelemetry::trace::Tracer::GetCurrentSpan());

if (maybe_parent.has_value()) {
  logbrew::TraceScope scope(logbrew::trace_context_from_opentelemetry_span_context(*maybe_parent));
  client.log("evt_log_checkout_failed", "2026-06-02T10:00:03Z",
             logbrew::LogAttributes{"checkout failed", "warning", "checkout"});
}
```

For explicit OTel objects, use `try_open_telemetry_span_context_from_span_context(...)`, `try_open_telemetry_span_context_from_span(...)`, or `try_open_telemetry_span_context_from_span_pointer(...)`. The throwing variants use the same names without `try_` and raise `SdkException("validation_error", ...)` for invalid or absent OTel spans.

`OpenTelemetrySpanContext` is dependency-free and accepts the stable string values your app reads from its own OTel objects, or the validated IDs copied by the template adapters above. It creates a fresh LogBrew child span under the OTel parent and can also feed `trace_span_attributes_from_opentelemetry_span_context(...)` for a single explicit span event. It does not install OpenTelemetry, read tracestate or baggage, patch HTTP clients, capture payloads, copy arbitrary headers, or serialize raw propagation metadata.

When a `TraceScope` is active, `LogBrewClient` adds normalized typed trace context to every signal and preserves the existing primitive `traceId`, `spanId`, `parentSpanId`, `sampled`, and `traceFlags` metadata projection on issue, log, action, and metric events for compatibility. `trace_span_attributes(...)` reuses the same active span ID for an explicit span event, `trace_product_timeline_context(...)` adds the active trace ID to product timelines, and `traceparent_headers()` returns only a normalized `traceparent` header for app-owned outbound requests. These helpers do not patch HTTP clients, capture request/response payloads, serialize raw incoming propagation headers, or include URL query strings and hashes.

## Example Source

The `examples/readme_example.cpp` source shows a complete six-event payload and recording transport setup that you can copy into your own native application. `examples/trace_correlation.cpp` shows one copied OpenTelemetry parent span connecting a C++ issue, log, action, span, metric, product action, network milestone, and outgoing W3C `traceparent`.
