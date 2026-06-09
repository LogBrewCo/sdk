# LogBrew C++ SDK

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
        {{"queue", "checkout"}}});
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms require `delta` or `cumulative` temporality and non-negative values; gauges require `instant` temporality. Keep metric metadata primitive and low-cardinality, such as stable route templates, queue names, feature names, regions, or coarse result categories. Do not attach user IDs, request IDs, per-session identifiers, raw URLs, payloads, or unbounded labels as metric metadata.

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

## Example Source

The `examples/readme_example.cpp` source shows a complete six-event payload and recording transport setup that you can copy into your own native application.
