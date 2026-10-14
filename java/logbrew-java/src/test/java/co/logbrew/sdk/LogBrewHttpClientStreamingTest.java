package co.logbrew.sdk;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real HTTP regressions for response bodies that outlive their response future. */
public final class LogBrewHttpClientStreamingTest {
    private static final String TRACE_ID = "11111111111111111111111111111111";
    private static final String SPAN_ID = "3333333333333333";
    private static final byte[] BODY = "private body fixture".getBytes(StandardCharsets.UTF_8);

    private LogBrewHttpClientStreamingTest() {
    }

    static void run() {
        try {
            testGenericSubscriberKeepsApplicationSignals();
            testTerminalSignalsPrecedeDownstreamRelease();
            for (boolean async : new boolean[] {false, true}) {
                for (String outcome : List.of("exhaustion", "failure", "close", "cancel")) {
                    exerciseStream(async, outcome);
                }
            }
        } catch (Exception error) {
            throw new AssertionError(error);
        }
        System.out.println("java streamed HTTP tests ok (8 real requests)");
    }

    private static void exerciseStream(boolean async, String outcome) throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch serverDone = new CountDownLatch(1);
        AtomicReference<String> wireTrace = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/stream", exchange -> {
            wireTrace.set(exchange.getRequestHeaders().getFirst("traceparent"));
            try {
                exchange.sendResponseHeaders(200, "failure".equals(outcome) ? BODY.length + 10 : BODY.length + 1);
                exchange.getResponseBody().write(BODY);
                exchange.getResponseBody().flush();
                if (!release.await(3, TimeUnit.SECONDS)) {
                    throw new AssertionError("stream test did not release server");
                }
                if (!"failure".equals(outcome)) {
                    exchange.getResponseBody().write('!');
                }
            } catch (IOException expected) {
                // Cancellation and deliberately truncated responses may close the connection.
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
                serverDone.countDown();
            }
        });
        ExecutorService reader = Executors.newSingleThreadExecutor();
        InputStream stream = null;
        server.start();
        try {
            LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "stream-consumer", "0.1.0");
            AtomicReference<Instant> clock = new AtomicReference<>(Instant.parse("2026-06-03T10:00:00Z"));
            AtomicInteger clockReads = new AtomicInteger();
            LogBrewHttpClientTracing.ClientRequest config = LogBrewHttpClientTracing.ClientRequest.create()
                .routeTemplate("https://route.example.invalid/stream?private=query#fragment")
                .spanId(SPAN_ID).eventIdPrefix("stream_request")
                .now(() -> { clockReads.incrementAndGet(); return clock.get(); });
            HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
            HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" +
                server.getAddress().getPort() + "/stream?private=query"))
                .timeout(Duration.ofSeconds(3)).build();
            LogBrewTraceContext parent = LogBrewTraceContext.create(TRACE_ID, "2222222222222222");
            CompletableFuture<?> responseFuture = null;
            LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
            try {
                if ("cancel".equals(outcome)) {
                    HttpResponse<Flow.Publisher<List<ByteBuffer>>> response;
                    if (async) {
                        CompletableFuture<HttpResponse<Flow.Publisher<List<ByteBuffer>>>> future =
                            LogBrewHttpClientTracing.sendAsync(client, http, request,
                                HttpResponse.BodyHandlers.ofPublisher(), config);
                        response = future.get(2, TimeUnit.SECONDS);
                        responseFuture = future;
                    } else {
                        response = LogBrewHttpClientTracing.send(client, http, request,
                            HttpResponse.BodyHandlers.ofPublisher(), config);
                    }
                    require(client.pendingEvents() == 0, "publisher must not finish at headers");
                    config.eventIdPrefix("later_request");
                    clock.set(clock.get().plusSeconds(1));
                    response.body().subscribe(new Flow.Subscriber<List<ByteBuffer>>() {
                        @Override public void onSubscribe(Flow.Subscription subscription) { subscription.cancel(); }
                        @Override public void onNext(List<ByteBuffer> bytes) { throw new AssertionError("cancelled subscriber data"); }
                        @Override public void onError(Throwable error) { }
                        @Override public void onComplete() { }
                    });
                } else {
                    AtomicReference<InputStream> originalBody = new AtomicReference<>();
                    HttpResponse.BodyHandler<InputStream> handler = info -> {
                        HttpResponse.BodySubscriber<InputStream> subscriber = HttpResponse.BodySubscribers.ofInputStream();
                        subscriber.getBody().thenAccept(originalBody::set);
                        return subscriber;
                    };
                    HttpResponse<InputStream> response;
                    if (async) {
                        CompletableFuture<HttpResponse<InputStream>> future =
                            LogBrewHttpClientTracing.sendAsync(client, http, request, handler, config);
                        response = future.get(2, TimeUnit.SECONDS);
                        responseFuture = future;
                    } else {
                        response = LogBrewHttpClientTracing.send(client, http, request, handler, config);
                    }
                    stream = response.body();
                    require(stream == originalBody.get(), "app receives original stream object");
                    require(response.statusCode() == 200, "original status remains available");
                    require(client.pendingEvents() == 0, "stream must not finish at headers");
                    require(clockReads.get() == 1, "completion clock waits for body");
                    config.eventIdPrefix("later_request");
                    if (responseFuture != null) {
                        require(!responseFuture.cancel(true), "completed response future cannot cancel an open stream");
                    }
                    clock.set(clock.get().plusSeconds(1));
                    if ("close".equals(outcome)) {
                        stream.close();
                    } else {
                        InputStream body = stream;
                        java.util.concurrent.Future<byte[]> contents = reader.submit(body::readAllBytes);
                        release.countDown();
                        try {
                            byte[] bytes = contents.get(2, TimeUnit.SECONDS);
                            require("exhaustion".equals(outcome), "truncated body retains its failure");
                            require(new String(bytes, StandardCharsets.UTF_8).equals("private body fixture!"),
                                "body bytes remain app owned");
                        } catch (ExecutionException error) {
                            require("failure".equals(outcome) && error.getCause() instanceof IOException,
                                "app receives original body IOException");
                        }
                    }
                }
                require(LogBrewTrace.current().orElseThrow() == parent, "caller trace survives body terminal state");
            } finally {
                scope.close();
            }
            require(client.pendingEvents() == 1, "exactly one final body span");
            require(clockReads.get() == 2, "one completion clock read");
            String payload = client.previewJson();
            require(payload.contains("\"id\": \"stream_request_span_" + SPAN_ID + "\""), "original request event ID");
            require(payload.contains("\"durationMs\": 1000.0"), "duration covers open body");
            require(payload.contains("\"statusCode\": 200"), "body failure keeps response status");
            require(payload.contains("\"traceId\": \"" + TRACE_ID + "\""), "body trace correlation");
            require(payload.contains("\"spanId\": \"" + SPAN_ID + "\""), "body span correlation");
            require(Traceparent.parse(wireTrace.get()).parentSpanId().equals(SPAN_ID), "wire child span");
            require(payload.contains("\"status\": \"" + ("exhaustion".equals(outcome) ? "ok" : "error") + "\""),
                "body outcome controls span status");
            if ("failure".equals(outcome)) {
                require(payload.contains("\"errorType\": \"IOException\""), "body failure type only");
            } else if (!"exhaustion".equals(outcome)) {
                require(payload.contains("\"errorType\": \"CancellationException\""), "body cancellation type");
                require(payload.contains("\"cancelled\": true") && payload.contains("\"exceptionEscaped\": false"),
                    "explicit body cancellation is handled");
            }
            require(!payload.contains("private") && !payload.contains("route.example.invalid") &&
                !payload.contains("127.0.0.1"), "body and URL privacy");
            if (stream != null) {
                stream.close();
            }
            require(client.pendingEvents() == 1, "close after terminal state cannot duplicate telemetry");
            require(LogBrewTrace.current().isEmpty(), "stream completion leaves no caller trace");
        } finally {
            release.countDown();
            if (stream != null) {
                stream.close();
            }
            server.stop(0);
            reader.shutdownNow();
            require(reader.awaitTermination(2, TimeUnit.SECONDS), "reader terminated within bound");
            require(serverDone.await(2, TimeUnit.SECONDS), "server finished within bound");
        }
    }

    private static void testGenericSubscriberKeepsApplicationSignals() {
        Object value = new Object();
        CompletableFuture<Object> stage = CompletableFuture.completedFuture(value);
        IllegalStateException original = new IllegalStateException("private subscriber failure");
        AtomicReference<Throwable> captured = new AtomicReference<>();
        AtomicInteger completions = new AtomicInteger();
        AtomicInteger demand = new AtomicInteger();
        List<ByteBuffer> buffers = List.of(ByteBuffer.wrap(BODY));
        LogBrewHttpBodyTracing tracing = new LogBrewHttpBodyTracing((response, status, error, cancelled) -> {
            require(status == 200, "generic subscriber keeps response headers");
            captured.set(error);
            completions.incrementAndGet();
        });
        HttpResponse.BodySubscriber<Object> downstream = new HttpResponse.BodySubscriber<Object>() {
            @Override public java.util.concurrent.CompletionStage<Object> getBody() { return stage; }
            @Override public void onSubscribe(Flow.Subscription subscription) { subscription.request(2); }
            @Override public void onNext(List<ByteBuffer> incoming) {
                require(incoming == buffers, "subscriber sees original byte buffer list");
                throw original;
            }
            @Override public void onError(Throwable error) { require(error == original, "original error forwarded"); }
            @Override public void onComplete() { }
        };
        HttpResponse.BodySubscriber<Object> observed = tracing.observe(ignored -> downstream).apply(responseInfo());
        require(observed.getBody() == stage && observed.getBody().toCompletableFuture().join() == value,
            "generic body and completion stage identity");
        tracing.responseComplete(null, null);
        observed.onSubscribe(new Flow.Subscription() {
            @Override public void request(long count) { demand.addAndGet((int) count); }
            @Override public void cancel() { }
        });
        require(demand.get() == 2, "subscriber demand passes through exactly");
        try {
            observed.onNext(buffers);
            throw new AssertionError("expected application subscriber error");
        } catch (IllegalStateException error) {
            require(error == original, "application subscriber exception identity");
        }
        observed.onError(original);
        observed.onComplete();
        require(captured.get() == original && completions.get() == 1,
            "subscriber failure finishes once with original exception");
    }

    private static void testTerminalSignalsPrecedeDownstreamRelease() {
        for (boolean failed : new boolean[] {false, true}) {
            AtomicInteger captured = new AtomicInteger();
            AtomicReference<Throwable> capturedError = new AtomicReference<>();
            IOException original = new IOException("private transport failure");
            LogBrewHttpBodyTracing tracing = new LogBrewHttpBodyTracing((response, status, error, cancelled) -> {
                capturedError.set(error);
                captured.incrementAndGet();
            });
            HttpResponse.BodySubscriber<Object> downstream = new HttpResponse.BodySubscriber<Object>() {
                @Override public java.util.concurrent.CompletionStage<Object> getBody() {
                    return CompletableFuture.completedFuture(new Object());
                }
                @Override public void onSubscribe(Flow.Subscription subscription) { }
                @Override public void onNext(List<ByteBuffer> buffers) { }
                @Override public void onError(Throwable error) {
                    require(error == original, "downstream receives original transport failure");
                    require(captured.get() == 1, "failure captured before downstream releases its reader");
                }
                @Override public void onComplete() {
                    require(captured.get() == 1, "completion captured before downstream releases its reader");
                }
            };
            HttpResponse.BodySubscriber<Object> observed = tracing.observe(ignored -> downstream).apply(responseInfo());
            tracing.responseComplete(null, null);
            if (failed) {
                observed.onError(original);
            } else {
                observed.onComplete();
            }
            require(captured.get() == 1, "terminal transport capture remains single");
            require(capturedError.get() == (failed ? original : null), "terminal transport outcome");
        }
    }

    private static HttpResponse.ResponseInfo responseInfo() {
        return new HttpResponse.ResponseInfo() {
            @Override public int statusCode() { return 200; }
            @Override public java.net.http.HttpHeaders headers() {
                return java.net.http.HttpHeaders.of(Map.of(), (name, header) -> true);
            }
            @Override public HttpClient.Version version() { return HttpClient.Version.HTTP_1_1; }
        };
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
