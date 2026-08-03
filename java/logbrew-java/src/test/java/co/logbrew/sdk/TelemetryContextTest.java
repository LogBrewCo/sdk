package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/** Dependency-free tests for shared Java telemetry context. */
public final class TelemetryContextTest {
    private int testsRun;

    public static void main(String[] args) {
        new TelemetryContextTest().run();
    }

    private void run() {
        testRuntimeDefaultsCoverEveryEventType();
        testClientAndEventContextsMergeAndDetachInputs();
        testRuntimeDefaultsCanBeDisabledWithoutDroppingExplicitContext();
        testContextValidationRejectsUnsafeOrAmbiguousValues();
        testTraceHelpersPromoteExactCorrelation();
        testRequestTelemetryPromotesExactContextAcrossSignals();
        testConcurrentContextCaptureRemainsBoundedAndDeterministic();
        System.out.println("java telemetry context tests ok (" + testsRun + " tests)");
    }

    private void testRuntimeDefaultsCoverEveryEventType() {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
        enqueueAll(client);

        String payload = client.previewJson();
        assertEquals(7, count(payload, "\"context\":"), "context count");
        assertEquals(7, count(payload, "\"schemaVersion\": 1"), "schema version count");
        assertEquals(7, count(payload, "\"name\": \"java\""), "runtime name count");
        assertContains(payload, "\"operatingSystem\"");
        assertContains(payload, "\"architecture\"");
        assertNotContains(payload, "LOGBREW_API_KEY");
        testsRun++;
    }

    @SuppressWarnings("unchecked")
    private void testClientAndEventContextsMergeAndDetachInputs() {
        Map<String, String> clientTags = new LinkedHashMap<>();
        clientTags.put("plan", "team");
        clientTags.put("region", "eu");
        TelemetryContext clientContext = TelemetryContext.builder()
            .resource(TelemetryResource.builder()
                .service("checkout-api", "1.4.0")
                .runtime("custom-java", "21")
                .device(null, "container", null)
                .build())
            .session("session_01", "session_00")
            .tags(clientTags)
            .build();

        Map<String, String> eventTags = new LinkedHashMap<>();
        eventTags.put("operation", "checkout");
        eventTags.put("plan", "enterprise");
        TelemetryContext eventContext = TelemetryContext.builder()
            .resource(TelemetryResource.builder()
                .service("checkout-api", "1.5.0")
                .device(null, null, "wasm32")
                .application("checkout-worker", null, "20260803.1")
                .build())
            .trace(
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                null,
                "DDDDDDDDDDDDDDDD",
                null
            )
            .subject("user_42", "user")
            .tags(eventTags)
            .build();

        clientTags.put("region", "mutated");
        eventTags.put("operation", "mutated");
        TelemetryContext merged = TelemetryContext.merge(clientContext, eventContext);
        Map<String, Object> value = merged.asMap();
        Map<String, Object> resource = (Map<String, Object>) value.get("resource");
        assertEquals(
            Map.of("name", "checkout-api", "version", "1.5.0"),
            resource.get("service"),
            "merged service"
        );
        assertEquals(
            Map.of("name", "custom-java", "version", "21"),
            resource.get("runtime"),
            "merged runtime"
        );
        assertEquals(
            Map.of("model", "container", "architecture", "wasm32"),
            resource.get("device"),
            "merged device"
        );
        assertEquals(
            Map.of("name", "checkout-worker", "build", "20260803.1"),
            resource.get("application"),
            "merged application"
        );
        assertEquals(
            Map.of("operation", "checkout", "plan", "enterprise", "region", "eu"),
            value.get("tags"),
            "merged tags"
        );
        assertEquals(
            Map.of("traceId", "cccccccccccccccccccccccccccccccc", "parentSpanId", "dddddddddddddddd"),
            value.get("trace"),
            "normalized trace"
        );

        LogBrewClient client = LogBrewClient.create(
            "LOGBREW_API_KEY",
            "logbrew-java",
            "0.1.0",
            LogBrewClientOptions.builder()
                .context(clientContext)
                .disableRuntimeContext(true)
                .build()
        );
        client.log(
            "evt_context",
            "2026-08-03T00:00:00Z",
            LogAttributes.create("checkout failed", "error").context(eventContext)
        );
        String payload = client.previewJson();
        assertContains(payload, "\"version\": \"1.5.0\"");
        assertContains(payload, "\"operation\": \"checkout\"");
        assertNotContains(payload, "mutated");
        testsRun++;
    }

    private void testRuntimeDefaultsCanBeDisabledWithoutDroppingExplicitContext() {
        LogBrewClient absent = LogBrewClient.create(
            "LOGBREW_API_KEY",
            "logbrew-java",
            "0.1.0",
            LogBrewClientOptions.builder().disableRuntimeContext(true).build()
        );
        absent.log(
            "evt_absent",
            "2026-08-03T00:00:00Z",
            LogAttributes.create("safe", "info")
        );
        assertNotContains(absent.previewJson(), "\"context\"");

        LogBrewClient explicit = LogBrewClient.create(
            "LOGBREW_API_KEY",
            "logbrew-java",
            "0.1.0",
            LogBrewClientOptions.builder()
                .disableRuntimeContext(true)
                .context(TelemetryContext.builder().tag("plan", "team").build())
                .build()
        );
        explicit.log(
            "evt_explicit",
            "2026-08-03T00:00:00Z",
            LogAttributes.create("safe", "info")
        );
        String payload = explicit.previewJson();
        assertContains(payload, "\"context\"");
        assertContains(payload, "\"plan\": \"team\"");
        assertNotContains(payload, "\"resource\"");
        testsRun++;
    }

    private void testContextValidationRejectsUnsafeOrAmbiguousValues() {
        assertError(
            () -> TelemetryContext.builder().build(),
            "must include resource, trace, session, subject, or tags"
        );
        assertError(
            () -> TelemetryContext.builder()
                .trace("00000000000000000000000000000000", null, null, null)
                .build(),
            "traceId must be 32 non-zero hex characters"
        );
        assertError(
            () -> TelemetryContext.builder().session("same", "same").build(),
            "previousId must differ from id"
        );
        assertError(
            () -> TelemetryContext.builder().subject("subject_1", "person").build(),
            "kind must be anonymous or user"
        );
        assertError(
            () -> TelemetryContext.builder().tag("bad key", "safe").build(),
            "tag key is invalid"
        );
        assertError(
            () -> TelemetryContext.builder().tag("plan", "safe\u0085unsafe").build(),
            "tag value for plan is invalid"
        );
        TelemetryContext.Builder tooManyTags = TelemetryContext.builder();
        for (int index = 0; index < 33; index++) {
            tooManyTags.tag("tag." + index, "safe");
        }
        assertError(tooManyTags::build, "tags must contain 1-32 entries");
        TelemetryContext.Builder maximumClientTags = TelemetryContext.builder();
        for (int index = 0; index < 32; index++) {
            maximumClientTags.tag("client." + index, "safe");
        }
        TelemetryContext fullClientContext = maximumClientTags.build();
        TelemetryContext extraEventTag = TelemetryContext.builder().tag("event.extra", "safe").build();
        assertError(
            () -> TelemetryContext.merge(fullClientContext, extraEventTag),
            "tags must contain 1-32 entries"
        );
        testsRun++;
    }

    @SuppressWarnings("unchecked")
    private void testTraceHelpersPromoteExactCorrelation() {
        LogBrewTraceContext trace = LogBrewTraceContext.create(
            "4BF92F3577B34DA6A3CE929D0E0E4736",
            "B7AD6B7169203331",
            "00F067AA0BA902B7",
            "01"
        );
        TelemetryContext shared = TelemetryContext.builder().tag("operation", "checkout").build();
        TelemetryContext traced = LogBrewTrace.contextWithTrace(trace, shared);
        Map<String, Object> traceValue = (Map<String, Object>) traced.asMap().get("trace");
        assertEquals(trace.traceId(), traceValue.get("traceId"), "trace id");
        assertEquals(trace.spanId(), traceValue.get("spanId"), "span id");
        assertEquals(trace.parentSpanId(), traceValue.get("parentSpanId"), "parent span id");
        assertEquals(Boolean.TRUE, traceValue.get("sampled"), "sampled flag");

        LogBrewClient client = LogBrewClient.create(
            "LOGBREW_API_KEY",
            "logbrew-java",
            "0.1.0",
            LogBrewClientOptions.builder().disableRuntimeContext(true).build()
        );
        client.log(
            "evt_traced",
            "2026-08-03T00:00:00Z",
            LogAttributes.create("checkout failed", "error")
                .metadata(LogBrewTrace.metadataWithTrace(trace, Map.of("stage", "payment")))
                .context(traced)
        );
        String payload = client.previewJson();
        assertContains(payload, "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203331\"");
        assertContains(payload, "\"sampled\": true");
        assertContains(payload, "\"operation\": \"checkout\"");
        testsRun++;
    }

    private void testRequestTelemetryPromotesExactContextAcrossSignals() {
        LogBrewClient client = LogBrewClient.create(
            "LOGBREW_API_KEY",
            "logbrew-java",
            "0.1.0",
            LogBrewClientOptions.builder().disableRuntimeContext(true).build()
        );
        LogBrewTraceContext trace = LogBrewTraceContext.create(
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "b7ad6b7169203331",
            "00f067aa0ba902b7",
            "01"
        );
        LogBrewHttpRequestTelemetry telemetry = LogBrewHttpRequestTelemetry.start(
            client,
            "POST",
            "/checkout/:cart_id",
            trace
        );
        telemetry.finishSpanAndMetric(
            "evt_request_span",
            "evt_request_metric",
            "2026-08-03T00:00:00Z",
            202,
            42.0
        );

        String payload = client.previewJson();
        assertEquals(2, count(payload, "\"context\":"), "request context count");
        assertEquals(2, count(payload, "\"schemaVersion\": 1"), "request schema count");
        assertEquals(2, count(payload, "\"sampled\": true"), "request sampled count");
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"type\": \"metric\"");
        testsRun++;
    }

    private void testConcurrentContextCaptureRemainsBoundedAndDeterministic() {
        TelemetryContext clientContext = TelemetryContext.builder().tag("region", "eu").build();
        TelemetryContext eventContext = TelemetryContext.builder().tag("operation", "checkout").build();
        LogBrewClient client = LogBrewClient.create(
            "LOGBREW_API_KEY",
            "logbrew-java",
            "0.1.0",
            LogBrewClientOptions.builder()
                .context(clientContext)
                .disableRuntimeContext(true)
                .build()
        );
        AtomicReference<Throwable> failure = new AtomicReference<>();
        List<Thread> workers = new ArrayList<>();
        for (int worker = 0; worker < 8; worker++) {
            int workerId = worker;
            Thread thread = new Thread(() -> {
                try {
                    for (int event = 0; event < 100; event++) {
                        client.log(
                            "evt_context_" + workerId + "_" + event,
                            "2026-08-03T00:00:00Z",
                            LogAttributes.create("checkout", "info").context(eventContext)
                        );
                    }
                } catch (Throwable error) {
                    failure.compareAndSet(null, error);
                }
            }, "logbrew-context-" + workerId);
            workers.add(thread);
            thread.start();
        }
        for (Thread worker : workers) {
            try {
                worker.join();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError("context worker interrupted", error);
            }
        }
        if (failure.get() != null) {
            throw new AssertionError("concurrent context capture failed", failure.get());
        }

        String payload = client.previewJson();
        assertEquals(800, client.pendingEvents(), "concurrent event count");
        assertEquals(0, client.droppedEvents(), "concurrent dropped count");
        assertEquals(800, count(payload, "\"context\":"), "concurrent context count");
        assertEquals(800, count(payload, "\"region\": \"eu\""), "concurrent client tag count");
        assertEquals(800, count(payload, "\"operation\": \"checkout\""), "concurrent event tag count");
        testsRun++;
    }

    private static void enqueueAll(LogBrewClient client) {
        client.release(
            "evt_release",
            "2026-08-03T00:00:00Z",
            ReleaseAttributes.create("1.2.3")
        );
        client.environment(
            "evt_environment",
            "2026-08-03T00:00:01Z",
            EnvironmentAttributes.create("production")
        );
        client.issue(
            "evt_issue",
            "2026-08-03T00:00:02Z",
            IssueAttributes.create("Checkout failed", "error")
        );
        client.log(
            "evt_log",
            "2026-08-03T00:00:03Z",
            LogAttributes.create("Checkout failed", "error")
        );
        client.span(
            "evt_span",
            "2026-08-03T00:00:04Z",
            SpanAttributes.create(
                "checkout",
                "4bf92f3577b34da6a3ce929d0e0e4736",
                "b7ad6b7169203331",
                "error"
            )
        );
        client.action(
            "evt_action",
            "2026-08-03T00:00:05Z",
            ActionAttributes.create("checkout.submit", "failure")
        );
        client.metric(
            "evt_metric",
            "2026-08-03T00:00:06Z",
            MetricAttributes.create("checkout.duration", "histogram", 42.0, "ms", "delta")
        );
    }

    private static int count(String value, String needle) {
        int total = 0;
        int cursor = 0;
        while ((cursor = value.indexOf(needle, cursor)) >= 0) {
            total++;
            cursor += needle.length();
        }
        return total;
    }

    private static void assertError(Runnable callback, String message) {
        try {
            callback.run();
        } catch (SdkException error) {
            assertContains(error.getMessage(), message);
            return;
        }
        throw new AssertionError("expected SdkException containing " + message);
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

    private static void assertEquals(int expected, int actual, String label) {
        if (expected != actual) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }
}
