package co.logbrew.sdk;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Dependency-free support-ticket draft tests.
 */
public final class SupportTicketDraftTest {
    private int testsRun;

    public static void main(String[] args) {
        new SupportTicketDraftTest().run();
    }

    private void run() {
        testCreatesPlannedPayloadAndRedactsDiagnostics();
        testRejectsInvalidRouteOwnedValues();
        System.out.println("java support ticket draft tests ok (" + testsRun + " tests)");
    }

    private void testCreatesPlannedPayloadAndRedactsDiagnostics() {
        Map<String, Object> headers = new LinkedHashMap<>();
        headers.put("authorization", "Bearer hidden");
        headers.put("cookie", "sid=hidden");
        headers.put("accept", "application/json");

        Map<String, Object> firstEvent = new LinkedHashMap<>();
        firstEvent.put("id", "evt_checkout_flush");
        firstEvent.put("type", "span");
        Map<String, Object> secondEvent = new LinkedHashMap<>();
        secondEvent.put("token", "hidden");

        Map<String, Object> diagnostics = new LinkedHashMap<>();
        diagnostics.put("attemptCount", Integer.valueOf(2));
        diagnostics.put("retryable", Boolean.FALSE);
        diagnostics.put("apiKey", "lbw_ingest_hidden");
        diagnostics.put("endpoint", "https://api.example/ingest?debug=true#frag");
        diagnostics.put("localPath", "/Users/example/app/.env");
        diagnostics.put("error", new IllegalStateException("contains hidden message"));
        diagnostics.put("headers", headers);
        diagnostics.put("events", Arrays.asList(firstEvent, secondEvent));
        diagnostics.put("callback", new Runnable() {
            @Override
            public void run() {
            }
        });

        SupportTicketDraft draft = SupportTicketDraft.create(SupportTicketDraft.Input
            .create("sdk", "ingest_failure", "Telemetry flush failed", "Flush returned usage_limit_exceeded")
            .projectId("proj_123")
            .environment("production")
            .runtime("java 21")
            .framework("spring")
            .sdkPackage("co.logbrew:logbrew-sdk")
            .sdkVersion("0.1.0")
            .release("checkout@1.2.3")
            .traceId("4BF92F3577B34DA6A3CE929D0E0E4736")
            .eventId("evt_checkout_flush")
            .diagnostics(diagnostics));

        assertEquals("sdk", draft.source(), "source");
        assertEquals("ingest_failure", draft.category(), "category");
        assertEquals("Telemetry flush failed", draft.title(), "title");
        assertEquals("Flush returned usage_limit_exceeded", draft.description(), "description");
        assertEquals("proj_123", draft.projectId(), "project id");
        assertEquals("production", draft.environment(), "environment");
        assertEquals("java 21", draft.runtime(), "runtime");
        assertEquals("spring", draft.framework(), "framework");
        assertEquals("co.logbrew:logbrew-sdk", draft.sdkPackage(), "sdk package");
        assertEquals("0.1.0", draft.sdkVersion(), "sdk version");
        assertEquals("checkout@1.2.3", draft.release(), "release");
        assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", draft.traceId(), "trace id");
        assertEquals("evt_checkout_flush", draft.eventId(), "event id");

        Map<String, Object> safeDiagnostics = draft.diagnostics();
        assertEquals(Integer.valueOf(2), safeDiagnostics.get("attemptCount"), "attempt count");
        assertEquals(Boolean.FALSE, safeDiagnostics.get("retryable"), "retryable");
        assertEquals("[redacted]", safeDiagnostics.get("apiKey"), "api key");
        assertEquals("[redacted-url]/ingest", safeDiagnostics.get("endpoint"), "endpoint");
        assertEquals("[redacted-path]", safeDiagnostics.get("localPath"), "local path");
        assertNotContains(safeDiagnostics, "callback");

        Map<?, ?> error = (Map<?, ?>) safeDiagnostics.get("error");
        assertEquals("java.lang.IllegalStateException", error.get("type"), "error type");
        assertNotContains(error, "message");

        Map<?, ?> safeHeaders = (Map<?, ?>) safeDiagnostics.get("headers");
        assertEquals("[redacted]", safeHeaders.get("authorization"), "authorization");
        assertEquals("[redacted]", safeHeaders.get("cookie"), "cookie");
        assertEquals("application/json", safeHeaders.get("accept"), "accept");

        List<?> safeEvents = (List<?>) safeDiagnostics.get("events");
        assertEquals(2, safeEvents.size(), "events size");
        Map<?, ?> safeSecondEvent = (Map<?, ?>) safeEvents.get(1);
        assertEquals("[redacted]", safeSecondEvent.get("token"), "event token");

        String json = draft.toJson();
        assertContains(json, "\"project_id\": \"proj_123\"");
        assertContains(json, "\"trace_id\": \"4bf92f3577b34da6a3ce929d0e0e4736\"");
        assertNotContains(json, "hidden");
        assertNotContains(json, "api.example");
        assertNotContains(json, "/Users/example");
        assertNotContains(json, "traceparent");
        testsRun++;
    }

    private void testRejectsInvalidRouteOwnedValues() {
        SdkException sourceError = expectSdkException(() -> SupportTicketDraft.create(SupportTicketDraft.Input
            .create("daemon", "ingest_failure", "Telemetry failed", "Flush failed")));
        assertContains(sourceError.getMessage(), "support ticket source must be one of: cli, sdk, website, docs, mobile");

        SdkException traceError = expectSdkException(() -> SupportTicketDraft.create(SupportTicketDraft.Input
            .create("sdk", "ingest_failure", "Telemetry failed", "Flush failed")
            .traceId("00000000000000000000000000000000")));
        assertContains(traceError.getMessage(), "support ticket trace_id must not be all zeros");

        Map<String, Object> diagnostics = new LinkedHashMap<>();
        diagnostics.put("bad", new Object());
        SupportTicketDraft draft = SupportTicketDraft.create(SupportTicketDraft.Input
            .create("sdk", "other", "Telemetry failed", "Flush failed")
            .diagnostics(diagnostics));
        assertTrue(draft.diagnostics().isEmpty(), "unsupported diagnostics are omitted");
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
            throw new AssertionError("expected " + value + " to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected " + value + " to omit " + needle);
        }
    }

    private static void assertNotContains(Map<?, ?> value, String key) {
        if (value.containsKey(key)) {
            throw new AssertionError("expected " + value + " to omit " + key);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError("expected true: " + label);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }
}
