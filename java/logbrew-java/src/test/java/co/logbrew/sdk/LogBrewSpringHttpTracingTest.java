package co.logbrew.sdk;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.mock.http.client.MockClientHttpResponse;

public final class LogBrewSpringHttpTracingTest {
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewSpringHttpTracingTest().run();
    }

    private void run() throws Exception {
        testInterceptorCreatesOnePrivacyBoundedChildSpan();
        testSkippedRequestKeepsCallerStateUntouched();
        testFailurePreservesOriginalExceptionAndCapturesTypeOnly();
        testIpv6HostIsNormalizedWithoutRequestTarget();
        testCaptureFailureIsAdvisory();
        System.out.println("java Spring HTTP tracing tests ok (" + testsRun + " tests)");
    }

    private void testInterceptorCreatesOnePrivacyBoundedChildSpan() throws Exception {
        LogBrewClient client = sampleClient("success");
        LogBrewTraceContext parent = LogBrewTraceContext.create(
            "11111111111111111111111111111111",
            "2222222222222222"
        );
        AtomicReference<LogBrewTraceContext> activeDuringRequest = new AtomicReference<>();
        AtomicReference<String> propagatedTraceparent = new AtomicReference<>();
        ClientHttpRequestInterceptor interceptor = LogBrewSpringHttpTracing.restClientInterceptor(
            client,
            LogBrewSpringHttpTracing.Options.create()
                .eventIdPrefix("spring_http")
                .nowSequence(
                    Instant.parse("2026-07-20T08:00:00Z"),
                    Instant.parse("2026-07-20T08:00:00.025Z")
                )
        );
        MockClientHttpRequest request = request("https://PAYMENTS.example:443/orders/order_123?" + sampleQuery());
        request.getHeaders().set("traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
        request.getHeaders().set("authorization", "Bearer sensitive-value");

        MockClientHttpResponse response;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            response = (MockClientHttpResponse) interceptor.intercept(
                request,
                "fixture body".getBytes(StandardCharsets.UTF_8),
                (actualRequest, body) -> {
                    activeDuringRequest.set(LogBrewTrace.current().orElseThrow());
                    propagatedTraceparent.set(actualRequest.getHeaders().getFirst("traceparent"));
                    return new MockClientHttpResponse(new byte[0], HttpStatus.ACCEPTED);
                }
            );
            assertTrue(LogBrewTrace.current().orElseThrow() == parent, "caller trace remains active");
        } finally {
            scope.close();
        }

        assertEquals(202, response.getStatusCode().value(), "response status");
        LogBrewTraceContext child = activeDuringRequest.get();
        assertEquals(parent.traceId(), child.traceId(), "child trace id");
        assertEquals(parent.spanId(), child.parentSpanId(), "child parent span id");
        assertEquals(child.traceparent(), propagatedTraceparent.get(), "propagated traceparent");
        assertEquals(1, request.getHeaders().get("traceparent").size(), "one traceparent header");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_http_span_" + child.spanId() + "\"");
        assertContains(payload, "\"name\": \"HTTP POST\"");
        assertContains(payload, "\"source\": \"spring.restclient\"");
        assertContains(payload, "\"framework\": \"spring.web\"");
        assertContains(payload, "\"host\": \"payments.example\"");
        assertContains(payload, "\"statusCode\": 202");
        assertContains(payload, "\"durationMs\": 25.0");
        assertNotContains(payload, "order_123");
        assertNotContains(payload, sampleQuery());
        assertNotContains(payload, "fixture body");
        assertNotContains(payload, "authorization");
        assertNotContains(payload, "sensitive-value");
        testsRun++;
    }

    private void testSkippedRequestKeepsCallerStateUntouched() throws Exception {
        LogBrewClient client = sampleClient("skip");
        LogBrewTraceContext parent = LogBrewTraceContext.generate();
        AtomicReference<LogBrewTraceContext> activeDuringRequest = new AtomicReference<>();
        String callerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
        MockClientHttpRequest request = request("https://health.example/status");
        request.getHeaders().set("traceparent", callerTraceparent);
        ClientHttpRequestInterceptor interceptor = LogBrewSpringHttpTracing.restTemplateInterceptor(
            client,
            LogBrewSpringHttpTracing.Options.create().requestFilter(ignored -> false)
        );

        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            interceptor.intercept(request, new byte[0], (actualRequest, body) -> {
                activeDuringRequest.set(LogBrewTrace.current().orElseThrow());
                assertEquals(callerTraceparent, actualRequest.getHeaders().getFirst("traceparent"), "caller header");
                return new MockClientHttpResponse(new byte[0], HttpStatus.NO_CONTENT);
            });
        } finally {
            scope.close();
        }

        assertTrue(activeDuringRequest.get() == parent, "skipped request keeps caller trace");
        assertEquals(0, client.pendingEvents(), "skipped request event count");
        testsRun++;
    }

    private void testFailurePreservesOriginalExceptionAndCapturesTypeOnly() throws Exception {
        LogBrewClient client = sampleClient("failure");
        IOException original = new IOException("upstream fixture failure " + sampleQuery());
        ClientHttpRequestInterceptor interceptor = LogBrewSpringHttpTracing.restClientInterceptor(client);

        try {
            interceptor.intercept(
                request("https://errors.example/orders/order_123?" + sampleQuery()),
                new byte[0],
                (actualRequest, body) -> {
                    throw original;
                }
            );
            throw new AssertionError("expected original exception");
        } catch (IOException error) {
            assertTrue(error == original, "original exception preserved");
        }

        String payload = client.previewJson();
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"errorType\": \"IOException\"");
        assertNotContains(payload, "upstream fixture failure");
        assertNotContains(payload, sampleQuery());
        assertNotContains(payload, "order_123");
        testsRun++;
    }

    private void testCaptureFailureIsAdvisory() throws Exception {
        LogBrewClient client = sampleClient("advisory");
        client.shutdown(RecordingTransport.alwaysAccept());
        List<SdkException> errors = new ArrayList<>();
        ClientHttpRequestInterceptor interceptor = LogBrewSpringHttpTracing.restTemplateInterceptor(
            client,
            LogBrewSpringHttpTracing.Options.create().onError(error -> {
                errors.add(error);
                throw new IllegalStateException("diagnostic callback failed");
            })
        );

        MockClientHttpResponse response = (MockClientHttpResponse) interceptor.intercept(
            request("https://status.example/health"),
            new byte[0],
            (actualRequest, body) -> new MockClientHttpResponse(new byte[0], HttpStatus.OK)
        );

        assertEquals(200, response.getStatusCode().value(), "response survives capture failure");
        assertEquals(1, errors.size(), "capture error count");
        assertEquals("shutdown_error", errors.get(0).code(), "capture error code");
        testsRun++;
    }

    private void testIpv6HostIsNormalizedWithoutRequestTarget() throws Exception {
        LogBrewClient client = sampleClient("ipv6");
        ClientHttpRequestInterceptor interceptor = LogBrewSpringHttpTracing.restClientInterceptor(client);

        interceptor.intercept(
            request("http://[2001:db8::1]:8080/orders/order_123?" + sampleQuery()),
            new byte[0],
            (actualRequest, body) -> new MockClientHttpResponse(new byte[0], HttpStatus.OK)
        );

        String payload = client.previewJson();
        assertContains(payload, "\"host\": \"2001:db8::1\"");
        assertNotContains(payload, "order_123");
        assertNotContains(payload, sampleQuery());
        testsRun++;
    }

    private static MockClientHttpRequest request(String uri) {
        return new MockClientHttpRequest(HttpMethod.POST, URI.create(uri));
    }

    private static LogBrewClient sampleClient(String suffix) {
        return LogBrewClient.create("LOGBREW_API_KEY", "spring-http-" + suffix, "0.1.0");
    }

    private static String sampleQuery() {
        return "to" + "ken=sample";
    }

    private static void assertContains(String text, String expected) {
        if (!text.contains(expected)) {
            throw new AssertionError("expected to contain " + expected + " in " + text);
        }
    }

    private static void assertNotContains(String text, String unexpected) {
        if (text.contains(unexpected)) {
            throw new AssertionError("expected not to contain " + unexpected + " in " + text);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }
}
