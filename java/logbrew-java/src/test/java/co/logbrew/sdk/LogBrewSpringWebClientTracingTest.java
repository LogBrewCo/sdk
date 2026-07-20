package co.logbrew.sdk;

import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;
import reactor.core.Disposable;
import reactor.core.publisher.Mono;

public final class LogBrewSpringWebClientTracingTest {
    private static final String TRACE_ID = "11111111111111111111111111111111";
    private static final String PARENT_SPAN_ID = "2222222222222222";
    private int testsRun;

    public static void main(String[] args) {
        new LogBrewSpringWebClientTracingTest().run();
    }

    private void run() {
        testEachSubscriptionGetsOneIndependentChildSpan();
        testSkippedRequestRemainsColdAndUntouched();
        testErrorPreservesOriginalSignalAndCapturesTypeOnly();
        testEmptyCompletionFinishesOnce();
        testCancellationFinishesOnce();
        testCaptureFailureIsAdvisory();
        System.out.println("java Spring WebClient tracing tests ok (" + testsRun + " tests)");
    }

    private void testEachSubscriptionGetsOneIndependentChildSpan() {
        LogBrewClient client = sampleClient("success");
        AtomicInteger tick = new AtomicInteger();
        List<String> propagated = new ArrayList<>();
        List<LogBrewTraceContext> activeChildren = new ArrayList<>();
        ExchangeFilterFunction filter = LogBrewSpringWebClientTracing.filter(
            client,
            LogBrewSpringWebClientTracing.Options.create()
                .eventIdPrefix("spring_webclient")
                .now(() -> Instant.parse("2026-07-20T09:00:00Z").plusMillis(tick.getAndIncrement() * 10L))
        );
        ClientRequest request = sensitiveRequest();
        Mono<ClientResponse> result = filter.filter(request, actualRequest -> {
            propagated.add(actualRequest.headers().getFirst("traceparent"));
            activeChildren.add(LogBrewTrace.current().orElseThrow());
            return Mono.just(ClientResponse.create(HttpStatus.ACCEPTED).build());
        });
        LogBrewTraceContext parent = parentTrace();

        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            assertEquals(202, result.block().statusCode().value(), "first response");
            assertTrue(LogBrewTrace.current().orElseThrow() == parent, "caller trace remains after first response");
            assertEquals(202, result.block().statusCode().value(), "second response");
            assertTrue(LogBrewTrace.current().orElseThrow() == parent, "caller trace remains after second response");
        } finally {
            scope.close();
        }

        assertEquals(2, propagated.size(), "subscription count");
        assertTrue(!propagated.get(0).equals(propagated.get(1)), "unique child traceparents");
        for (int index = 0; index < propagated.size(); index++) {
            LogBrewTraceContext child = activeChildren.get(index);
            assertEquals(TRACE_ID, child.traceId(), "child trace id");
            assertEquals(PARENT_SPAN_ID, child.parentSpanId(), "child parent span id");
            assertEquals(child.traceparent(), propagated.get(index), "propagated child context");
        }

        String payload = client.previewJson();
        assertContains(payload, "\"name\": \"HTTP POST\"");
        assertContains(payload, "\"source\": \"spring.webclient\"");
        assertContains(payload, "\"framework\": \"spring.webflux\"");
        assertContains(payload, "\"host\": \"xn--bcher-kva.example\"");
        assertContains(payload, "\"statusCode\": 202");
        assertNotContains(payload, "order_123");
        assertNotContains(payload, sampleQuery());
        assertNotContains(payload, "fixture body");
        assertNotContains(payload, "authorization");
        assertNotContains(payload, "sensitive-value");
        testsRun++;
    }

    private void testSkippedRequestRemainsColdAndUntouched() {
        LogBrewClient client = sampleClient("skip");
        AtomicInteger exchanges = new AtomicInteger();
        String callerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
        ClientRequest request = ClientRequest.create(HttpMethod.GET, URI.create("https://health.example/status"))
            .header("traceparent", callerTraceparent)
            .build();
        ExchangeFilterFunction filter = LogBrewSpringWebClientTracing.filter(
            client,
            LogBrewSpringWebClientTracing.Options.create().requestFilter(ignored -> false)
        );
        Mono<ClientResponse> result = filter.filter(request, actualRequest -> {
            exchanges.incrementAndGet();
            assertEquals(callerTraceparent, actualRequest.headers().getFirst("traceparent"), "caller traceparent");
            return Mono.just(ClientResponse.create(HttpStatus.NO_CONTENT).build());
        });

        assertEquals(0, exchanges.get(), "cold exchange count");
        assertEquals(204, result.block().statusCode().value(), "skipped response");
        assertEquals(1, exchanges.get(), "subscribed exchange count");
        assertEquals(0, client.pendingEvents(), "skipped event count");
        testsRun++;
    }

    private void testErrorPreservesOriginalSignalAndCapturesTypeOnly() {
        LogBrewClient client = sampleClient("failure");
        IllegalStateException original = new IllegalStateException("upstream fixture failure " + sampleQuery());
        ExchangeFilterFunction filter = LogBrewSpringWebClientTracing.filter(client);

        try {
            filter.filter(
                ClientRequest.create(
                    HttpMethod.GET,
                    URI.create("https://errors.example/orders/order_123?" + sampleQuery())
                ).build(),
                ignored -> Mono.error(original)
            ).block();
            throw new AssertionError("expected original error");
        } catch (IllegalStateException error) {
            assertTrue(error == original, "original error preserved");
        }

        String payload = client.previewJson();
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"errorType\": \"IllegalStateException\"");
        assertNotContains(payload, "upstream fixture failure");
        assertNotContains(payload, sampleQuery());
        assertNotContains(payload, "order_123");
        testsRun++;
    }

    private void testEmptyCompletionFinishesOnce() {
        LogBrewClient client = sampleClient("empty");
        ExchangeFilterFunction filter = LogBrewSpringWebClientTracing.filter(client);

        ClientResponse response = filter.filter(
            ClientRequest.create(HttpMethod.GET, URI.create("https://empty.example/status")).build(),
            ignored -> Mono.empty()
        ).block();

        assertTrue(response == null, "empty completion remains empty");
        assertEquals(1, client.pendingEvents(), "empty completion event count");
        String payload = client.previewJson();
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"empty\": true");
        assertNotContains(payload, "/status");
        testsRun++;
    }

    private void testCancellationFinishesOnce() {
        LogBrewClient client = sampleClient("cancel");
        ExchangeFilterFunction filter = LogBrewSpringWebClientTracing.filter(client);

        Disposable subscription = filter.filter(
            ClientRequest.create(HttpMethod.GET, URI.create("https://cancel.example/status")).build(),
            ignored -> Mono.never()
        ).subscribe();
        subscription.dispose();
        subscription.dispose();

        assertEquals(1, client.pendingEvents(), "cancellation event count");
        String payload = client.previewJson();
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"cancelled\": true");
        assertContains(payload, "\"errorType\": \"CancellationException\"");
        testsRun++;
    }

    private void testCaptureFailureIsAdvisory() {
        LogBrewClient client = sampleClient("advisory");
        client.shutdown(RecordingTransport.alwaysAccept());
        List<SdkException> errors = new ArrayList<>();
        ExchangeFilterFunction filter = LogBrewSpringWebClientTracing.filter(
            client,
            LogBrewSpringWebClientTracing.Options.create().onError(error -> {
                errors.add(error);
                throw new IllegalStateException("diagnostic callback failed");
            })
        );

        ClientResponse response = filter.filter(
            ClientRequest.create(HttpMethod.GET, URI.create("https://status.example/health")).build(),
            ignored -> Mono.just(ClientResponse.create(HttpStatus.OK).build())
        ).block();

        assertEquals(200, response.statusCode().value(), "response survives capture failure");
        assertEquals(1, errors.size(), "capture error count");
        assertEquals("shutdown_error", errors.get(0).code(), "capture error code");
        testsRun++;
    }

    private static ClientRequest sensitiveRequest() {
        return ClientRequest.create(
            HttpMethod.POST,
            URI.create("https://b\u00fccher.example/orders/order_123?" + sampleQuery())
        )
            .header("authorization", "sensitive-value")
            .header("baggage", "account.id=sensitive-value")
            .body(BodyInserters.fromValue("fixture body"))
            .build();
    }

    private static LogBrewTraceContext parentTrace() {
        return LogBrewTraceContext.create(TRACE_ID, PARENT_SPAN_ID);
    }

    private static LogBrewClient sampleClient(String suffix) {
        return LogBrewClient.create("LOGBREW_API_KEY", "spring-webclient-" + suffix, "0.1.0");
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
