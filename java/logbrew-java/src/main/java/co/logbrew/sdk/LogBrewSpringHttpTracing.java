package co.logbrew.sdk;

import java.io.IOException;
import java.time.Instant;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

/**
 * Explicit app-owned tracing for Spring {@code RestClient} and {@code RestTemplate}.
 *
 * <p>The interceptors create one W3C child span per request and record only bounded dependency
 * fields. They do not install global instrumentation or capture paths, URLs, query strings,
 * headers, bodies, exception messages, baggage, or tracestate.</p>
 */
public final class LogBrewSpringHttpTracing {
    private LogBrewSpringHttpTracing() {
    }

    /**
     * Creates a {@code RestClient} interceptor with default options.
     *
     * @param client app-owned LogBrew client
     * @return request interceptor
     */
    public static ClientHttpRequestInterceptor restClientInterceptor(LogBrewClient client) {
        return restClientInterceptor(client, Options.create());
    }

    /**
     * Creates a {@code RestClient} interceptor.
     *
     * @param client app-owned LogBrew client
     * @param options tracing options, or {@code null} for defaults
     * @return request interceptor
     */
    public static ClientHttpRequestInterceptor restClientInterceptor(LogBrewClient client, Options options) {
        return new TracingInterceptor(client, "spring.restclient", options);
    }

    /**
     * Creates a {@code RestTemplate} interceptor with default options.
     *
     * @param client app-owned LogBrew client
     * @return request interceptor
     */
    public static ClientHttpRequestInterceptor restTemplateInterceptor(LogBrewClient client) {
        return restTemplateInterceptor(client, Options.create());
    }

    /**
     * Creates a {@code RestTemplate} interceptor.
     *
     * @param client app-owned LogBrew client
     * @param options tracing options, or {@code null} for defaults
     * @return request interceptor
     */
    public static ClientHttpRequestInterceptor restTemplateInterceptor(LogBrewClient client, Options options) {
        return new TracingInterceptor(client, "spring.resttemplate", options);
    }

    static boolean isTracingInterceptor(Object value) {
        return value instanceof TracingInterceptor;
    }

    /**
     * Builder-style immutable-at-registration tracing options.
     */
    public static final class Options {
        private String eventIdPrefix = "java_spring_http";
        private Predicate<HttpRequest> requestFilter;
        private Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;

        private Options() {
        }

        /**
         * Creates default options.
         *
         * @return mutable options builder
         */
        public static Options create() {
            return new Options();
        }

        /**
         * Sets the stable event ID prefix.
         *
         * @param value non-empty prefix
         * @return these options
         */
        public Options eventIdPrefix(String value) {
            if (value == null || value.trim().isEmpty()) {
                throw new SdkException("validation_error", "Spring HTTP eventIdPrefix must be non-empty");
            }
            eventIdPrefix = value.trim();
            return this;
        }

        /**
         * Sets an app-owned request predicate. Rejected requests remain untouched.
         *
         * @param value request predicate
         * @return these options
         */
        public Options requestFilter(Predicate<HttpRequest> value) {
            requestFilter = Objects.requireNonNull(value, "requestFilter");
            return this;
        }

        /**
         * Sets an advisory capture-error callback.
         *
         * @param value callback
         * @return these options
         */
        public Options onError(Consumer<SdkException> value) {
            onError = Objects.requireNonNull(value, "onError");
            return this;
        }

        /**
         * Sets the span clock.
         *
         * @param value instant supplier
         * @return these options
         */
        public Options now(Supplier<Instant> value) {
            now = Objects.requireNonNull(value, "now");
            return this;
        }

        /**
         * Sets a deterministic two-value span clock.
         *
         * @param first request start
         * @param second request finish
         * @return these options
         */
        public Options nowSequence(Instant first, Instant second) {
            Instant[] values = {
                Objects.requireNonNull(first, "first"),
                Objects.requireNonNull(second, "second")
            };
            AtomicInteger index = new AtomicInteger();
            now = () -> values[Math.min(index.getAndIncrement(), values.length - 1)];
            return this;
        }

        private Options copy() {
            Options copy = new Options();
            copy.eventIdPrefix = eventIdPrefix;
            copy.requestFilter = requestFilter;
            copy.onError = onError;
            copy.now = now;
            return copy;
        }
    }

    private static final class TracingInterceptor implements ClientHttpRequestInterceptor {
        private final LogBrewClient client;
        private final String source;
        private final Options options;

        private TracingInterceptor(LogBrewClient client, String source, Options options) {
            this.client = Objects.requireNonNull(client, "client");
            this.source = source;
            this.options = options == null ? Options.create() : options.copy();
        }

        @Override
        public ClientHttpResponse intercept(
            HttpRequest request,
            byte[] body,
            ClientHttpRequestExecution execution
        ) throws IOException {
            Objects.requireNonNull(request, "request");
            Objects.requireNonNull(execution, "execution");
            if (!shouldTrace(request)) {
                return execution.execute(request, body);
            }

            LogBrewSpringHttpSpan span;
            try {
                span = LogBrewSpringHttpSpan.start(
                    request.getMethod().name(),
                    request.getURI(),
                    source,
                    "spring.web",
                    options.eventIdPrefix,
                    currentInstant()
                );
                request.getHeaders().set("traceparent", span.traceparent());
            } catch (RuntimeException error) {
                report(new SdkException("capture_error", "Spring HTTP trace preparation failed"));
                return execution.execute(request, body);
            }

            ClientHttpResponse response = null;
            Throwable requestError = null;
            LogBrewTrace.Scope scope = span.activate();
            try {
                try {
                    response = execution.execute(request, body);
                    return response;
                } catch (IOException | RuntimeException | Error error) {
                    requestError = error;
                    throw error;
                } finally {
                    captureSafely(span, response, requestError);
                }
            } finally {
                scope.close();
            }
        }

        private boolean shouldTrace(HttpRequest request) {
            if (options.requestFilter == null) {
                return true;
            }
            try {
                return options.requestFilter.test(request);
            } catch (RuntimeException error) {
                report(new SdkException("capture_error", "Spring HTTP request filter failed"));
                return false;
            }
        }

        private void captureSafely(
            LogBrewSpringHttpSpan span,
            ClientHttpResponse response,
            Throwable requestError
        ) {
            try {
                int statusCode = response == null ? 0 : response.getStatusCode().value();
                span.finish(client, statusCode, requestError, false, false, currentInstant());
            } catch (IOException error) {
                report(new SdkException("capture_error", "Spring HTTP response status capture failed"));
            } catch (SdkException error) {
                report(error);
            } catch (RuntimeException error) {
                report(new SdkException("capture_error", "Spring HTTP telemetry capture failed"));
            }
        }

        private Instant currentInstant() {
            return Objects.requireNonNull(options.now.get(), "Spring HTTP clock result");
        }

        private void report(SdkException error) {
            if (options.onError == null) {
                return;
            }
            try {
                options.onError.accept(error);
            } catch (RuntimeException ignored) {
                // Diagnostics never own the app's HTTP result.
            }
        }
    }
}
