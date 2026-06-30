# LogBrew Java SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Java SDK for building, validating, previewing, and flushing LogBrew event batches.

The core client, `HttpTransport`, request trace helpers, JDBC helpers, and `java.util.logging` handler use only the JDK at runtime. Optional Logback, OpenTelemetry, Jakarta Servlet, and Spring Boot helpers integrate with app-owned dependencies when those libraries are already present.

## Install

After publication, use Maven coordinate:

```xml
<dependency>
  <groupId>co.logbrew</groupId>
  <artifactId>logbrew-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

If you attach the optional Logback appender, also include Logback in your app:

```xml
<dependency>
  <groupId>ch.qos.logback</groupId>
  <artifactId>logback-classic</artifactId>
  <version>1.5.34</version>
</dependency>
```

If you copy live OpenTelemetry span context with `LogBrewOpenTelemetry`, include the OpenTelemetry API jars your app already uses:

```xml
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-api</artifactId>
  <version>1.63.0</version>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-context</artifactId>
  <version>1.63.0</version>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-common</artifactId>
  <version>1.63.0</version>
</dependency>
```

If you manually register `LogBrewServletFilter` in a Jakarta Servlet app, include the Servlet API already used by your runtime. Spring Boot servlet apps usually already get this from `spring-boot-starter-web`; they can use `LogBrewSpringBootAutoConfiguration` by exposing an app-owned `LogBrewClient` bean. Spring Boot apps with a `CacheManager` or `DataSource` bean can also use `LogBrewSpringBootCacheAutoConfiguration` and `LogBrewSpringBootJdbcAutoConfiguration` from the same package path; no extra starter or ingest-property client setup is required.

```xml
<dependency>
  <groupId>jakarta.servlet</groupId>
  <artifactId>jakarta.servlet-api</artifactId>
  <version>6.1.0</version>
  <scope>provided</scope>
</dependency>
```

## Usage

```java
import co.logbrew.sdk.ActionAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.ReleaseAttributes;
import co.logbrew.sdk.TransportResponse;

public final class App {
    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_INGEST_KEY", "my-java-app", "1.0.0");
        client.release(
            "evt_release_001",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.create("1.2.3").commit("abc123def456")
        );
        client.action(
            "evt_action_001",
            "2026-06-02T10:00:05Z",
            ActionAttributes.create("deploy", "success")
        );

        System.out.println(client.previewJson());
        TransportResponse response = client.shutdown(RecordingTransport.alwaysAccept());
        System.err.println(response.statusCode());
    }
}
```

## First Useful Telemetry

For a production Java service, the first useful LogBrew payload is usually a release marker, environment marker, one service log, one product action, one network milestone, one request duration metric, and one W3C-linked request span. That gives developers and AI assistants enough context to answer "what changed?", "where did this happen?", "what did the user do?", "which API call mattered?", and "which trace links the signals?" without installing a Java agent or global HTTP instrumentation.

From this package source:

```bash
cd java/logbrew-java
make -C examples run-first-useful-telemetry
```

The example uses a fake key and `RecordingTransport` so you can inspect the JSON locally before enabling `HttpTransport` in your app. It strips query strings and fragments from route templates, keeps metadata primitive-only, links logs/actions/metrics/spans with the same trace and session IDs, and does not capture request/response payloads, arbitrary headers, or full URLs.

## Metrics

Use `metric` for explicit, application-owned measurements:

```java
import co.logbrew.sdk.MetricAttributes;
import java.util.Map;

client.metric(
    "evt_metric_queue_depth",
    "2026-06-02T10:00:06Z",
    MetricAttributes.create("queue.depth", "gauge", 42.0, "{items}", "instant")
        .metadata(Map.of("service", "worker"))
);
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms require `delta` or `cumulative` temporality and non-negative values; gauges require `instant` temporality and may be negative. Keep metadata low-cardinality and primitive. This SDK does not automatically collect JVM, runtime, or framework metrics yet.

## Product and Network Timelines

Use `ProductTimeline` when your Java service already knows important product steps or API milestones. The helpers create normal `action` events with primitive metadata that AI assistants can analyze across sessions without visual replay, HTTP client patching, request/response payload capture, or header capture.

```java
import co.logbrew.sdk.ProductTimeline;
import java.util.Map;

client.action(
    "evt_action_checkout_submit",
    "2026-06-02T10:00:05Z",
    ProductTimeline.productAction("checkout.submit")
        .routeTemplate("/checkout/:step")
        .sessionId("session_123")
        .traceId("trace_abc")
        .screen("Checkout")
        .funnel("checkout")
        .step("submit")
        .metadata(Map.of("cartTier", "gold"))
        .toActionAttributes()
);

client.action(
    "evt_network_payment",
    "2026-06-02T10:00:06Z",
    ProductTimeline.networkMilestone("https://api.example.com/v1/payments/:id?debug=sample")
        .method("POST")
        .statusCode(202)
        .durationMs(183.4)
        .sessionId("session_123")
        .traceId("trace_abc")
        .toActionAttributes()
);
```

## W3C Trace Context

Use `Traceparent` when a Java service needs to continue trace context from OpenTelemetry-compatible callers or pass a W3C `traceparent` value downstream without adding a tracing dependency:

```java
import co.logbrew.sdk.Traceparent;
import java.util.Map;

String incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
Traceparent.Context context = Traceparent.parse(incoming);

client.span(
    "evt_span_checkout",
    "2026-06-02T10:00:04Z",
    Traceparent.spanAttributesFromTraceparent(
        incoming,
        Traceparent.SpanInput.create("POST /checkout/:cart_id", "b7ad6b7169203331", "ok")
            .durationMs(183.4)
            .metadata(Map.of("routeTemplate", "/checkout/:cart_id"))
    )
);

Map<String, String> headers = Traceparent.createHeaders(
    context.traceId(),
    "b7ad6b7169203331",
    context.traceFlags()
);
```

`Traceparent.parse(...)` validates the W3C shape, rejects forbidden version `ff`, rejects all-zero trace/span IDs, normalizes IDs to lowercase, and exposes the sampled flag. `Traceparent.spanAttributesFromTraceparent(...)` creates child span attributes with the incoming trace ID and parent span ID while preserving only primitive metadata. `Traceparent.createHeaders(...)` returns an explicit outbound carrier with only `traceparent`.

## OpenTelemetry Context

Use `LogBrewOpenTelemetry` when a Java app already has OpenTelemetry API context active and you want LogBrew logs, issues, spans, and metrics to correlate under that same trace:

```java
import co.logbrew.sdk.LogBrewOpenTelemetry;
import co.logbrew.sdk.LogBrewTraceContext;
import co.logbrew.sdk.SpanAttributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import java.util.Map;
import java.util.Optional;

Optional<LogBrewTraceContext> maybeTrace =
    LogBrewOpenTelemetry.traceContextFromCurrentSpan("b7ad6b7169203331");

maybeTrace.ifPresent(trace -> client.span(
    "evt_span_otel_child",
    "2026-06-02T10:00:04Z",
    SpanAttributes.create("otel child operation", trace.traceId(), trace.spanId(), "ok")
        .parentSpanId(trace.parentSpanId())
        .metadata(trace.metadata())
));

Map<String, String> downstreamHeaders = maybeTrace
    .map(LogBrewTraceContext::headers)
    .orElseGet(Map::of);

Optional<LogBrewTraceContext> fromExplicitContext =
    LogBrewOpenTelemetry.traceContextFromContext(Context.current());
Optional<LogBrewTraceContext> fromSpan =
    LogBrewOpenTelemetry.traceContextFromSpan(Span.current());
```

The helper returns `Optional.empty()` when no valid OpenTelemetry span is active. It copies only the valid trace ID, parent span ID, and sampled trace flags into a new LogBrew child context. It does not install an OpenTelemetry SDK, create exporters or processors, read attributes, copy baggage/tracestate, patch HTTP clients, or capture payloads, headers, SQL, URLs, exception messages, or stack traces.

## Request Trace Correlation

Use `LogBrewTraceContext`, `LogBrewTrace`, and `LogBrewHttpRequestTelemetry` when a Java service needs request-local trace continuity across spans, logs, issues, and explicit metrics. This is opt-in and app-owned: the SDK does not install a Java agent, patch servlet containers, patch HTTP clients, capture request/response payloads, capture headers, or change root logger configuration.

```java
import co.logbrew.sdk.IssueAttributes;
import co.logbrew.sdk.LogBrewHttpRequestTelemetry;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import java.util.Map;

String incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
LogBrewTraceContext trace = LogBrewTraceContext.fromTraceparent(incoming, "b7ad6b7169203331");
LogBrewHttpRequestTelemetry request = LogBrewHttpRequestTelemetry.start(
    client,
    "POST",
    "/checkout/{cart_id}",
    trace,
    Map.of("service", "checkout-api")
);

LogBrewTrace.Scope scope = request.activate();
try {
    logger.warning("checkout handler saw a slow payment response");
    client.issue(
        "evt_issue_checkout_request",
        "2026-06-02T10:00:03Z",
        IssueAttributes.create("Checkout returned a server error", "error")
            .metadata(LogBrewTrace.metadataWithCurrentTrace(Map.of("stage", "handler")))
    );
} finally {
    scope.close();
}

request.finishSpanAndMetric(
    "evt_span_checkout_request",
    "evt_metric_checkout_request_duration",
    "2026-06-02T10:00:04Z",
    502,
    183.4
);
Map<String, String> outgoingHeaders = request.outgoingHeaders();
```

`LogBrewTrace.activate(...)` reinstates the previous active trace when closed. Use `LogBrewTrace.wrapCurrent(...)` when handing work to another thread or executor; plain Java threads do not inherit request trace state automatically. The request helper falls back to a local root trace when incoming propagation is missing or malformed, while `Traceparent.parse(...)` stays strict for explicit validation paths. `LogBrewJulHandler` and `LogBrewLogbackAppender` attach active `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata automatically, while preserving app-owned logger handlers and primitive metadata.

## Jakarta Servlet and Spring Requests

Spring Boot 3+/4+ apps only need to expose the `LogBrewClient` they already own. When Spring Boot, Jakarta Servlet, and that client bean are present, `LogBrewSpringBootAutoConfiguration` registers the servlet filter automatically:

```java
import co.logbrew.sdk.LogBrewClient;
import org.springframework.context.annotation.Bean;

@Bean
LogBrewClient logBrewClient() {
    return LogBrewClient.create("LOGBREW_INGEST_KEY", "checkout-api", "1.0.0");
}
```

The auto-configuration does not create clients from properties, load ingest config, patch servlet containers, or capture request bodies, arbitrary headers, cookies, query strings, full URLs, baggage, or tracestate. Set `logbrew.servlet.enabled=false` to disable registration, `logbrew.servlet.event-id-prefix` to change event IDs, and `logbrew.servlet.order` to tune filter order.

For non-Boot Jakarta Servlet apps, register `LogBrewServletFilter` yourself. For Boot apps that want a fully custom registration, set `logbrew.servlet.enabled=false` before registering your own filter:

```java
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewServletFilter;
import java.util.Map;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;

@Bean
FilterRegistrationBean<LogBrewServletFilter> logbrewServletFilter(LogBrewClient client) {
    LogBrewServletFilter filter = new LogBrewServletFilter(
        client,
        "checkout_request",
        Map.of("service", "checkout-api")
    );
    FilterRegistrationBean<LogBrewServletFilter> registration = new FilterRegistrationBean<>(filter);
    registration.setOrder(1);
    return registration;
}
```

The filter reads only the incoming `traceparent` header, makes the request trace active while your handler/logger code runs, and emits one span plus one `http.server.duration` metric after the chain completes. Route naming prefers `LogBrewServletFilter.ROUTE_TEMPLATE_ATTRIBUTE`, then Spring's best-matching route attribute, then servlet path/request URI fallback. It rethrows the original handler error, records a 500 status for unhandled failures when possible, strips query strings through the request helper, and never captures bodies, arbitrary headers, cookies, full URLs, baggage, tracestate, exception messages, or stack traces.

## Dependency Spans

Use `LogBrewOperationTracing` around app-owned database, cache, or queue calls when you want request-to-dependency timing without a Java agent, driver dependency, Redis/Kafka client dependency, or global patching:

```java
import co.logbrew.sdk.LogBrewOperationTracing;
import co.logbrew.sdk.SpanEventSummary;
import java.util.Map;

String orderId = LogBrewOperationTracing.databaseOperation(
    client,
    "select checkout",
    () -> "order_123",
    LogBrewOperationTracing.DatabaseOperation.create()
        .system("postgresql")
        .operationKind("query")
        .databaseName("orders")
        .statementTemplate("SELECT * FROM orders WHERE id = ?")
        .rowCount(1)
        .spanEvent(SpanEventSummary.create("db.rows").metadata(Map.of("rowCount", 1)))
        .metadata(Map.of("service", "checkout"))
);
```

The database, cache, and queue helpers create a child `LogBrewTraceContext`, activate it for the callback, record one span, return the original result, and rethrow the original operation error. Add `SpanEventSummary` values when a span needs small lifecycle markers such as row counts, enqueue checkpoints, or retry decisions. Events are capped, metadata is primitive-only, and failed dependency callbacks add an exception-type-only summary without exception messages or stack traces. Metadata is intentionally stripped of SQL text, parameters, connection details, hosts, cache keys/values, raw commands, payloads, message bodies, broker URLs, headers, cookies, and auth-like fields. These helpers do not import or patch Redis, Kafka, JMS, AMQP, or framework clients; future automatic coverage should live in explicit integration packages with separate dependency and privacy validation.

For Spring Cache apps that already own a `CacheManager` or `Cache`, use `LogBrewSpringCacheTracing` when you want cache hit/write/delete spans under an active request or task trace:

```java
import co.logbrew.sdk.LogBrewSpringCacheTracing;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;

CacheManager tracedCacheManager = LogBrewSpringCacheTracing.instrumentCacheManager(
    cacheManager,
    client,
    LogBrewSpringCacheTracing.CacheConfig.create()
        .system("spring-cache")
        .eventIdPrefix("spring_cache")
);

Cache cache = tracedCacheManager.getCache("checkout-cache");
cache.put("cart-id", "value");
cache.get("cart-id");
cache.evictIfPresent("cart-id");
```

The wrapper delegates normal Spring Cache behavior, traces `get`, `retrieve`, `put`, `putIfAbsent`, `evict`, `evictIfPresent`, `clear`, and `invalidate`, and records only operation kind, cache system, cache name, hit/write booleans, sampled state, duration, and failure status; asynchronous completion failures also include a type-only exception summary. By default it requires an active `LogBrewTrace` so cache activity correlates with request spans without producing background root traces; set `traceWithoutActiveContext(true)` only when you intentionally want standalone cache spans. It does not capture cache keys, values, native cache objects, backend hosts, payloads, headers, baggage, tracestate, exception messages, stack traces, or Spring bean names.

For JDBC apps that already own a `java.sql.Connection` or `javax.sql.DataSource`, use `LogBrewJdbcTracing` when you want spans for statements created through those app-owned objects:

```java
import co.logbrew.sdk.LogBrewJdbcTracing;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Map;
import javax.sql.DataSource;

DataSource tracedDataSource = LogBrewJdbcTracing.instrumentDataSource(
    dataSource,
    client,
    LogBrewJdbcTracing.ConnectionConfig.create()
        .system("postgresql")
        .databaseName("orders")
        .traceConnectionAcquisition(true)
        .metadata(Map.of("service", "checkout-api"))
);

Connection tracedConnectionFromPool = tracedDataSource.getConnection();

Connection tracedConnection = LogBrewJdbcTracing.instrumentConnection(
    connection,
    client,
    LogBrewJdbcTracing.ConnectionConfig.create()
        .system("postgresql")
        .databaseName("orders")
        .metadata(Map.of("service", "checkout-api"))
);

try (PreparedStatement statement = tracedConnection.prepareStatement(
    "SELECT * FROM orders WHERE id = ?"
)) {
    statement.setString(1, orderId);
    try (ResultSet result = statement.executeQuery()) {
        // Use result normally.
    }
}
```

The wrappers use only JDK JDBC interfaces and return the original JDBC results or exceptions. `instrumentDataSource(...)` delegates normal data-source behavior and wraps only connections returned by no-argument or two-argument `getConnection`. It stays statement-only by default; enable `traceConnectionAcquisition(true)` when you want one `jdbc:CONNECT` span for DataSource acquisition or pool-wait time. `instrumentConnection(...)` wraps `createStatement`, `prepareStatement`, and `prepareCall` results, emits one `jdbc:<VERB>` child span around `execute*` calls, records update counts when JDBC returns them, and can trace `commit()`/`rollback()` when `traceTransactions(true)` is set. LogBrew derives only the SQL verb locally, such as `SELECT` or `UPDATE`, after skipping leading SQL comments and quoted literals; it does not capture SQL text, bind values, result rows, connection URLs, driver metadata, network addresses, JDBC login argument values, arbitrary JDBC properties, baggage, tracestate, exception messages, or stack traces. It does not install a Java agent, register a driver, patch `DriverManager`, mutate SQL comments, or affect other data sources/connections.

Spring Boot JDBC apps can skip manual wrapping. When Spring Boot, `javax.sql.DataSource`, and an app-owned `LogBrewClient` bean are present, `LogBrewSpringBootJdbcAutoConfiguration` wraps initialized Spring `DataSource` beans through a bean post-processor and reuses the same `LogBrewJdbcTracing` privacy rules:

```properties
logbrew.jdbc.enabled=true
logbrew.jdbc.db-system=postgresql
logbrew.jdbc.db-name=orders
logbrew.jdbc.trace-connection-acquisition=false
logbrew.jdbc.trace-transactions=false
```

Set `logbrew.jdbc.enabled=false` to disable auto-wrapping. The auto-configuration skips scoped-target beans, already wrapped data sources, and Spring routing data sources; it does not create clients from properties, read connection metadata, record bean names, patch `DriverManager`, or capture SQL text, connection URLs, JDBC login arguments, baggage, or tracestate.

Spring Boot Cache apps can skip manual wrapping. When Spring Boot, Spring Cache, and an app-owned `LogBrewClient` bean are present, `LogBrewSpringBootCacheAutoConfiguration` wraps initialized Spring `CacheManager` beans through a bean post-processor and reuses the same `LogBrewSpringCacheTracing` privacy rules:

```properties
logbrew.cache.enabled=true
logbrew.cache.system=spring-cache
logbrew.cache.trace-without-active-context=false
```

Set `logbrew.cache.enabled=false` to disable auto-wrapping. The auto-configuration skips scoped-target beans and already wrapped cache managers; it does not create clients from properties, record bean names, inspect native cache objects, capture cache keys/values, or add baggage/tracestate propagation.

## Support Ticket Drafts

Use `SupportTicketDraft` when a developer or support agent explicitly asks for a local JSON payload for the planned LogBrew support-ticket API. The helper validates the public source/category contract, normalizes W3C trace IDs, redacts diagnostics, and returns a local draft:

```java
import co.logbrew.sdk.SupportTicketDraft;
import java.util.Map;

SupportTicketDraft draft = SupportTicketDraft.create(SupportTicketDraft.Input
    .create("sdk", "ingest_failure", "Telemetry flush failed", "Flush returned usage_limit_exceeded")
    .runtime("java 21")
    .framework("spring")
    .sdkPackage("co.logbrew:logbrew-sdk")
    .sdkVersion("0.1.0")
    .release("checkout@1.2.3")
    .traceId("4BF92F3577B34DA6A3CE929D0E0E4736")
    .diagnostics(Map.of(
        "attemptCount", 2,
        "apiKey", "lbw_ingest_hidden",
        "endpoint", "https://api.example/ingest?debug=true",
        "error", new IllegalStateException("contains local details")
    )));

System.out.println(draft.toJson());
```

This helper does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, or infer backend usage/quota state. Support routes are backend-owned and should only be called by an explicit user or agent action after backend reports deployed support-ticket routes. Diagnostics are bounded to JSON-like values; auth values, cookies, tokens, local paths, URL origins, unsupported objects, and exception messages are redacted or omitted.

## HTTP Delivery

Use `HttpTransport` for real outbound delivery from server-side Java apps:

```java
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.TransportResponse;
import java.time.Duration;
import java.util.Map;

LogBrewClient client = LogBrewClient.create("LOGBREW_INGEST_KEY", "checkout-api", "1.0.0");
client.log(
    "evt_log_001",
    "2026-06-02T10:00:03Z",
    LogAttributes.create("worker started", "info").logger("job-runner")
);

HttpTransport transport = HttpTransport.builder()
    .endpoint(HttpTransport.DEFAULT_ENDPOINT)
    .headers(Map.of("x-logbrew-source", "java-worker"))
    .timeout(Duration.ofSeconds(10))
    .build();

TransportResponse response = client.shutdown(transport);
System.err.println(response.statusCode());
```

`HttpTransport` uses Java 11's standard `java.net.http.HttpClient`, posts JSON, passes the SDK key through the `authorization` header, supports custom endpoint/header/client/timeout settings, discards response bodies, and maps client delivery failures into retryable `TransportException.network(...)` values so `LogBrewClient.flush(...)` can preserve queued events and retry. Inject a custom `HttpClient` when a service already owns proxy, TLS, timeout, executor, or transport settings.

## Standard Java Logging

For apps that already use `java.util.logging`, attach `LogBrewJulHandler` to the logger you own:

```java
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewJulHandler;
import co.logbrew.sdk.RecordingTransport;
import java.util.logging.Logger;

LogBrewClient client = LogBrewClient.create("LOGBREW_INGEST_KEY", "checkout-api", "1.0.0");
RecordingTransport transport = RecordingTransport.alwaysAccept();
LogBrewJulHandler handler = new LogBrewJulHandler(client, transport);

Logger logger = Logger.getLogger("checkout.worker");
logger.addHandler(handler);
logger.warning("cart queued");
logger.log(java.util.logging.Level.SEVERE, "checkout failed", new IllegalStateException("database unavailable"));
handler.flush();
```

The handler does not change the root logger, replace app-owned handlers, or require SLF4J/Logback/Log4j dependencies. It maps JUL levels into canonical LogBrew severities (`info`, `warning`, `error`, `critical`), captures the logger name, source class/method, thread id, sequence number, and exception type/message, and omits full stack-trace text unless `includeThrownStackTrace` is enabled in the constructor.

## SLF4J and Logback

For apps that already use SLF4J with Logback, attach `LogBrewLogbackAppender` to the Logback logger you own:

```java
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.RecordingTransport;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

LogBrewClient client = LogBrewClient.create("LOGBREW_INGEST_KEY", "checkout-api", "1.0.0");
RecordingTransport transport = RecordingTransport.alwaysAccept();
LogBrewLogbackAppender appender = new LogBrewLogbackAppender(client, transport, false);
appender.setName("LOGBREW");
appender.setEventIdPrefix("logback");
appender.start();

ch.qos.logback.classic.Logger logger =
    (ch.qos.logback.classic.Logger) LoggerFactory.getLogger("checkout.worker");
logger.addAppender(appender);
MDC.put("requestId", "req_123");
logger.atWarn().addKeyValue("cartId", 42).log("cart queued");
logger.error("checkout failed", new IllegalStateException("database unavailable"));
MDC.remove("requestId");
appender.stop();
```

The appender maps SLF4J/Logback levels into canonical LogBrew severities, captures the logger name, thread name, SLF4J markers, MDC values as `mdc.*`, fluent key/value pairs as `kv.*`, and exception type/message. Full stack-trace text is omitted unless `includeThrowableStackTrace` is enabled.

## Spring Boot

Spring Boot starters use Logback by default, so a Boot app can use the same optional appender alongside the automatic servlet filter and JDBC data-source wrapping. Define your `LogBrewClient` bean once for `LogBrewSpringBootAutoConfiguration` and `LogBrewSpringBootJdbcAutoConfiguration`, then attach the appender from code you own, usually after your client and transport are configured:

```java
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.RecordingTransport;
import java.util.Map;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.env.Environment;

LogBrewClient client = LogBrewClient.create("LOGBREW_INGEST_KEY", "checkout-api", "1.0.0");
RecordingTransport transport = RecordingTransport.alwaysAccept();

LogBrewLogbackAppender appender = new LogBrewLogbackAppender(client, transport, false);
appender.setName("LOGBREW");
appender.setEventIdPrefix("spring_boot_logback");
appender.setMetadata(Map.of("springApplicationName", environment.getProperty("spring.application.name")));
appender.start();

ch.qos.logback.classic.Logger logger =
    (ch.qos.logback.classic.Logger) LoggerFactory.getLogger("checkout.worker");
logger.addAppender(appender);
MDC.put("traceId", "trace_123");
logger.atWarn().addKeyValue("cartId", 42).log("cart queued");
MDC.remove("traceId");
appender.stop();
```

## Examples

From `java/logbrew-java`:

The `examples` directory contains copyable snippets for creating a client, producing a first useful telemetry payload, sending through `HttpTransport`, attaching `java.util.logging`, and configuring the optional Logback appender in your own Java service.

## Behavior

- `previewJson()` returns the queued batch as pretty JSON.
- `LogBrewClient` keeps a bounded in-memory queue of 1,000 events by default; use `LogBrewClient.create(apiKey, sdkName, sdkVersion, maxRetries, maxQueueSize, drop -> ...)` to tune the cap and receive redacted advisory drop summaries. When the queue is full, the newest event is dropped, `droppedEvents()` increments, and drop-callback failures do not interrupt application logging.
- `metric(...)` queues explicit, application-owned metric events with name, kind, value, unit, temporality, and low-cardinality metadata validation.
- `Traceparent` parses, creates, and derives span attributes from W3C `traceparent` values without adding OpenTelemetry or patching HTTP clients.
- `LogBrewOpenTelemetry` copies valid app-owned OpenTelemetry span context into LogBrew child trace context when OpenTelemetry API jars are already present.
- `LogBrewServletFilter` activates request-local trace context for Jakarta Servlet/Spring Boot handlers and emits one request span plus one duration metric without hidden Java-agent instrumentation.
- `LogBrewSpringBootAutoConfiguration` registers that filter only when Spring Boot, Jakarta Servlet, and an app-owned `LogBrewClient` bean are present.
- `LogBrewSpringCacheTracing` wraps app-owned Spring `CacheManager` or `Cache` objects with privacy-bounded cache hit/write spans under an active trace by default.
- `LogBrewSpringBootCacheAutoConfiguration` wraps app-owned Spring `CacheManager` beans when Spring Boot, Spring Cache, and an app-owned `LogBrewClient` bean are present.
- `LogBrewSpringBootJdbcAutoConfiguration` wraps app-owned Spring `DataSource` beans with privacy-bounded JDBC statement spans when Spring Boot, `DataSource`, and an app-owned `LogBrewClient` bean are present.
- `LogBrewOperationTracing` creates app-owned database, cache, and queue spans with bounded `SpanEventSummary` markers, without adding driver dependencies or automatic client patching.
- `flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `isClosed()` returns whether `shutdown(transport)` has closed the client.
- `HttpTransport` sends queued batches through dependency-free `java.net.http` delivery for server-side apps.
- `RecordingTransport.alwaysAccept()` is useful when you want to inspect queued JSON before network delivery.
- `LogBrewJulHandler` queues standard `java.util.logging` records without mutating global logging configuration.
- `LogBrewLogbackAppender` queues app-owned SLF4J/Logback records, including MDC and fluent key/value metadata, without changing global logger setup.
- `ProductTimeline` queues app-owned product and network action timelines without automatic visual replay, HTTP client patching, payload capture, or header capture.
- Spring Boot apps can attach `LogBrewLogbackAppender` from app-owned configuration while request tracing and JDBC data-source wrapping auto-register from the same app-owned client bean.
- `SdkException` exposes a stable `code()` and `detailMessage()` for user-facing failure handling.
