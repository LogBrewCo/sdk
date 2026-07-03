package co.logbrew.sdk;

import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;

/**
 * Dependency-free test runner for explicit Java HttpClient tracing helpers.
 */
public final class LogBrewHttpClientTracingTest {
    private int testsRun;

    public static void main(String[] args) {
        new LogBrewHttpClientTracingTest().run();
    }

    private void run() {
        testSendInjectsTraceparentAndQueuesSanitizedSpan();
        testSendPreservesOriginalErrorsAndRecordsTypeOnlyFailure();
        testSendAsyncRecordsCompletionSpan();
        System.out.println("java http client tracing tests ok (" + testsRun + " tests)");
    }

    private void testSendInjectsTraceparentAndQueuesSanitizedSpan() {
        LogBrewClient client = sampleClient();
        FakeHttpClient httpClient = FakeHttpClient.responding(202, "accepted");
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            "a7ad6b7169203330"
        );
        String authHeader = "Author" + "ization";
        String authValue = "Bea" + "rer redacted";
        HttpRequest request = HttpRequest.newBuilder(URI.create(
                "https://api.example.invalid/orders/123?debug=redacted#frag"))
            .header("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
            .header(authHeader, authValue)
            .GET()
            .build();

        HttpResponse<String> response;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            response = LogBrewHttpClientTracing.send(
                client,
                httpClient,
                request,
                HttpResponse.BodyHandlers.ofString(),
                LogBrewHttpClientTracing.ClientRequest.create()
                    .routeTemplate("https://api.example.invalid/orders/{id}?debug=redacted#frag")
                    .eventIdPrefix("java_http_client_test")
                    .spanId("b7ad6b7169203331")
                    .metadata(Map.of(
                        "component", "checkout",
                        "url", "https://api.example.invalid/orders/123?debug=redacted",
                        "headers", authHeader + ": " + authValue,
                        "payload", "private body"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-03T10:00:00Z"),
                        Instant.parse("2026-06-03T10:00:00.042Z")
                    )
            );
        } catch (IOException error) {
            throw new AssertionError(error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        } finally {
            scope.close();
        }

        assertEquals(202, response.statusCode(), "response status");
        HttpRequest captured = httpClient.lastRequest;
        assertEquals(parent.traceId(), Traceparent.parse(firstHeader(captured, "traceparent")).traceId(), "trace id");
        assertEquals("b7ad6b7169203331", Traceparent.parse(firstHeader(captured, "traceparent")).parentSpanId(), "span id");
        assertEquals("00", firstHeader(captured, "traceparent").substring(0, 2), "traceparent version");
        assertEquals(authValue, firstHeader(captured, authHeader), "app-owned headers preserved");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_http_client_test_span_b7ad6b7169203331\"");
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"name\": \"http.client:GET /orders/{id}\"");
        assertContains(payload, "\"traceId\": \"" + parent.traceId().toLowerCase(java.util.Locale.ROOT) + "\"");
        assertContains(payload, "\"parentSpanId\": \"" + parent.spanId() + "\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203331\"");
        assertContains(payload, "\"status\": \"ok\"");
        assertContains(payload, "\"durationMs\": 42.0");
        assertContains(payload, "\"source\": \"http.client\"");
        assertContains(payload, "\"method\": \"GET\"");
        assertContains(payload, "\"routeTemplate\": \"/orders/{id}\"");
        assertContains(payload, "\"statusCode\": 202");
        assertContains(payload, "\"http.request.method\": \"GET\"");
        assertContains(payload, "\"http.route\": \"/orders/{id}\"");
        assertContains(payload, "\"http.response.status_code\": 202");
        assertContains(payload, "\"component\": \"checkout\"");
        assertNotContains(payload, "api.example.invalid");
        assertNotContains(payload, "debug=redacted");
        assertNotContains(payload, authHeader);
        assertNotContains(payload, authValue);
        assertNotContains(payload, "private body");
        assertNotContains(payload, "11111111111111111111111111111111");
        testsRun++;
    }

    private void testSendPreservesOriginalErrorsAndRecordsTypeOnlyFailure() {
        LogBrewClient client = sampleClient();
        IOException original = new IOException("sensitive connection detail");
        FakeHttpClient httpClient = FakeHttpClient.throwing(original);
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.example.invalid/fail?debug=redacted"))
            .GET()
            .build();

        IOException error = expectException(IOException.class, () ->
            LogBrewHttpClientTracing.send(
                client,
                httpClient,
                request,
                HttpResponse.BodyHandlers.discarding(),
                LogBrewHttpClientTracing.ClientRequest.create()
                    .routeTemplate("/fail")
                    .eventIdPrefix("java_http_client_failure")
                    .spanId("b7ad6b7169203332")
                    .nowSequence(
                        Instant.parse("2026-06-03T10:00:01Z"),
                        Instant.parse("2026-06-03T10:00:01.005Z")
                    )
            )
        );

        assertTrue(error == original, "original IO error identity");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_http_client_failure_span_b7ad6b7169203332\"");
        assertContains(payload, "\"name\": \"http.client:GET /fail\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"durationMs\": 5.0");
        assertContains(payload, "\"name\": \"exception\"");
        assertContains(payload, "\"exceptionType\": \"IOException\"");
        assertContains(payload, "\"exceptionEscaped\": true");
        assertNotContains(payload, "sensitive connection detail");
        assertNotContains(payload, "api.example.invalid");
        assertNotContains(payload, "debug=redacted");
        testsRun++;
    }

    private void testSendAsyncRecordsCompletionSpan() {
        LogBrewClient client = sampleClient();
        FakeHttpClient httpClient = FakeHttpClient.responding(503, "busy");
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.example.invalid/retry"))
            .POST(HttpRequest.BodyPublishers.ofString("payload should not be captured"))
            .build();

        HttpResponse<String> response = LogBrewHttpClientTracing.sendAsync(
            client,
            httpClient,
            request,
            HttpResponse.BodyHandlers.ofString(),
            LogBrewHttpClientTracing.ClientRequest.create()
                .routeTemplate("/retry")
                .eventIdPrefix("java_http_client_async")
                .spanId("b7ad6b7169203333")
                .nowSequence(
                    Instant.parse("2026-06-03T10:00:02Z"),
                    Instant.parse("2026-06-03T10:00:02.011Z")
                )
        ).join();

        assertEquals(503, response.statusCode(), "async response status");
        assertEquals("traceparent", httpClient.lastRequest.headers().map().keySet().stream()
            .filter(name -> "traceparent".equalsIgnoreCase(name))
            .findFirst()
            .orElse("missing"), "async traceparent header");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_http_client_async_span_b7ad6b7169203333\"");
        assertContains(payload, "\"name\": \"http.client:POST /retry\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"statusCode\": 503");
        assertContains(payload, "\"durationMs\": 11.0");
        assertNotContains(payload, "payload should not be captured");
        testsRun++;
    }

    private static String firstHeader(HttpRequest request, String name) {
        return request.headers().firstValue(name).orElseThrow(() ->
            new AssertionError("missing header " + name));
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static <T extends Throwable> T expectException(Class<T> expectedType, ThrowingRunnable callback) {
        try {
            callback.run();
        } catch (Throwable error) {
            if (expectedType.isInstance(error)) {
                return expectedType.cast(error);
            }
            throw new AssertionError("expected " + expectedType.getSimpleName() + " but got " + error, error);
        }
        throw new AssertionError("expected " + expectedType.getSimpleName());
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

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static final class FakeHttpClient extends HttpClient {
        private final int statusCode;
        private final String body;
        private final IOException error;
        private HttpRequest lastRequest;

        private FakeHttpClient(int statusCode, String body, IOException error) {
            this.statusCode = statusCode;
            this.body = body;
            this.error = error;
        }

        static FakeHttpClient responding(int statusCode, String body) {
            return new FakeHttpClient(statusCode, body, null);
        }

        static FakeHttpClient throwing(IOException error) {
            return new FakeHttpClient(0, null, error);
        }

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
            return null;
        }

        @Override
        public SSLParameters sslParameters() {
            return null;
        }

        @Override
        public Optional<Authenticator> authenticator() {
            return Optional.empty();
        }

        @Override
        public HttpClient.Version version() {
            return HttpClient.Version.HTTP_1_1;
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
            lastRequest = request;
            if (error != null) {
                throw error;
            }
            return new FakeHttpResponse<>(request, statusCode, body);
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler
        ) {
            lastRequest = request;
            if (error != null) {
                CompletableFuture<HttpResponse<T>> future = new CompletableFuture<>();
                future.completeExceptionally(error);
                return future;
            }
            return CompletableFuture.completedFuture(new FakeHttpResponse<>(request, statusCode, body));
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler,
            HttpResponse.PushPromiseHandler<T> pushPromiseHandler
        ) {
            return sendAsync(request, responseBodyHandler);
        }
    }

    private static final class FakeHttpResponse<T> implements HttpResponse<T> {
        private final HttpRequest request;
        private final int statusCode;
        private final Object body;

        private FakeHttpResponse(HttpRequest request, int statusCode, Object body) {
            this.request = request;
            this.statusCode = statusCode;
            this.body = body;
        }

        @Override
        public int statusCode() {
            return statusCode;
        }

        @Override
        public HttpRequest request() {
            return request;
        }

        @Override
        public Optional<HttpResponse<T>> previousResponse() {
            return Optional.empty();
        }

        @Override
        @SuppressWarnings("unchecked")
        public T body() {
            return (T) body;
        }

        @Override
        public HttpHeaders headers() {
            return HttpHeaders.of(Collections.emptyMap(), (name, value) -> true);
        }

        @Override
        public URI uri() {
            return request.uri();
        }

        @Override
        public HttpClient.Version version() {
            return HttpClient.Version.HTTP_1_1;
        }

        @Override
        public Optional<SSLSession> sslSession() {
            return Optional.empty();
        }
    }
}
