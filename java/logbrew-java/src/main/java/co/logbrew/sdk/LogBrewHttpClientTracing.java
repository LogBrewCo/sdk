package co.logbrew.sdk;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Explicit app-owned Java {@link HttpClient} tracing helpers.
 *
 * <p>The helpers copy the request, replace only one W3C {@code traceparent}
 * header, run the app-owned client call, and queue one sanitized
 * {@code http.client} span. They do not install a Java agent, set global
 * OpenTelemetry state, patch clients, or capture payloads, arbitrary headers,
 * full URLs, query strings, baggage, or tracestate.</p>
 */
public final class LogBrewHttpClientTracing {
    private static final Pattern METHOD_PATTERN = Pattern.compile("^[A-Za-z]+$");

    private LogBrewHttpClientTracing() {
    }

    /**
     * Sends a traced synchronous Java {@link HttpClient} request.
     */
    public static <T> HttpResponse<T> send(
        LogBrewClient client,
        HttpClient httpClient,
        HttpRequest request,
        HttpResponse.BodyHandler<T> responseBodyHandler,
        ClientRequest config
    ) throws IOException, InterruptedException {
        Objects.requireNonNull(httpClient, "httpClient");
        Objects.requireNonNull(responseBodyHandler, "responseBodyHandler");
        ClientRequest safeConfig = config == null ? ClientRequest.create() : config;
        PreparedRequest prepared = prepare(client, request, safeConfig);
        Throwable requestError = null;
        HttpResponse<T> response = null;
        try {
            response = httpClient.send(prepared.request, responseBodyHandler);
            return response;
        } catch (IOException | InterruptedException error) {
            requestError = error;
            throw error;
        } catch (IllegalArgumentException error) {
            requestError = error;
            throw error;
        } catch (SecurityException error) {
            requestError = error;
            throw error;
        } catch (UncheckedIOException error) {
            requestError = error;
            throw error;
        } finally {
            captureSpan(client, prepared, response, requestError, safeConfig);
        }
    }

    /**
     * Sends a traced asynchronous Java {@link HttpClient} request.
     */
    public static <T> CompletableFuture<HttpResponse<T>> sendAsync(
        LogBrewClient client,
        HttpClient httpClient,
        HttpRequest request,
        HttpResponse.BodyHandler<T> responseBodyHandler,
        ClientRequest config
    ) {
        Objects.requireNonNull(httpClient, "httpClient");
        Objects.requireNonNull(responseBodyHandler, "responseBodyHandler");
        ClientRequest safeConfig = config == null ? ClientRequest.create() : config;
        PreparedRequest prepared = prepare(client, request, safeConfig);
        CompletableFuture<HttpResponse<T>> future;
        try {
            future = httpClient.sendAsync(prepared.request, responseBodyHandler);
        } catch (IllegalArgumentException error) {
            captureSpan(client, prepared, null, error, safeConfig);
            throw error;
        } catch (SecurityException error) {
            captureSpan(client, prepared, null, error, safeConfig);
            throw error;
        } catch (RejectedExecutionException error) {
            captureSpan(client, prepared, null, error, safeConfig);
            throw error;
        } catch (UncheckedIOException error) {
            captureSpan(client, prepared, null, error, safeConfig);
            throw error;
        }
        return future.whenComplete((response, error) ->
            captureSpan(client, prepared, response, unwrapCompletionError(error), safeConfig));
    }

    private static PreparedRequest prepare(LogBrewClient client, HttpRequest request, ClientRequest config) {
        Objects.requireNonNull(client, "client");
        Objects.requireNonNull(request, "request");
        String method = normalizeMethod(request.method());
        String routeTemplate = sanitizeRouteTemplate(
            config.routeTemplate == null ? request.uri().getRawPath() : config.routeTemplate
        );
        LogBrewTraceContext trace = childTrace(config.spanId);
        Instant startedAt = config.currentInstant();
        HttpRequest tracedRequest = requestWithTraceparent(request, trace.traceparent());
        return new PreparedRequest(tracedRequest, method, routeTemplate, trace, startedAt);
    }

    private static LogBrewTraceContext childTrace(String configuredSpanId) {
        String spanId = childSpanId(configuredSpanId);
        return LogBrewTrace.current()
            .map(parent -> LogBrewTraceContext.create(parent.traceId(), spanId, parent.spanId(), parent.traceFlags()))
            .orElseGet(() -> {
                LogBrewTraceContext root = LogBrewTraceContext.generate();
                if (configuredSpanId == null || configuredSpanId.trim().isEmpty()) {
                    return root;
                }
                return LogBrewTraceContext.create(root.traceId(), spanId);
            });
    }

    private static String childSpanId(String configuredSpanId) {
        return configuredSpanId == null || configuredSpanId.trim().isEmpty()
            ? LogBrewTraceContext.generate().spanId()
            : configuredSpanId.trim().toLowerCase(Locale.ROOT);
    }

    private static HttpRequest requestWithTraceparent(HttpRequest request, String traceparent) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(request.uri())
            .method(
                request.method(),
                request.bodyPublisher().orElse(HttpRequest.BodyPublishers.noBody())
            );
        request.timeout().ifPresent(builder::timeout);
        request.version().ifPresent(builder::version);
        if (request.expectContinue()) {
            builder.expectContinue(true);
        }
        for (Map.Entry<String, List<String>> entry : request.headers().map().entrySet()) {
            if ("traceparent".equalsIgnoreCase(entry.getKey())) {
                continue;
            }
            for (String value : entry.getValue()) {
                builder.header(entry.getKey(), value);
            }
        }
        builder.header("traceparent", traceparent);
        return builder.build();
    }

    private static void captureSpan(
        LogBrewClient client,
        PreparedRequest prepared,
        HttpResponse<?> response,
        Throwable requestError,
        ClientRequest config
    ) {
        try {
            Instant finishedAt = config.currentInstant();
            double durationMs = Duration.between(prepared.startedAt, finishedAt).toNanos() / 1_000_000.0;
            int statusCode = response == null ? 0 : response.statusCode();
            Map<String, Object> metadata = httpMetadata(prepared, statusCode, requestError, config);
            SpanAttributes attributes = SpanAttributes
                .create(
                    "http.client:" + prepared.method + " " + prepared.routeTemplate,
                    prepared.trace.traceId(),
                    prepared.trace.spanId(),
                    spanStatus(statusCode, requestError)
                )
                .durationMs(durationMs)
                .metadata(metadata);
            if (prepared.trace.parentSpanId() != null) {
                attributes.parentSpanId(prepared.trace.parentSpanId());
            }
            List<SpanEventSummary> spanEvents = spanEventsWithException(config.spanEvents, requestError);
            if (!spanEvents.isEmpty()) {
                attributes.events(spanEvents);
            }
            client.span(
                config.resolvedEventIdPrefix("java_http_client") + "_span_" + prepared.trace.spanId(),
                finishedAt.toString(),
                attributes
            );
        } catch (SdkException error) {
            reportCaptureError(config.onError, error);
        }
    }

    private static Map<String, Object> httpMetadata(
        PreparedRequest prepared,
        int statusCode,
        Throwable requestError,
        ClientRequest config
    ) {
        Map<String, Object> metadata = Validation.copySafeDependencyMetadata(config.metadata);
        metadata.put("source", "http.client");
        metadata.put("sampled", Boolean.valueOf(prepared.trace.sampled()));
        metadata.put("method", prepared.method);
        metadata.put("routeTemplate", prepared.routeTemplate);
        metadata.put("http.request.method", prepared.method);
        metadata.put("http.route", prepared.routeTemplate);
        if (statusCode > 0) {
            metadata.put("statusCode", Integer.valueOf(statusCode));
            metadata.put("http.response.status_code", Integer.valueOf(statusCode));
        }
        if (requestError != null) {
            metadata.put("errorType", requestError.getClass().getSimpleName());
        }
        return LogBrewTrace.metadataWithTrace(prepared.trace, metadata);
    }

    private static List<SpanEventSummary> spanEventsWithException(
        List<SpanEventSummary> configuredEvents,
        Throwable requestError
    ) {
        List<SpanEventSummary> safeEvents = new ArrayList<>();
        if (configuredEvents != null) {
            for (SpanEventSummary event : configuredEvents) {
                safeEvents.add(event.filterMetadataKeys(key -> !Validation.blockedDependencyMetadataKey(key)));
            }
        }
        Throwable unwrappedError = unwrapCompletionError(requestError);
        if (unwrappedError != null && safeEvents.size() < SpanEventSummary.MAX_EVENTS) {
            safeEvents.add(SpanEventSummary.create("exception").metadata(Map.of(
                "exceptionType", unwrappedError.getClass().getSimpleName(),
                "exceptionEscaped", Boolean.TRUE
            )));
        }
        return safeEvents;
    }

    private static Throwable unwrapCompletionError(Throwable error) {
        if ((error instanceof CompletionException || error instanceof ExecutionException) && error.getCause() != null) {
            return error.getCause();
        }
        return error;
    }

    private static String normalizeMethod(String method) {
        Validation.requireNonEmpty("HTTP method", method);
        String normalized = method.trim().toUpperCase(Locale.ROOT);
        if (!METHOD_PATTERN.matcher(normalized).matches()) {
            throw new SdkException("validation_error", "HTTP method must contain letters only");
        }
        return normalized;
    }

    private static String sanitizeRouteTemplate(String routeTemplate) {
        String candidate = routeTemplate == null || routeTemplate.trim().isEmpty() ? "/" : routeTemplate.trim();
        int schemeIndex = candidate.indexOf("://");
        if (schemeIndex >= 0) {
            int pathStart = candidate.indexOf('/', schemeIndex + 3);
            candidate = pathStart >= 0 ? candidate.substring(pathStart) : "/";
        }
        int queryIndex = candidate.indexOf('?');
        int hashIndex = candidate.indexOf('#');
        int end = candidate.length();
        if (queryIndex >= 0) {
            end = Math.min(end, queryIndex);
        }
        if (hashIndex >= 0) {
            end = Math.min(end, hashIndex);
        }
        String sanitized = candidate.substring(0, end).trim();
        if (sanitized.isEmpty()) {
            return "/";
        }
        return sanitized;
    }

    private static String spanStatus(int statusCode, Throwable requestError) {
        if (requestError != null) {
            return "error";
        }
        return statusCode >= 400 ? "error" : "ok";
    }

    private static void reportCaptureError(Consumer<SdkException> onError, SdkException error) {
        if (onError == null) {
            return;
        }
        try {
            onError.accept(error);
        } catch (RuntimeException ignored) {
            // Preserve the app-owned request result even if diagnostics handling fails.
        }
    }

    private static final class PreparedRequest {
        private final HttpRequest request;
        private final String method;
        private final String routeTemplate;
        private final LogBrewTraceContext trace;
        private final Instant startedAt;

        private PreparedRequest(
            HttpRequest request,
            String method,
            String routeTemplate,
            LogBrewTraceContext trace,
            Instant startedAt
        ) {
            this.request = request;
            this.method = method;
            this.routeTemplate = routeTemplate;
            this.trace = trace;
            this.startedAt = startedAt;
        }
    }

    /**
     * HTTP client span configuration.
     */
    public static final class ClientRequest {
        private String routeTemplate;
        private String eventIdPrefix;
        private String spanId;
        private Map<String, ?> metadata;
        private List<SpanEventSummary> spanEvents;
        private Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;

        private ClientRequest() {
        }

        public static ClientRequest create() {
            return new ClientRequest();
        }

        public ClientRequest routeTemplate(String value) {
            this.routeTemplate = value;
            return this;
        }

        public ClientRequest eventIdPrefix(String value) {
            this.eventIdPrefix = value;
            return this;
        }

        public ClientRequest spanId(String value) {
            this.spanId = value;
            return this;
        }

        public ClientRequest metadata(Map<String, ?> value) {
            this.metadata = Validation.copyMetadata(value);
            return this;
        }

        public ClientRequest spanEvent(SpanEventSummary value) {
            if (value == null) {
                throw new SdkException("validation_error", "span event summary must be provided");
            }
            if (spanEvents == null) {
                spanEvents = new ArrayList<>();
            }
            spanEvents.add(value);
            SpanEventSummary.requireEventLimit(spanEvents.size());
            return this;
        }

        public ClientRequest spanEvents(Iterable<SpanEventSummary> values) {
            if (values == null) {
                throw new SdkException("validation_error", "span events must be provided");
            }
            List<SpanEventSummary> copied = new ArrayList<>();
            for (SpanEventSummary value : values) {
                if (value == null) {
                    throw new SdkException("validation_error", "span event summary must be provided");
                }
                copied.add(value);
                SpanEventSummary.requireEventLimit(copied.size());
            }
            this.spanEvents = copied;
            return this;
        }

        public ClientRequest onError(Consumer<SdkException> value) {
            this.onError = value;
            return this;
        }

        public ClientRequest now(Supplier<Instant> value) {
            this.now = Objects.requireNonNull(value, "now");
            return this;
        }

        public ClientRequest nowSequence(Instant first, Instant second) {
            Instant[] values = {Objects.requireNonNull(first, "first"), Objects.requireNonNull(second, "second")};
            int[] index = {0};
            this.now = () -> values[Math.min(index[0]++, values.length - 1)];
            return this;
        }

        private Instant currentInstant() {
            return now.get();
        }

        private String resolvedEventIdPrefix(String fallback) {
            if (eventIdPrefix == null || eventIdPrefix.trim().isEmpty()) {
                return fallback;
            }
            return eventIdPrefix.trim();
        }
    }
}
