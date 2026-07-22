package co.logbrew.sdk;

import java.time.Instant;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import reactor.core.publisher.Mono;

/**
 * Explicit app-owned tracing for Spring {@code WebClient}.
 *
 * <p>The filter creates one W3C child span per subscription. It does not register Reactor hooks,
 * mutate other clients, or capture paths, URLs, query strings, headers, bodies, exception
 * messages, baggage, or tracestate.</p>
 */
public final class LogBrewSpringWebClientTracing {
    private LogBrewSpringWebClientTracing() {
    }

    /**
     * Creates a {@code WebClient} filter with default options.
     *
     * @param client app-owned LogBrew client
     * @return exchange filter
     */
    public static ExchangeFilterFunction filter(LogBrewClient client) {
        return filter(client, Options.create());
    }

    /**
     * Creates a {@code WebClient} filter.
     *
     * @param client app-owned LogBrew client
     * @param options tracing options, or {@code null} for defaults
     * @return exchange filter
     */
    public static ExchangeFilterFunction filter(LogBrewClient client, Options options) {
        return new TracingFilter(client, options);
    }

    static boolean isTracingFilter(Object value) {
        return value instanceof TracingFilter;
    }

    /**
     * Builder-style immutable-at-registration tracing options.
     */
    public static final class Options {
        private String eventIdPrefix = "java_spring_webclient";
        private Predicate<ClientRequest> requestFilter;
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
                throw new SdkException("validation_error", "Spring WebClient eventIdPrefix must be non-empty");
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
        public Options requestFilter(Predicate<ClientRequest> value) {
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

        private Options copy() {
            Options copy = new Options();
            copy.eventIdPrefix = eventIdPrefix;
            copy.requestFilter = requestFilter;
            copy.onError = onError;
            copy.now = now;
            return copy;
        }
    }

    private static final class TracingFilter implements ExchangeFilterFunction {
        private final LogBrewClient client;
        private final Options options;

        private TracingFilter(LogBrewClient client, Options options) {
            this.client = Objects.requireNonNull(client, "client");
            this.options = options == null ? Options.create() : options.copy();
        }

        @Override
        public Mono<ClientResponse> filter(ClientRequest request, ExchangeFunction next) {
            Objects.requireNonNull(request, "request");
            Objects.requireNonNull(next, "next");
            return Mono.defer(() -> traceSubscription(request, next));
        }

        private Mono<ClientResponse> traceSubscription(ClientRequest request, ExchangeFunction next) {
            if (!shouldTrace(request)) {
                return next.exchange(request);
            }

            RequestState state;
            ClientRequest tracedRequest;
            try {
                LogBrewSpringHttpSpan span = LogBrewSpringHttpSpan.start(
                    request.method().name(),
                    request.url(),
                    "spring.webclient",
                    "spring.webflux",
                    options.eventIdPrefix,
                    currentInstant()
                );
                state = new RequestState(span);
                tracedRequest = ClientRequest.from(request)
                    .headers(headers -> headers.set("traceparent", span.traceparent()))
                    .build();
            } catch (RuntimeException error) {
                report(new SdkException("capture_error", "Spring WebClient trace preparation failed"));
                return next.exchange(request);
            }

            Mono<ClientResponse> response;
            LogBrewTrace.Scope scope = state.span.activate();
            try {
                response = Objects.requireNonNull(next.exchange(tracedRequest), "exchange result");
            } catch (RuntimeException | Error error) {
                state.finish(null, error, false);
                return Mono.error(error);
            } finally {
                scope.close();
            }

            return response
                .doOnSuccess(value -> state.finish(value, null, false))
                .doOnError(error -> state.finish(null, error, false))
                .doOnCancel(() -> state.finish(null, null, true));
        }

        private boolean shouldTrace(ClientRequest request) {
            if (options.requestFilter == null) {
                return true;
            }
            try {
                return options.requestFilter.test(request);
            } catch (RuntimeException error) {
                report(new SdkException("capture_error", "Spring WebClient request filter failed"));
                return false;
            }
        }

        private Instant currentInstant() {
            return Objects.requireNonNull(options.now.get(), "Spring WebClient clock result");
        }

        private void report(SdkException error) {
            if (options.onError == null) {
                return;
            }
            try {
                options.onError.accept(error);
            } catch (RuntimeException ignored) {
                // Diagnostics never own the app's reactive signal.
            }
        }

        private final class RequestState {
            private final LogBrewSpringHttpSpan span;
            private final AtomicBoolean finished = new AtomicBoolean();

            private RequestState(LogBrewSpringHttpSpan span) {
                this.span = span;
            }

            private void finish(ClientResponse response, Throwable requestError, boolean cancelled) {
                if (!finished.compareAndSet(false, true)) {
                    return;
                }
                try {
                    int statusCode = response == null ? 0 : response.statusCode().value();
                    span.finish(
                        client,
                        statusCode,
                        requestError,
                        cancelled,
                        response == null && requestError == null && !cancelled,
                        currentInstant()
                    );
                } catch (SdkException error) {
                    report(error);
                } catch (RuntimeException error) {
                    report(new SdkException("capture_error", "Spring WebClient telemetry capture failed"));
                }
            }

        }
    }
}
