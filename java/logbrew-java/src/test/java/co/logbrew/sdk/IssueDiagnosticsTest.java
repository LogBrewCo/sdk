package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Dependency-free typed issue diagnostics test runner.
 */
public final class IssueDiagnosticsTest {
    private int testsRun;

    public static void main(String[] args) {
        new IssueDiagnosticsTest().run();
    }

    private void run() {
        testThrowableProjectionIsStructuredAndPrivacyBounded();
        testExplicitDiagnosticsAreNormalizedAndDetached();
        testStackFrameBoundsAndIdentityValidation();
        testBreadcrumbBoundsAndPrimitiveValidation();
        System.out.println("java issue diagnostics tests ok (" + testsRun + " tests)");
    }

    private void testThrowableProjectionIsStructuredAndPrivacyBounded() {
        IllegalStateException error = new IllegalStateException("user-entered checkout value");
        error.setStackTrace(new StackTraceElement[] {
            new StackTraceElement(
                "app.checkout.CheckoutHandler",
                "submit",
                "file:///opt/example/CheckoutHandler.java?query=hidden",
                42
            ),
            new StackTraceElement("app.jobs.Worker", "runOnce", "../../private/Worker.java", 12),
            new StackTraceElement("java.lang.Thread", "run", null, -2)
        });
        LogBrewClient client = sampleClient();

        client.issue(
            "evt_java_exception_001",
            "2026-06-02T10:00:02Z",
            IssueAttributes.fromThrowable(error, "java.exception", true)
                .metadata(Map.of("stage", "handler"))
        );

        String payload = client.previewJson();
        assertContains(payload, "\"title\": \"IllegalStateException\"");
        assertContains(payload, "\"exception\": {");
        assertContains(payload, "\"type\": \"IllegalStateException\"");
        assertContains(payload, "\"mechanism\": {");
        assertContains(payload, "\"type\": \"java.exception\"");
        assertContains(payload, "\"handled\": true");
        assertContains(payload, "\"stackFrames\": [");
        assertInOrder(payload, "CheckoutHandler.java", "Worker.java");
        assertInOrder(payload, "Worker.java", "Thread.java");
        assertContains(payload, "\"line\": 42");
        assertContains(payload, "\"line\": 1");
        assertContains(payload, "\"column\": 1");
        assertContains(payload, "\"function\": \"submit\"");
        assertContains(payload, "\"module\": \"app.checkout.CheckoutHandler\"");
        assertNotContains(payload, "user-entered checkout value");
        assertNotContains(payload, "/opt/example");
        assertNotContains(payload, "../private");
        assertNotContains(payload, "query=hidden");
        testsRun++;
    }

    private void testExplicitDiagnosticsAreNormalizedAndDetached() {
        Map<String, Object> breadcrumbData = new LinkedHashMap<>();
        breadcrumbData.put("attempt", Integer.valueOf(2));
        breadcrumbData.put("cacheHit", Boolean.FALSE);
        IssueBreadcrumb breadcrumb = IssueBreadcrumb
            .create("2026-06-02T10:00:01.125+03:00", "checkout.action")
            .type("user")
            .level("warn")
            .message("Retry selected")
            .data(breadcrumbData);
        IssueStackFrame frame = IssueStackFrame
            .create("file:///opt/example/Checkout.java#local", 7, 3)
            .function("submit")
            .module("app.checkout.Checkout")
            .inApp(true)
            .debugId("11111111-2222-4333-8444-555555555555");
        LogBrewClient client = sampleClient();

        client.issue(
            "evt_java_diagnostics_001",
            "2026-06-02T10:00:02Z",
            IssueAttributes.create("Checkout failed", "error")
                .exception(
                    IssueException.create("CheckoutFailure")
                        .mechanism(IssueExceptionMechanism.create("application.capture", true))
                )
                .stackFrame(frame)
                .breadcrumb(breadcrumb)
                .breadcrumbsTruncated(true)
        );
        breadcrumbData.put("attempt", Integer.valueOf(99));
        frame.function("mutatedAfterQueue");

        String payload = client.previewJson();
        assertContains(payload, "\"filename\": \"Checkout.java\"");
        assertContains(payload, "\"function\": \"submit\"");
        assertNotContains(payload, "mutatedAfterQueue");
        assertContains(payload, "\"inApp\": true");
        assertContains(payload, "\"debugId\": \"11111111-2222-4333-8444-555555555555\"");
        assertContains(payload, "\"timestamp\": \"2026-06-02T10:00:01.125+03:00\"");
        assertContains(payload, "\"category\": \"checkout.action\"");
        assertContains(payload, "\"level\": \"warning\"");
        assertContains(payload, "\"attempt\": 2");
        assertNotContains(payload, "\"attempt\": 99");
        assertContains(payload, "\"breadcrumbsTruncated\": true");
        testsRun++;
    }

    private void testStackFrameBoundsAndIdentityValidation() {
        LogBrewClient client = sampleClient();
        expectSdkException(() -> client.issue(
            "evt_java_bad_exception",
            "2026-06-02T10:00:02Z",
            IssueAttributes.create("Bad exception", "error")
                .exception(IssueException.create("Bad?Exception"))
        ), "issue exception type");
        expectSdkException(() -> client.issue(
            "evt_java_bad_frame",
            "2026-06-02T10:00:02Z",
            IssueAttributes.create("Bad frame", "error")
                .stackFrame(IssueStackFrame.create("Checkout.java", 0, 1))
        ), "stack frame line");
        expectSdkException(() -> IssueAttributes.create("Empty frames", "error").stackFrames(List.of()),
            "1-32 frames");

        List<IssueStackFrame> tooMany = new ArrayList<>();
        for (int index = 0; index < 33; index++) {
            tooMany.add(IssueStackFrame.create("Checkout.java", index + 1, 1));
        }
        expectSdkException(() -> IssueAttributes.create("Too many frames", "error").stackFrames(tooMany),
            "1-32 frames");

        IssueAttributes incrementallyBounded = IssueAttributes.create("Bounded frames", "error");
        for (int index = 0; index < 32; index++) {
            incrementallyBounded.stackFrame(IssueStackFrame.create("Checkout.java", index + 1, 1));
        }
        expectSdkException(
            () -> incrementallyBounded.stackFrame(IssueStackFrame.create("Overflow.java", 33, 1)),
            "1-32 frames"
        );
        client.issue("evt_java_bounded_frames", "2026-06-02T10:00:02Z", incrementallyBounded);
        assertNotContains(client.previewJson(), "Overflow.java");
        testsRun++;
    }

    private void testBreadcrumbBoundsAndPrimitiveValidation() {
        LogBrewClient client = sampleClient();
        expectSdkException(() -> client.issue(
            "evt_java_bad_breadcrumb_time",
            "2026-06-02T10:00:02Z",
            IssueAttributes.create("Bad breadcrumb", "error")
                .breadcrumb(IssueBreadcrumb.create("2026-06-02T10:00:01", "checkout.action"))
        ), "RFC 3339");
        expectSdkException(() -> IssueBreadcrumb
            .create("2026-06-02T10:00:01Z", "checkout.action")
            .data(Map.of("nested", Map.of("value", "hidden"))),
            "finite primitive");
        expectSdkException(() -> IssueBreadcrumb
            .create("2026-06-02T10:00:01Z", "checkout.action")
            .data(Map.of("duration", Double.NaN)),
            "finite primitive");

        List<IssueBreadcrumb> tooMany = new ArrayList<>();
        for (int index = 0; index < 65; index++) {
            tooMany.add(IssueBreadcrumb.create("2026-06-02T10:00:01Z", "checkout.action"));
        }
        expectSdkException(() -> IssueAttributes.create("Too many breadcrumbs", "error").breadcrumbs(tooMany),
            "1-64 entries");

        IssueAttributes incrementallyBounded = IssueAttributes.create("Bounded breadcrumbs", "error");
        for (int index = 0; index < 64; index++) {
            incrementallyBounded.breadcrumb(
                IssueBreadcrumb.create("2026-06-02T10:00:01Z", "checkout.action")
            );
        }
        expectSdkException(
            () -> incrementallyBounded.breadcrumb(
                IssueBreadcrumb.create("2026-06-02T10:00:01Z", "overflow.action")
            ),
            "1-64 entries"
        );
        client.issue("evt_java_bounded_breadcrumbs", "2026-06-02T10:00:02Z", incrementallyBounded);
        assertNotContains(client.previewJson(), "overflow.action");
        testsRun++;
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static void expectSdkException(Runnable callback, String messageFragment) {
        try {
            callback.run();
        } catch (SdkException error) {
            assertContains(error.getMessage(), messageFragment);
            return;
        }
        throw new AssertionError("expected SdkException containing " + messageFragment);
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

    private static void assertInOrder(String value, String first, String second) {
        int firstIndex = value.indexOf(first);
        int secondIndex = value.indexOf(second);
        if (firstIndex < 0 || secondIndex <= firstIndex) {
            throw new AssertionError("expected " + first + " before " + second + " in " + value);
        }
    }
}
