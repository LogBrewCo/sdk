# LogBrew Java SDK

Public Java SDK for building, validating, previewing, and flushing LogBrew event batches.

The core client, `HttpTransport`, and `java.util.logging` handler use only the JDK at runtime. The optional Logback appender integrates with app-owned SLF4J/Logback setups when those libraries are already present. The repository checks run temp-owned SpotBugs bytecode analysis, compile everything with `javac`, package it with `jar`, and run examples from a fresh classpath app so a broken build surface is caught before release.

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

For local testing from this repository:

```bash
bash scripts/check_java_static.sh
bash scripts/check_java_package.sh
bash scripts/real_user_java_smoke.sh
bash scripts/real_user_spring_boot_smoke.sh
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
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "my-java-app", "1.0.0");
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

## HTTP Delivery

Use `HttpTransport` for real outbound delivery from server-side Java apps:

```java
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.TransportResponse;
import java.time.Duration;
import java.util.Map;

LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "checkout-api", "1.0.0");
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

`HttpTransport` uses Java 11's standard `java.net.http.HttpClient`, posts JSON, passes the SDK key through the `authorization` header, supports custom endpoint/header/client/timeout settings, discards response bodies, and maps client delivery failures into retryable `TransportException.network(...)` values so `LogBrewClient.flush(...)` can preserve queued events and retry. Inject a custom `HttpClient` when a service already owns proxy, TLS, timeout, executor, or test transport settings.

## Standard Java Logging

For apps that already use `java.util.logging`, attach `LogBrewJulHandler` to the logger you own:

```java
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewJulHandler;
import co.logbrew.sdk.RecordingTransport;
import java.util.logging.Logger;

LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "checkout-api", "1.0.0");
RecordingTransport transport = RecordingTransport.alwaysAccept();
LogBrewJulHandler handler = new LogBrewJulHandler(client, transport);

Logger logger = Logger.getLogger("checkout.worker");
logger.addHandler(handler);
logger.warning("cart queued");
logger.log(java.util.logging.Level.SEVERE, "checkout failed", new IllegalStateException("database unavailable"));
handler.flush();
```

The handler does not change the root logger, replace app-owned handlers, or require SLF4J/Logback/Log4j dependencies. It maps JUL levels to LogBrew levels, captures the logger name, source class/method, thread id, sequence number, and exception type/message, and omits full stack-trace text unless `includeThrownStackTrace` is enabled in the constructor.

## SLF4J and Logback

For apps that already use SLF4J with Logback, attach `LogBrewLogbackAppender` to the Logback logger you own:

```java
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.RecordingTransport;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "checkout-api", "1.0.0");
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

The appender maps SLF4J/Logback levels to LogBrew levels, captures the logger name, thread name, SLF4J markers, MDC values as `mdc.*`, fluent key/value pairs as `kv.*`, and exception type/message. Full stack-trace text is omitted unless `includeThrowableStackTrace` is enabled.

## Spring Boot

Spring Boot starters use Logback by default, so a Boot app can use the same optional appender without adding a LogBrew-specific Spring dependency. Attach the appender from code you own, usually after your `LogBrewClient` and transport are configured:

```java
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.RecordingTransport;
import java.util.Map;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.env.Environment;

LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "checkout-api", "1.0.0");
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

The repository smoke test builds the SDK jar, installs it into a fresh Gradle Spring Boot app, resolves current Spring Boot dependencies from Maven Central, and proves the appender captures Boot's Logback events with MDC and SLF4J key/value metadata while keeping stack text opt-in.

## Examples

From `java/logbrew-java`:

```bash
cd examples && make
cd examples && make run-readme-example
cd examples && make run
cd examples && make run-real-user-smoke
```

`make run` is the shorter alias for the stronger real-user smoke example.

## Behavior

- `previewJson()` returns the queued batch as pretty JSON.
- `flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `isClosed()` returns whether `shutdown(transport)` has closed the client.
- `HttpTransport` sends queued batches through dependency-free `java.net.http` delivery for server-side apps.
- `RecordingTransport.alwaysAccept()` is useful for local examples and tests.
- `LogBrewJulHandler` queues standard `java.util.logging` records without mutating global logging configuration.
- `LogBrewLogbackAppender` queues app-owned SLF4J/Logback records, including MDC and fluent key/value metadata, without changing global logger setup.
- Spring Boot apps can attach `LogBrewLogbackAppender` to app-owned Logback loggers without adding a required Spring runtime dependency to the SDK.
- `SdkException` exposes a stable `code()` and `detailMessage()` for user-facing failure handling.
