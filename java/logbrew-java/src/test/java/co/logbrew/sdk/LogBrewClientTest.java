package co.logbrew.sdk;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.Collections;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

/**
 * Dependency-free test runner for the Java SDK.
 */
public final class LogBrewClientTest {
    private int testsRun;

    public static void main(String[] args) {
        new LogBrewClientTest().run();
    }

    private void run() {
        testPreviewJsonContainsAllSupportedEventTypes();
        testFlushSuccessClearsQueue();
        testEmptyFlushNoOps();
        testInvalidTimestampFailsValidation();
        testInvalidIssueLevelFailsValidation();
        testSeverityAliasesNormalizeBeforePreview();
        testNegativeSpanDurationFailsValidation();
        testMetricEventValidatesExplicitContract();
        testMetricRejectsNonFiniteValue();
        testMetricRejectsNegativeCounterValue();
        testMetricRejectsInvalidTemporalityForKind();
        testMetadataIsDefensivelyCopied();
        testUnauthenticatedResponseSurfacesCleanError();
        testNetworkFailureRetriesBeforeSucceeding();
        testRetryBudgetFailurePreservesQueue();
        testNonRetryableStatusPreservesQueue();
        testHttpTransportPostsJsonAndMapsStatus();
        testHttpTransportStatusRetriesThroughClient();
        testHttpTransportNetworkErrorIsRetryable();
        testHttpTransportRejectsInvalidConfiguration();
        testShutdownFlushesAndPreventsFutureEvents();
        testJulHandlerQueuesRecordMetadata();
        testJulHandlerCapturesExceptionMetadataWithoutStackTraceByDefault();
        testJulHandlerFlushesWhenRequested();
        testLogbackAppenderQueuesSlf4jMetadata();
        testLogbackAppenderCapturesThrowableMetadataWithoutStackTraceByDefault();
        System.out.println("java package tests ok (" + testsRun + " tests)");
    }

    private void testPreviewJsonContainsAllSupportedEventTypes() {
        LogBrewClient client = sampleClient();
        enqueueAll(client);

        String payload = client.previewJson();
        assertInOrder(
            payload,
            "\"type\": \"release\"",
            "\"type\": \"environment\"",
            "\"type\": \"issue\"",
            "\"type\": \"log\"",
            "\"type\": \"span\"",
            "\"type\": \"action\""
        );
        testsRun++;
    }

    private void testFlushSuccessClearsQueue() {
        LogBrewClient client = sampleClient();
        enqueueAll(client);
        RecordingTransport transport = RecordingTransport.alwaysAccept();

        TransportResponse response = client.flush(transport);
        assertEquals(202, response.statusCode(), "status");
        assertEquals(1, response.attempts(), "attempts");
        assertEquals(0, client.pendingEvents(), "pending events");
        assertTrue(transport.lastBody().orElse("").contains("\"events\""), "transport body contains events");
        testsRun++;
    }

    private void testEmptyFlushNoOps() {
        LogBrewClient client = sampleClient();
        TransportResponse response = client.flush(RecordingTransport.alwaysAccept());
        assertEquals(204, response.statusCode(), "empty status");
        assertEquals(0, response.attempts(), "empty attempts");
        testsRun++;
    }

    private void testInvalidTimestampFailsValidation() {
        LogBrewClient client = sampleClient();
        SdkException error = expectSdkException(() -> client.log(
            "evt_log_001",
            "2026-06-02T10:00:03",
            LogAttributes.create("worker started", "info")
        ));
        assertContains(error.getMessage(), "timestamp must include a timezone offset");
        testsRun++;
    }

    private void testInvalidIssueLevelFailsValidation() {
        LogBrewClient client = sampleClient();
        SdkException error = expectSdkException(() -> client.issue(
            "evt_issue_001",
            "2026-06-02T10:00:02Z",
            IssueAttributes.create("Checkout timeout", "verbose")
        ));
        assertContains(error.getMessage(), "issue level must be one of: trace, debug, info, warn, warning, error, fatal, critical");
        testsRun++;
    }

    private void testSeverityAliasesNormalizeBeforePreview() {
        LogBrewClient client = sampleClient();
        client.issue("evt_issue_alias", "2026-06-02T10:00:02Z", IssueAttributes.create("Checkout timeout", "fatal"));
        client.log("evt_log_debug", "2026-06-02T10:00:03Z", LogAttributes.create("verbose runtime detail", "debug"));
        client.log("evt_log_warn", "2026-06-02T10:00:04Z", LogAttributes.create("legacy warning alias", "warn"));

        String payload = client.previewJson();
        assertContains(payload, "\"level\": \"critical\"");
        assertContains(payload, "\"level\": \"info\"");
        assertContains(payload, "\"level\": \"warning\"");
        testsRun++;
    }

    private void testNegativeSpanDurationFailsValidation() {
        LogBrewClient client = sampleClient();
        SdkException error = expectSdkException(() -> client.span(
            "evt_span_001",
            "2026-06-02T10:00:04Z",
            SpanAttributes.create("GET /health", "trace_001", "span_001", "ok").durationMs(-1.0)
        ));
        assertContains(error.getMessage(), "span durationMs must be non-negative");
        testsRun++;
    }

    private void testMetricEventValidatesExplicitContract() {
        LogBrewClient client = sampleClient();
        client.metric(
            "evt_metric_001",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", -2.0, "{items}", "instant")
                .metadata(Map.of("service", "worker", "queue", "critical"))
        );

        String payload = client.previewJson();
        assertContains(payload, "\"type\": \"metric\"");
        assertContains(payload, "\"name\": \"queue.depth\"");
        assertContains(payload, "\"kind\": \"gauge\"");
        assertContains(payload, "\"value\": -2.0");
        assertContains(payload, "\"unit\": \"{items}\"");
        assertContains(payload, "\"temporality\": \"instant\"");
        assertContains(payload, "\"service\": \"worker\"");
        assertContains(payload, "\"queue\": \"critical\"");
        testsRun++;
    }

    private void testMetricRejectsNonFiniteValue() {
        LogBrewClient client = sampleClient();
        SdkException error = expectSdkException(() -> client.metric(
            "evt_metric_001",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", Double.NaN, "{items}", "instant")
        ));
        assertContains(error.getMessage(), "metric value must be a finite number");
        testsRun++;
    }

    private void testMetricRejectsNegativeCounterValue() {
        LogBrewClient client = sampleClient();
        SdkException error = expectSdkException(() -> client.metric(
            "evt_metric_001",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("jobs.completed", "counter", -1.0, "1", "delta")
        ));
        assertContains(error.getMessage(), "metric counter value must be non-negative");
        testsRun++;
    }

    private void testMetricRejectsInvalidTemporalityForKind() {
        LogBrewClient client = sampleClient();
        SdkException error = expectSdkException(() -> client.metric(
            "evt_metric_001",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", 2.0, "{items}", "delta")
        ));
        assertContains(error.getMessage(), "metric temporality for gauge must be one of: instant");
        testsRun++;
    }

    private void testMetadataIsDefensivelyCopied() {
        LogBrewClient client = sampleClient();
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("stage", "before");
        client.action(
            "evt_action_metadata",
            "2026-06-02T10:00:05Z",
            ActionAttributes.create("deploy", "success").metadata(metadata)
        );

        metadata.put("stage", "after");
        metadata.put("late", "mutation");

        String payload = client.previewJson();
        assertContains(payload, "\"stage\": \"before\"");
        assertNotContains(payload, "\"stage\": \"after\"");
        assertNotContains(payload, "\"late\": \"mutation\"");
        testsRun++;
    }

    private void testUnauthenticatedResponseSurfacesCleanError() {
        LogBrewClient client = sampleClient();
        enqueueAll(client);
        SdkException error = expectSdkException(() -> client.flush(RecordingTransport.scripted(Integer.valueOf(401))));
        assertEquals("unauthenticated", error.code(), "unauthenticated code");
        assertContains(error.getMessage(), "transport rejected the API key");
        assertEquals(6, client.pendingEvents(), "pending after unauthenticated");
        testsRun++;
    }

    private void testNetworkFailureRetriesBeforeSucceeding() {
        LogBrewClient client = sampleClient();
        enqueueAll(client);
        RecordingTransport transport = RecordingTransport.scripted(
            TransportException.network("temporary outage"),
            Integer.valueOf(202)
        );
        TransportResponse response = client.flush(transport);
        assertEquals(2, response.attempts(), "retry attempts");
        assertEquals(2, transport.sentBodies().size(), "sent body count");
        assertEquals(0, client.pendingEvents(), "pending after retry success");
        testsRun++;
    }

    private void testRetryBudgetFailurePreservesQueue() {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0", 1);
        enqueueAll(client);
        RecordingTransport transport = RecordingTransport.scripted(
            TransportException.network("temporary outage"),
            TransportException.network("still down")
        );
        SdkException error = expectSdkException(() -> client.flush(transport));
        assertEquals("network_failure", error.code(), "retry budget code");
        assertEquals(2, transport.sentBodies().size(), "retry budget attempts");
        assertEquals(6, client.pendingEvents(), "pending after retry failure");
        testsRun++;
    }

    private void testNonRetryableStatusPreservesQueue() {
        LogBrewClient client = sampleClient();
        enqueueAll(client);
        SdkException error = expectSdkException(() -> client.flush(RecordingTransport.scripted(Integer.valueOf(400))));
        assertEquals("transport_error", error.code(), "non-retryable status code");
        assertContains(error.getMessage(), "unexpected transport status 400");
        assertEquals(6, client.pendingEvents(), "pending after non-retryable status");
        testsRun++;
    }

    private void testHttpTransportPostsJsonAndMapsStatus() {
        AtomicReference<String> requestBody = new AtomicReference<>("");
        AtomicReference<RuntimeException> handlerFailure = new AtomicReference<>();
        HttpServer server = startServer(exchange -> {
            try {
                assertEquals("POST", exchange.getRequestMethod(), "HTTP method");
                assertEquals("/v1/events", exchange.getRequestURI().getPath(), "HTTP path");
                assertEquals("Bearer LOGBREW_API_KEY", firstHeader(exchange, "authorization"), "authorization header");
                assertContains(firstHeader(exchange, "content-type"), "application/json");
                assertEquals("java-worker", firstHeader(exchange, "x-logbrew-source"), "source header");
                requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                sendStatus(exchange, 202);
            } catch (RuntimeException | IOException error) {
                handlerFailure.set(new RuntimeException(error));
                sendStatus(exchange, 500);
            }
        });
        try {
            HttpTransport transport = HttpTransport.builder()
                .endpoint(serverUri(server))
                .header("x-logbrew-source", "java-worker")
                .timeout(Duration.ofSeconds(5))
                .build();

            TransportResponse response = sendOrFail(transport, "LOGBREW_API_KEY", "{\"events\":[{\"id\":\"evt_java_http\"}]}");

            rethrowHandlerFailure(handlerFailure);
            assertEquals(202, response.statusCode(), "HTTP status");
            assertEquals(1, response.attempts(), "HTTP attempts");
            assertContains(requestBody.get(), "evt_java_http");
            assertEquals(serverUri(server), transport.endpoint(), "HTTP endpoint");
            assertEquals(1, transport.headers().size(), "HTTP headers");
            assertTrue(transport.requestTimeout().toSeconds() == 5L, "HTTP timeout");
        } finally {
            server.stop(0);
        }
        testsRun++;
    }

    private void testHttpTransportStatusRetriesThroughClient() {
        AtomicInteger requestCount = new AtomicInteger();
        AtomicReference<String> firstBody = new AtomicReference<>("");
        AtomicReference<String> secondBody = new AtomicReference<>("");
        AtomicReference<RuntimeException> handlerFailure = new AtomicReference<>();
        HttpServer server = startServer(exchange -> {
            try {
                int current = requestCount.incrementAndGet();
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                if (current == 1) {
                    firstBody.set(body);
                    sendStatus(exchange, 503);
                    return;
                }
                secondBody.set(body);
                assertEquals("Bearer LOGBREW_API_KEY", firstHeader(exchange, "authorization"), "retry authorization");
                sendStatus(exchange, 202);
            } catch (RuntimeException | IOException error) {
                handlerFailure.set(new RuntimeException(error));
                sendStatus(exchange, 500);
            }
        });
        try {
            LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0", 1);
            client.log("evt_java_http_retry", "2026-06-02T10:00:03Z", LogAttributes.create("retry me", "info"));
            HttpTransport transport = HttpTransport.builder()
                .endpoint(serverUri(server))
                .client(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build())
                .build();

            TransportResponse response = client.flush(transport);

            rethrowHandlerFailure(handlerFailure);
            assertEquals(202, response.statusCode(), "retry status");
            assertEquals(2, response.attempts(), "retry attempts");
            assertEquals(2, requestCount.get(), "retry request count");
            assertEquals(0, client.pendingEvents(), "pending after HTTP retry");
            assertContains(firstBody.get(), "evt_java_http_retry");
            assertEquals(firstBody.get(), secondBody.get(), "retry body");
        } finally {
            server.stop(0);
        }
        testsRun++;
    }

    private void testHttpTransportNetworkErrorIsRetryable() {
        HttpTransport transport = HttpTransport.builder()
            .endpoint(URI.create("https://example.invalid/v1/events"))
            .client(new FailingHttpClient())
            .build();
        try {
            transport.send("LOGBREW_API_KEY", "{}");
        } catch (TransportException error) {
            assertEquals("network_failure", error.code(), "network code");
            assertTrue(error.retryable(), "network retryable");
            assertContains(error.getMessage(), "http transport failed");
            assertContains(error.getMessage(), "offline");
            testsRun++;
            return;
        }
        throw new AssertionError("expected TransportException");
    }

    private void testHttpTransportRejectsInvalidConfiguration() {
        SdkException invalidEndpoint = expectSdkException(() ->
            HttpTransport.builder().endpoint(URI.create("ftp://example.com/v1/events")).build());
        assertEquals("configuration_error", invalidEndpoint.code(), "invalid endpoint code");

        SdkException invalidHeader = expectSdkException(() ->
            HttpTransport.builder().header(" ", "bad").build());
        assertEquals("configuration_error", invalidHeader.code(), "invalid header code");

        SdkException invalidTimeout = expectSdkException(() ->
            HttpTransport.builder().timeout(Duration.ZERO).build());
        assertEquals("configuration_error", invalidTimeout.code(), "invalid timeout code");
        testsRun++;
    }

    private void testShutdownFlushesAndPreventsFutureEvents() {
        LogBrewClient client = sampleClient();
        enqueueAll(client);
        TransportResponse response = client.shutdown(RecordingTransport.alwaysAccept());
        assertEquals(202, response.statusCode(), "shutdown status");
        SdkException error = expectSdkException(() -> client.action(
            "evt_action_002",
            "2026-06-02T10:00:06Z",
            ActionAttributes.create("deploy", "success")
        ));
        assertEquals("shutdown_error", error.code(), "shutdown code");
        assertContains(error.getMessage(), "client is already shut down");
        testsRun++;
    }

    private void testJulHandlerQueuesRecordMetadata() {
        LogBrewClient client = sampleClient();
        LogBrewJulHandler handler = new LogBrewJulHandler(
            client,
            null,
            false,
            false,
            Collections.singletonMap("service", "checkout")
        );
        LogRecord record = new LogRecord(Level.WARNING, "cart queued for order {0}");
        record.setInstant(Instant.parse("2026-06-02T10:00:07Z"));
        record.setLoggerName("checkout.worker");
        record.setParameters(new Object[] {Integer.valueOf(42)});
        record.setSequenceNumber(42L);
        record.setSourceClassName("CheckoutWorker");
        record.setSourceMethodName("run");
        record.setThreadID(7);

        handler.publish(record);

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"jul_42\"");
        assertContains(payload, "\"message\": \"cart queued for order 42\"");
        assertContains(payload, "\"level\": \"warning\"");
        assertContains(payload, "\"logger\": \"checkout.worker\"");
        assertContains(payload, "\"service\": \"checkout\"");
        assertContains(payload, "\"javaLevel\": \"WARNING\"");
        assertContains(payload, "\"javaLevelValue\": 900");
        assertContains(payload, "\"sourceClassName\": \"CheckoutWorker\"");
        assertContains(payload, "\"sourceMethodName\": \"run\"");
        assertContains(payload, "\"threadId\": 7");
        assertNotContains(payload, "javaStackTrace");
        testsRun++;
    }

    private void testJulHandlerCapturesExceptionMetadataWithoutStackTraceByDefault() {
        LogBrewClient client = sampleClient();
        LogRecord record = new LogRecord(Level.SEVERE, "checkout failed");
        record.setInstant(Instant.parse("2026-06-02T10:00:08Z"));
        record.setLoggerName("checkout.worker");
        record.setSequenceNumber(43L);
        record.setThrown(new IllegalStateException("database unavailable"));

        client.log(
            LogBrewJulHandler.defaultEventId(record),
            LogBrewJulHandler.timestampFromRecord(record),
            LogBrewJulHandler.logAttributesFromRecord(record)
        );

        String payload = client.previewJson();
        assertContains(payload, "\"level\": \"error\"");
        assertContains(payload, "\"exceptionType\": \"IllegalStateException\"");
        assertContains(payload, "\"exceptionMessage\": \"database unavailable\"");
        assertNotContains(payload, "javaStackTrace");

        LogBrewClient stackTraceClient = sampleClient();
        stackTraceClient.log(
            LogBrewJulHandler.defaultEventId(record),
            LogBrewJulHandler.timestampFromRecord(record),
            LogBrewJulHandler.logAttributesFromRecord(record, true)
        );
        assertContains(stackTraceClient.previewJson(), "\"javaStackTrace\"");
        testsRun++;
    }

    private void testJulHandlerFlushesWhenRequested() {
        LogBrewClient client = sampleClient();
        RecordingTransport transport = RecordingTransport.alwaysAccept();
        LogBrewJulHandler handler = new LogBrewJulHandler(client, transport, true);
        LogRecord record = new LogRecord(Level.INFO, "worker started");
        record.setInstant(Instant.parse("2026-06-02T10:00:09Z"));
        record.setLoggerName("jobs.worker");
        record.setSequenceNumber(44L);

        handler.publish(record);

        assertEquals(0, client.pendingEvents(), "pending after flush-on-publish");
        assertEquals(1, transport.sentBodies().size(), "logging transport sends");
        assertContains(transport.lastBody().orElse(""), "\"logger\": \"jobs.worker\"");
        testsRun++;
    }

    private void testLogbackAppenderQueuesSlf4jMetadata() {
        LogBrewClient client = sampleClient();
        LogBrewLogbackAppender appender = new LogBrewLogbackAppender(client);
        appender.setName("LOGBREW");
        appender.setEventIdPrefix("logback_test");
        appender.setMetadata(Collections.singletonMap("service", "checkout"));
        appender.start();
        ch.qos.logback.classic.Logger logger = logbackLogger("checkout.slf4j.metadata");
        ch.qos.logback.classic.Level originalLevel = logger.getLevel();
        boolean originalAdditive = logger.isAdditive();
        try {
            logger.setAdditive(false);
            logger.setLevel(ch.qos.logback.classic.Level.TRACE);
            logger.addAppender(appender);
            MDC.put("requestId", "req_123");
            logger.atWarn().addKeyValue("cartId", Integer.valueOf(42)).log("cart queued");
        } finally {
            MDC.remove("requestId");
            logger.detachAppender(appender);
            logger.setLevel(originalLevel);
            logger.setAdditive(originalAdditive);
            appender.stop();
        }

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"logback_test_1\"");
        assertContains(payload, "\"message\": \"cart queued\"");
        assertContains(payload, "\"level\": \"warning\"");
        assertContains(payload, "\"logger\": \"checkout.slf4j.metadata\"");
        assertContains(payload, "\"source\": \"logback\"");
        assertContains(payload, "\"service\": \"checkout\"");
        assertContains(payload, "\"slf4jLevel\": \"WARN\"");
        assertContains(payload, "\"logbackLevelValue\": 30000");
        assertContains(payload, "\"mdc.requestId\": \"req_123\"");
        assertContains(payload, "\"kv.cartId\": 42");
        assertNotContains(payload, "logbackStackTrace");
        testsRun++;
    }

    private void testLogbackAppenderCapturesThrowableMetadataWithoutStackTraceByDefault() {
        LogBrewClient client = sampleClient();
        LogBrewLogbackAppender appender = new LogBrewLogbackAppender(client);
        appender.setName("LOGBREW");
        appender.start();
        ch.qos.logback.classic.Logger logger = logbackLogger("checkout.slf4j.error");
        ch.qos.logback.classic.Level originalLevel = logger.getLevel();
        boolean originalAdditive = logger.isAdditive();
        try {
            logger.setAdditive(false);
            logger.setLevel(ch.qos.logback.classic.Level.TRACE);
            logger.addAppender(appender);
            logger.error("checkout failed", new IllegalStateException("database unavailable"));
        } finally {
            logger.detachAppender(appender);
            logger.setLevel(originalLevel);
            logger.setAdditive(originalAdditive);
            appender.stop();
        }

        String payload = client.previewJson();
        assertContains(payload, "\"level\": \"error\"");
        assertContains(payload, "\"exceptionType\": \"IllegalStateException\"");
        assertContains(payload, "\"exceptionMessage\": \"database unavailable\"");
        assertNotContains(payload, "logbackStackTrace");

        LogBrewClient stackTraceClient = sampleClient();
        LogBrewLogbackAppender stackTraceAppender = new LogBrewLogbackAppender(stackTraceClient);
        stackTraceAppender.setName("LOGBREW_STACK");
        stackTraceAppender.setIncludeThrowableStackTrace(true);
        stackTraceAppender.start();
        try {
            logger.setAdditive(false);
            logger.setLevel(ch.qos.logback.classic.Level.TRACE);
            logger.addAppender(stackTraceAppender);
            logger.error("checkout failed", new IllegalStateException("database unavailable"));
        } finally {
            logger.detachAppender(stackTraceAppender);
            logger.setLevel(originalLevel);
            logger.setAdditive(originalAdditive);
            stackTraceAppender.stop();
        }
        assertContains(stackTraceClient.previewJson(), "\"logbackStackTrace\"");
        testsRun++;
    }

    private static HttpServer startServer(com.sun.net.httpserver.HttpHandler handler) {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/v1/events", handler);
            server.start();
            return server;
        } catch (IOException error) {
            throw new AssertionError(error);
        }
    }

    private static URI serverUri(HttpServer server) {
        return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v1/events");
    }

    private static String firstHeader(HttpExchange exchange, String name) {
        String value = exchange.getRequestHeaders().getFirst(name);
        if (value == null) {
            throw new AssertionError("missing header: " + name);
        }
        return value;
    }

    private static void sendStatus(HttpExchange exchange, int statusCode) {
        try {
            exchange.sendResponseHeaders(statusCode, -1L);
        } catch (IOException error) {
            throw new AssertionError(error);
        } finally {
            exchange.close();
        }
    }

    private static TransportResponse sendOrFail(Transport transport, String apiKey, String body) {
        try {
            return transport.send(apiKey, body);
        } catch (TransportException error) {
            throw new AssertionError(error);
        }
    }

    private static void rethrowHandlerFailure(AtomicReference<RuntimeException> handlerFailure) {
        RuntimeException error = handlerFailure.get();
        if (error != null) {
            throw error;
        }
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static ch.qos.logback.classic.Logger logbackLogger(String name) {
        ch.qos.logback.classic.LoggerContext context =
            (ch.qos.logback.classic.LoggerContext) LoggerFactory.getILoggerFactory();
        return context.getLogger(name);
    }

    private static void enqueueAll(LogBrewClient client) {
        client.release(
            "evt_release_001",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.create("1.2.3").commit("abc123def456").notes("Public release marker")
        );
        client.environment(
            "evt_environment_001",
            "2026-06-02T10:00:01Z",
            EnvironmentAttributes.create("production").region("global")
        );
        client.issue(
            "evt_issue_001",
            "2026-06-02T10:00:02Z",
            IssueAttributes.create("Checkout timeout", "error").message("Request timed out after retry budget")
        );
        client.log(
            "evt_log_001",
            "2026-06-02T10:00:03Z",
            LogAttributes.create("worker started", "info").logger("job-runner")
        );
        client.span(
            "evt_span_001",
            "2026-06-02T10:00:04Z",
            SpanAttributes.create("GET /health", "trace_001", "span_001", "ok").durationMs(12.5)
        );
        client.action(
            "evt_action_001",
            "2026-06-02T10:00:05Z",
            ActionAttributes.create("deploy", "success")
        );
    }

    private static SdkException expectSdkException(Runnable callback) {
        try {
            callback.run();
        } catch (SdkException error) {
            return error;
        }
        throw new AssertionError("expected SdkException");
    }

    private static void assertInOrder(String value, String... needles) {
        int cursor = -1;
        for (String needle : needles) {
            int next = value.indexOf(needle, cursor + 1);
            if (next < 0) {
                throw new AssertionError("missing ordered text: " + needle);
            }
            cursor = next;
        }
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("expected " + value + " to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected " + value + " to omit " + needle);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError("expected true: " + label);
        }
    }

    private static void assertEquals(int expected, int actual, String label) {
        if (expected != actual) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertEquals(String expected, String actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static final class FailingHttpClient extends HttpClient {
        @Override
        public Optional<CookieHandler> cookieHandler() {
            return Optional.empty();
        }

        @Override
        public Optional<Duration> connectTimeout() {
            return Optional.empty();
        }

        @Override
        public Redirect followRedirects() {
            return Redirect.NEVER;
        }

        @Override
        public Optional<ProxySelector> proxy() {
            return Optional.empty();
        }

        @Override
        public SSLContext sslContext() {
            try {
                return SSLContext.getDefault();
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        }

        @Override
        public SSLParameters sslParameters() {
            return new SSLParameters();
        }

        @Override
        public Optional<Authenticator> authenticator() {
            return Optional.empty();
        }

        @Override
        public Version version() {
            return Version.HTTP_1_1;
        }

        @Override
        public Optional<Executor> executor() {
            return Optional.empty();
        }

        @Override
        public <T> HttpResponse<T> send(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler
        ) throws IOException {
            throw new IOException("offline");
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler
        ) {
            return CompletableFuture.failedFuture(new IOException("offline"));
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler,
            HttpResponse.PushPromiseHandler<T> pushPromiseHandler
        ) {
            return CompletableFuture.failedFuture(new IOException("offline"));
        }
    }
}
