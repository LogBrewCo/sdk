package co.logbrew.sdk;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

public final class SpanEventSummaryTest {
    private int testsRun;

    public static void main(String[] args) {
        new SpanEventSummaryTest().run();
    }

    private void run() {
        testSpanEventsSerializeBoundedPrimitiveMetadata();
        testSpanEventsRejectTooManyEvents();
        System.out.println("java span event summary tests ok (" + testsRun + " tests)");
    }

    private void testSpanEventsSerializeBoundedPrimitiveMetadata() {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "test-app", "1.0.0");
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("stage", "after-query");
        metadata.put("rows", Integer.valueOf(2));
        metadata.put("cacheHit", Boolean.FALSE);

        client.span(
            "evt_span_events",
            "2026-06-02T10:00:04Z",
            SpanAttributes.create("GET /checkout", "trace_001", "span_001", "ok")
                .event(SpanEventSummary.create("db.rows")
                    .timestamp("2026-06-02T10:00:04.500Z")
                    .metadata(metadata))
        );

        metadata.put("stage", "mutated");

        String payload = client.previewJson();
        assertContains(payload, "\"events\": [");
        assertContains(payload, "\"name\": \"db.rows\"");
        assertContains(payload, "\"timestamp\": \"2026-06-02T10:00:04.500Z\"");
        assertContains(payload, "\"stage\": \"after-query\"");
        assertContains(payload, "\"rows\": 2");
        assertContains(payload, "\"cacheHit\": false");
        assertNotContains(payload, "\"stage\": \"mutated\"");
        testsRun++;
    }

    private void testSpanEventsRejectTooManyEvents() {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "test-app", "1.0.0");
        SdkException error = expectSdkException(() -> client.span(
            "evt_span_events_too_many",
            "2026-06-02T10:00:04Z",
            SpanAttributes.create("GET /checkout", "trace_001", "span_001", "ok")
                .events(Arrays.asList(
                    SpanEventSummary.create("event-1"),
                    SpanEventSummary.create("event-2"),
                    SpanEventSummary.create("event-3"),
                    SpanEventSummary.create("event-4"),
                    SpanEventSummary.create("event-5"),
                    SpanEventSummary.create("event-6"),
                    SpanEventSummary.create("event-7"),
                    SpanEventSummary.create("event-8"),
                    SpanEventSummary.create("event-9")
                ))
        ));
        assertContains(error.getMessage(), "span events must contain at most 8 entries");
        testsRun++;
    }

    private static SdkException expectSdkException(Runnable callback) {
        try {
            callback.run();
        } catch (SdkException error) {
            return error;
        }
        throw new AssertionError("expected SdkException");
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("missing " + needle + " in " + value);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("unexpected " + needle + " in " + value);
        }
    }
}
