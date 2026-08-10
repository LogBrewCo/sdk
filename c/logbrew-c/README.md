# LogBrew C SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public C99 SDK for building, validating, previewing, and flushing LogBrew event batches from native applications.

The SDK ships as source plus header. Add `include/logbrew.h` and the core files under `src/` to your application build:

```bash
cc -std=c99 -Wall -Wextra -Wpedantic -Iinclude \
  src/logbrew.c src/logbrew_json.c src/logbrew_context.c src/logbrew_evidence.c \
  src/logbrew_metric.c src/logbrew_recording_transport.c src/logbrew_timeline.c src/logbrew_trace.c \
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

## Rich investigation context

Every signal can carry the same schema-v1 resource, trace, session, opaque subject, and tag context through `LogBrewTelemetryContext`. The default constructor adds only portable automatic facts that are safe and useful for investigation: the C language standard, operating-system family, and CPU architecture when they are available at compile time. It does not inspect ambient machine, user, process, filesystem, network, account, or device identity data.

Use `logbrew_client_new_with_options()` to add stable application context or to disable those conservative automatic facts. The client validates and deep-copies construction context:

```c
LogBrewNamedVersion service = {"checkout-api", "2.4.0"};
LogBrewDeploymentContext deployment = {"production", "checkout@2.4.0"};
LogBrewApplicationContext application = {"checkout-worker", "2.4.0", "204"};
LogBrewTelemetryResource resource = {
  .service = &service,
  .deployment = &deployment,
  .application = &application
};
LogBrewTelemetryTag tags[] = {
  {"region", "eu-west"},
  {"tier", "payments"}
};
LogBrewTelemetryContext context = {
  .schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION,
  .resource = &resource,
  .tags = tags,
  .tag_count = sizeof(tags) / sizeof(tags[0])
};
LogBrewClientOptions options = {.context = &context};

logbrew_client_new_with_options(config, options, &client, &error);
```

Context is merged field by field in this order: conservative automatic facts, client context, active thread-local telemetry scope, active W3C trace scope, signal-owned span identity, and per-event context. Later values win. Tags merge by key. A higher layer that changes a trace or span ID cannot inherit parent-span IDs from a different lower span.

Use a telemetry scope for synchronous request or job boundaries. Initialize it with `LOGBREW_TELEMETRY_SCOPE_INIT`; scope context is deep-copied, scopes are non-copyable, enter and exit must happen on the same thread, and nested scopes must exit in last-in-first-out order. Pass an explicit `LogBrewEventOptions.context` or enter a new scope when work crosses a thread boundary:

```c
LogBrewSessionContext session = {"session_opaque_02", "session_opaque_01"};
LogBrewSubjectContext subject = {"subject_sha256_abc123", LOGBREW_SUBJECT_USER};
LogBrewTelemetryContext request_context = {
  .schema_version = LOGBREW_TELEMETRY_CONTEXT_SCHEMA_VERSION,
  .session = &session,
  .subject = &subject
};
LogBrewTelemetryScope scope = LOGBREW_TELEMETRY_SCOPE_INIT;

logbrew_telemetry_scope_enter(&scope, &request_context, &error);
/* Capture releases, environments, issues, logs, spans, actions, or metrics. */
logbrew_telemetry_scope_exit(&scope);
```

Subject IDs must already be opaque, stable identifiers. Do not pass an email address, name, phone number, authentication material, IP address, or another directly identifying value. Tags are capped at 32 strict machine keys and bounded string values. Use `LogBrewEventOptions.metadata` for primitive event-specific evidence; merged metadata is capped at `LOGBREW_MAX_METADATA_ENTRIES`, keys at `LOGBREW_MAX_METADATA_KEY_LENGTH`, string values at `LOGBREW_MAX_METADATA_STRING_LENGTH`, and `LOGBREW_METADATA_NULL_VALUE()` represents an explicitly unavailable value.

### Issues, code locations, and breadcrumbs

Use `logbrew_client_issue_with_details()` for evidence that lets a human or an agent answer what failed, where, whether it was handled, and what happened immediately beforehand. Exception messages, locals, arguments, environment variables, and raw stack strings are intentionally not part of this contract.

```c
LogBrewIssueMechanism mechanism = {"signal", false};
LogBrewIssueException exception = {"PaymentDeclined", &mechanism};
LogBrewIssueStackFrame frame;
LogBrewIssueBreadcrumb breadcrumb = {
  .timestamp = "2026-08-06T10:01:05.123Z",
  .type = "http",
  .category = "payment.request",
  .level = "error",
  .message = "authorization returned a terminal response"
};
LogBrewIssueDetails details = {0};

logbrew_issue_frame_from_location(
    __FILE__, __LINE__, 1U, __func__, "checkout.payment", true, &frame, &error);
logbrew_client_add_breadcrumb(client, breadcrumb, &error);

details.exception = &exception;
details.stack_frames = &frame;
details.stack_frame_count = 1U;

logbrew_client_issue_with_details(
    client,
    "evt_issue_payment_001",
    "2026-08-06T10:01:06Z",
    (LogBrewIssueAttributes){"Payment authorization failed", "error", "Checkout could not authorize payment"},
    details,
    LOGBREW_EVENT_OPTIONS_NONE,
    &error);
```

`logbrew_issue_frame_from_location()` keeps only the basename and removes query strings and fragments, so a compiler-provided absolute `__FILE__` value does not disclose a developer path. The returned frame is safe to copy and borrows the supplied file/function/module strings only until the synchronous issue capture returns. Direct frame values may use useful relative paths but absolute paths are rejected. Frames are capped at 32. The client retains the newest 64 validated breadcrumbs and sets `breadcrumbsTruncated` whenever older evidence was discarded. Breadcrumb data is limited to eight primitive, bounded fields. Breadcrumb messages must be application-redacted summaries, never raw URLs, headers, payloads, authentication material, or direct identities. Call `logbrew_client_clear_breadcrumbs()` at a privacy or lifecycle boundary.

Portable C cannot discover nested runtime failures consistently. When the
application already knows the relationship, attach a
`LogBrewIssueExceptionChain` through `details.exception_chain`. Its one-to-eight
parent-first entries distinguish reported, cause, context, aggregate-member,
and suppressed failures; message and stack states make captured, redacted,
truncated, and missing evidence explicit. Entry zero must exactly match
`details.exception` and `details.stack_frames`, so contradictory manual graphs
fail before queue admission. See the shared
[exception-chain contract](../../docs/exception-chain-evidence.md).

### Span events and links

Use `logbrew_client_span_with_evidence()` for bounded milestones inside a span and links to other W3C trace/span identities:

```c
LogBrewSpanEvent event = {
  .name = "payment.authorization.rejected",
  .timestamp = "2026-08-06T10:01:05.900Z"
};
LogBrewSpanLink link = {
  .trace_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  .span_id = "bbbbbbbbbbbbbbbb",
  .sampled = false,
  .has_sampled = true
};
LogBrewSpanEvidence evidence = {
  .events = &event,
  .event_count = 1U,
  .links = &link,
  .link_count = 1U
};

logbrew_client_span_with_evidence(
    client, "evt_span_payment_001", "2026-08-06T10:01:07Z",
    span, evidence, LOGBREW_EVENT_OPTIONS_NONE, &error);
```

Events and links are capped at eight each. Link IDs must be non-zero W3C hex values. Metadata remains primitive and should describe bounded diagnostic facts, never headers, payloads, authentication material, or direct identities.

When a span's `trace_id`, `span_id`, and optional `parent_span_id` are valid W3C hex identifiers, that signal-owned identity is also emitted in typed context even after an active trace scope has ended. Legacy non-W3C span identifiers remain available in the span's required top-level fields, but they are not presented as W3C typed context.

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
      {metric_metadata, sizeof(metric_metadata) / sizeof(metric_metadata[0])},
      "Number of items waiting in the checkout queue."
    },
    &error);
```

Metric `kind` must be `counter`, `gauge`, or `histogram`. Gauges use `instant` temporality; counters and histograms use `delta` or `cumulative` temporality and must be non-negative. Values must be finite and units must be non-empty. The optional final `description` field gives people and investigation tools the stable meaning of the measurement. Keep it generic, single-line, between 1 and 1,024 Unicode scalar values encoded as UTF-8, and free of identifiers, personal data, or changing values. It is not a query dimension. Metadata should stay low-cardinality: service, queue, route template, or feature flag names are appropriate; user IDs, raw URLs, per-session identifiers, request IDs, headers, and payload fields are not.

This SDK does not automatically collect native runtime, process, or framework metrics yet. Add only the measurements your app owns and wants LogBrew to correlate with logs, errors, traces, and product timelines.

## W3C Trace Correlation

Use the trace helpers when a native C service or app receives a W3C `traceparent` value and wants logs, errors, actions, metrics, spans, and outgoing calls to line up on one trace. The helper validates the incoming context, rejects all-zero IDs, normalizes IDs to lowercase, and creates a fresh local span ID for this process.

Trace scopes are thread-local and non-copyable. Enter and exit them on the same thread and in last-in-first-out order; an out-of-order exit is ignored so it cannot discard a still-active nested trace.

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

While a `LogBrewTraceScope` is active, every signal automatically receives the canonical trace inside its typed `context`. The original issue, log, and action calls also retain their compatibility trace metadata. Use `logbrew_trace_metadata()` only when an older flat-metadata consumer still needs those keys, and use `logbrew_trace_product_timeline_context()` when a product timeline explicitly owns a session or route-template correlation field.

`logbrew_trace_continue_or_create_context()` is useful for request boundaries: valid incoming W3C context is continued; missing or malformed context falls back to a fresh local root without failing the request. `logbrew_trace_http_client_span_start()` creates a child span name from an HTTP method and sanitized route template, stripping query strings and fragments from relative templates or HTTP(S) URLs. Unsupported schemes, protocol-relative hosts, malformed hosts, and query-only values are rejected. The SDK never serializes the raw incoming `traceparent` into telemetry, does not patch HTTP clients, and does not capture headers, request bodies, response bodies, raw URLs, query strings, or fragments.

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
