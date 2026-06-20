# LogBrew C SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public C99 SDK for building, validating, previewing, and flushing LogBrew event batches from native applications.

The SDK ships as source plus header. Add `include/logbrew.h` and the core files under `src/` to your application build:

```bash
cc -std=c99 -Wall -Wextra -Wpedantic -Iinclude \
  src/logbrew.c src/logbrew_metric.c src/logbrew_recording_transport.c src/logbrew_timeline.c src/logbrew_trace.c \
  your_app.c -o your_app
```

## Minimal Usage

```c
#include "logbrew.h"

LogBrewClient *client = NULL;
LogBrewError error;
LogBrewConfig config = {
  "LOGBREW_API_KEY",
  "logbrew-c",
  LOGBREW_C_VERSION,
  2U
};

logbrew_error_clear(&error);
if (logbrew_client_new(config, &client, &error) != LOGBREW_OK) {
  /* error.code and error.message are stable public fields */
}

logbrew_client_release(
    client,
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    (LogBrewReleaseAttributes){"1.2.3", "abc123def456", "Public release marker"},
    &error);

LogBrewRecordingTransport transport;
LogBrewTransportResponse response;
logbrew_recording_transport_init(&transport, NULL, 0U);
logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
logbrew_recording_transport_free(&transport);

logbrew_client_free(client);
```

## Metrics

Use `logbrew_client_metric()` for explicit application-owned measurements that should appear alongside logs, errors, traces, and product timelines.

```c
LogBrewMetadataEntry metric_metadata[] = {
  LOGBREW_METADATA_STRING_VALUE("queue", "checkout")
};

logbrew_client_metric(
    client,
    "evt_metric_queue_depth",
    "2026-06-02T10:00:06Z",
    (LogBrewMetricAttributes){
      "queue.depth",
      "gauge",
      42.0,
      "{items}",
      "instant",
      {metric_metadata, sizeof(metric_metadata) / sizeof(metric_metadata[0])}
    },
    &error);
```

Metric `kind` must be `counter`, `gauge`, or `histogram`. Gauges use `instant` temporality; counters and histograms use `delta` or `cumulative` temporality and must be non-negative. Values must be finite, units must be non-empty, and metadata should stay low-cardinality: service, queue, route template, or feature flag names are appropriate; user IDs, raw URLs, per-session identifiers, request IDs, headers, and payload fields are not.

This SDK does not automatically collect native runtime, process, or framework metrics yet. Add only the measurements your app owns and wants LogBrew to correlate with logs, errors, traces, and product timelines.

## W3C Trace Correlation

Use the trace helpers when a native C service or app receives a W3C `traceparent` value and wants logs, errors, actions, metrics, spans, and outgoing calls to line up on one trace. The helper validates the incoming context, rejects all-zero IDs, normalizes IDs to lowercase, and creates a fresh local span ID for this process.

```c
LogBrewTraceContext trace;
LogBrewTraceScope scope;
LogBrewSpanAttributes span;
LogBrewMetadataEntry trace_entries[LOGBREW_TRACE_METADATA_ENTRY_COUNT];
LogBrewMetadata trace_metadata;
char traceparent[LOGBREW_TRACEPARENT_LENGTH + 1U];

logbrew_trace_context_from_traceparent(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    &trace,
    &error);
logbrew_trace_scope_enter(&scope, &trace, &error);

logbrew_client_log(
    client,
    "evt_log_checkout",
    "2026-06-02T10:00:03Z",
    (LogBrewLogAttributes){"checkout failed", "warning", "checkout"},
    &error);

logbrew_trace_span_attributes(&trace, "POST /checkout/{cart_id}", "error", 37.5, true, &span, &error);
logbrew_client_span(client, "evt_span_checkout", "2026-06-02T10:00:04Z", span, &error);

trace_metadata = logbrew_trace_metadata(&trace, trace_entries);
logbrew_client_metric(
    client,
    "evt_metric_request_duration",
    "2026-06-02T10:00:05Z",
    (LogBrewMetricAttributes){"http.server.duration", "histogram", 37.5, "ms", "delta", trace_metadata},
    &error);

logbrew_trace_create_headers(&trace, traceparent, &error);
logbrew_trace_scope_exit(&scope);
```

If your app already runs OpenTelemetry, copy the active OTel span context into the dependency-free LogBrew carrier. Pass only the W3C trace ID, span ID, and trace flags from your app-owned OTel context; LogBrew validates and lowercases them, creates a fresh child span ID, and does not capture baggage, tracestate, headers, or payloads:

```c
LogBrewOpenTelemetrySpanContext otel_parent = {
  "4bf92f3577b34da6a3ce929d0e0e4736",
  "00f067aa0ba902b7",
  "01"
};
LogBrewTraceContext otel_child;
LogBrewTraceContext otel_span_context;
LogBrewSpanAttributes otel_span;

logbrew_trace_context_from_opentelemetry_span_context(otel_parent, &otel_child, &error);
logbrew_trace_span_attributes_from_opentelemetry_span_context(
    "GET /otel-parent",
    "ok",
    otel_parent,
    12.0,
    true,
    &otel_span_context,
    &otel_span,
    &error);
logbrew_client_span(client, "evt_span_otel_parent", "2026-06-02T10:00:06Z", otel_span, &error);
```

For app-owned outbound HTTP calls, create a child span before the call, attach only the generated `traceparent`, and finish the span after your HTTP client returns:

```c
LogBrewHttpClientSpan outbound;
LogBrewSpanAttributes outbound_span;

logbrew_trace_http_client_span_start(
    &trace,
    "POST",
    "/v1/payments/{payment_id}",
    &outbound,
    &error);

/* Add outbound.traceparent to the request you own, then execute the request. */

logbrew_trace_http_client_span_attributes(
    &outbound,
    503,
    true,
    false,
    42.75,
    true,
    &outbound_span,
    &error);
logbrew_client_span(client, "evt_span_payments_http", "2026-06-02T10:00:06Z", outbound_span, &error);
```

If your app already measures request phases, send those fixed values as primitive network milestone metadata using the same privacy-bounded keys across LogBrew SDKs:

```c
LogBrewMetadataEntry request_timing_metadata[] = {
  LOGBREW_METADATA_NUMBER_VALUE("requestQueuedMs", 1.25),
  LOGBREW_METADATA_NUMBER_VALUE("requestNameLookupMs", 2.5),
  LOGBREW_METADATA_NUMBER_VALUE("requestConnectMs", 4.0),
  LOGBREW_METADATA_NUMBER_VALUE("requestTlsMs", 8.5),
  LOGBREW_METADATA_NUMBER_VALUE("requestSendMs", 3.25),
  LOGBREW_METADATA_NUMBER_VALUE("requestWaitMs", 12.75),
  LOGBREW_METADATA_NUMBER_VALUE("requestReceiveMs", 5.25),
  LOGBREW_METADATA_NUMBER_VALUE("responseBodyBytes", 2048.0)
};

logbrew_client_network_milestone(
    client,
    "evt_network_payments",
    "2026-06-02T10:00:07Z",
    (LogBrewNetworkMilestoneAttributes){
      "POST",
      "/v1/payments/{payment_id}",
      503,
      true,
      42.75,
      true,
      logbrew_trace_product_timeline_context(&trace, (LogBrewProductTimelineContext){0}),
      {request_timing_metadata, sizeof(request_timing_metadata) / sizeof(request_timing_metadata[0])}
    },
    &error);
```

While a `LogBrewTraceScope` is active, `logbrew_client_issue()`, `logbrew_client_log()`, and `logbrew_client_action()` automatically include trace metadata. For metrics and product timeline helpers, use `logbrew_trace_metadata()` or `logbrew_trace_product_timeline_context()` so the correlation stays explicit at the call site.

`logbrew_trace_continue_or_create_context()` is useful for request boundaries: valid incoming W3C context is continued; missing or malformed context falls back to a fresh local root without failing the request. `logbrew_trace_http_client_span_start()` creates a child span name from an HTTP method and sanitized route template, stripping query strings and fragments even when a full URL is passed. The SDK never serializes the raw incoming `traceparent` into telemetry, does not patch HTTP clients, and does not capture headers, request bodies, response bodies, raw URLs, query strings, or fragments.

## Product Timelines

Use product timeline helpers when your native app owns meaningful user-flow steps or API milestones that should line up with logs, errors, spans, and traces. They enqueue normal LogBrew `action` events with primitive metadata so LogBrew and AI agents can analyze many sessions without visual replay:

```c
LogBrewMetadataEntry metadata[] = {
  LOGBREW_METADATA_NUMBER_VALUE("cartValue", 42.5),
  LOGBREW_METADATA_BOOL_VALUE("retry", false)
};
LogBrewProductTimelineContext context = {
  "session_123",
  "trace_001",
  "/checkout",
  "Checkout",
  "checkout",
  "submit"
};

logbrew_client_product_action(
    client,
    "evt_action_checkout_submit",
    "2026-06-02T10:00:06Z",
    (LogBrewProductActionAttributes){
      "checkout.submit",
      "success",
      context,
      {metadata, sizeof(metadata) / sizeof(metadata[0])}
    },
    &error);

logbrew_client_network_milestone(
    client,
    "evt_network_checkout_api",
    "2026-06-02T10:00:07Z",
    (LogBrewNetworkMilestoneAttributes){
      "post",
      "https://api.example.com/api/checkout?sku=123#pay",
      503,
      true,
      184.5,
      true,
      context,
      {metadata, sizeof(metadata) / sizeof(metadata[0])}
    },
    &error);
```

Network helpers normalize the method, strip query strings and fragments from route templates, reduce HTTP(S) URLs to paths, default HTTP `4xx` and `5xx` milestones to `failure`, and keep metadata primitive. They do not patch HTTP clients, record visual replay, collect headers, or capture request or response bodies. Keep user-entered text, raw URLs, query strings, headers, and payloads out of timeline metadata.

## Example Source

The `examples/readme_example.c` source shows a complete six-event payload and recording transport setup that you can copy into your own native application.

## Sending To LogBrew

Use `logbrew_http_transport_init()` when a native app is ready to send queued batches to the hosted LogBrew intake. The built-in HTTP transport is optional: compile `src/logbrew_http_transport.c` and link libcurl only in apps that want this transport. Apps that already own networking can keep using the `LogBrewTransport` callback seam instead.

```c
LogBrewHttpHeader headers[] = {
  {"x-logbrew-source", "checkout-native"}
};
LogBrewHttpTransport http_transport;
LogBrewTransportResponse response;

logbrew_http_transport_init(
    &http_transport,
    LOGBREW_HTTP_TRANSPORT_DEFAULT_ENDPOINT,
    headers,
    sizeof(headers) / sizeof(headers[0]),
    10000L,
    &error);
logbrew_client_flush(client, logbrew_http_transport_as_transport(&http_transport), &response, &error);
logbrew_http_transport_free(&http_transport);
```

Compile the optional transport with libcurl:

```bash
cc -std=c99 -Wall -Wextra -Wpedantic -Iinclude \
  src/logbrew.c src/logbrew_metric.c src/logbrew_recording_transport.c src/logbrew_timeline.c src/logbrew_trace.c \
  src/logbrew_http_transport.c \
  your_app.c -o your_app $(curl-config --libs)
```

The HTTP transport posts JSON, passes the SDK key through the `authorization` header, supports custom endpoints, non-reserved custom request headers, and a timeout, and maps libcurl request failures to retryable `network_failure` transport errors so `logbrew_client_flush()` can preserve queued events and retry. Do not put user-entered text, raw URLs, request payloads, response payloads, or private headers into LogBrew event metadata.
