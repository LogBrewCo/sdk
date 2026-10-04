package co.logbrew.sdk;

import jakarta.servlet.Filter;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * App-owned Jakarta Servlet filter for request trace, log, span, and metric correlation.
 *
 * <p>The filter reads only W3C {@code traceparent}, activates the request trace while the
 * downstream filter chain runs, then records one request span and one
 * {@code http.server.duration} metric. Asynchronous requests finish at completion and reuse
 * the same trace during redispatch. An exception that escapes the chain also records one
 * correlated, type-only issue with bounded structured frames. The filter does not capture
 * exception messages, raw stack text, request bodies, response bodies, arbitrary headers,
 * cookies, query strings, full URLs, baggage, or tracestate.</p>
 */
public final class LogBrewServletFilter implements Filter {
    /**
     * Optional app-owned request attribute for a low-cardinality route template.
     */
    public static final String ROUTE_TEMPLATE_ATTRIBUTE = "co.logbrew.routeTemplate";

    /**
     * Spring MVC request attribute used for the resolved route template.
     */
    public static final String SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE =
        "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";

    static final String EXCEPTION_CAPTURED_ATTRIBUTE = "co.logbrew.issueExceptionCaptured";

    private static final String TRACEPARENT_HEADER = "traceparent";
    private static final String DEFAULT_EVENT_ID_PREFIX = "servlet_request";
    private static final String REQUEST_STATE_ATTRIBUTE = "co.logbrew.servletRequestState";
    private static final AtomicLong nextFilterNumber = new AtomicLong();

    private final LogBrewClient client;
    private final String eventIdPrefix;
    private final Map<String, Object> baseMetadata;
    private final AtomicLong nextEventNumber = new AtomicLong();
    private final String requestStateAttribute = REQUEST_STATE_ATTRIBUTE + "_" + nextFilterNumber.incrementAndGet();

    /**
     * Creates a filter that queues request spans and duration metrics on the provided client.
     */
    public LogBrewServletFilter(LogBrewClient client) {
        this(client, DEFAULT_EVENT_ID_PREFIX, null);
    }

    /**
     * Creates a filter with a custom generated event id prefix.
     */
    public LogBrewServletFilter(LogBrewClient client, String eventIdPrefix) {
        this(client, eventIdPrefix, null);
    }

    /**
     * Creates a filter with a custom event id prefix and primitive base metadata.
     */
    public LogBrewServletFilter(LogBrewClient client, String eventIdPrefix, Map<String, ?> metadata) {
        this.client = Objects.requireNonNull(client, "client");
        Validation.requireNonEmpty("event id prefix", eventIdPrefix);
        this.eventIdPrefix = eventIdPrefix;
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        this.baseMetadata = copiedMetadata == null ? Collections.emptyMap() : Collections.unmodifiableMap(copiedMetadata);
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
        throws IOException, ServletException {
        if (!(request instanceof HttpServletRequest) || !(response instanceof HttpServletResponse)) {
            chain.doFilter(request, response);
            return;
        }

        HttpServletRequest httpRequest = (HttpServletRequest) request;
        HttpServletResponse httpResponse = (HttpServletResponse) response;
        Object existing = httpRequest.getAttribute(requestStateAttribute);
        RequestState state;
        if (existing instanceof RequestState) {
            state = (RequestState) existing;
        } else {
            state = new RequestState(httpRequest, httpResponse);
            httpRequest.setAttribute(requestStateAttribute, state);
        }
        state.request = httpRequest;
        state.response = httpResponse;
        LogBrewTrace.Scope traceScope = LogBrewTrace.activate(state.traceContext);

        try {
            chain.doFilter(request, response);
        } catch (IOException | ServletException | RuntimeException | Error error) {
            state.failure = error;
            throw error;
        } finally {
            traceScope.close();
            state.afterDispatch();
        }
    }

    private final class RequestState implements AsyncListener {
        private final LogBrewTraceContext traceContext;
        private final long startedNanos = System.nanoTime();
        private final AtomicBoolean completed = new AtomicBoolean();
        private final AtomicBoolean listening = new AtomicBoolean();
        private volatile HttpServletRequest request;
        private volatile HttpServletResponse response;
        private volatile Throwable failure;

        private RequestState(HttpServletRequest request, HttpServletResponse response) {
            this.request = request;
            this.response = response;
            traceContext = traceContextFromIncomingHeader(request.getHeader(TRACEPARENT_HEADER));
        }

        private void afterDispatch() {
            try {
                if (request.isAsyncStarted()) {
                    if (listening.compareAndSet(false, true)) {
                        request.getAsyncContext().addListener(this, request, response);
                    }
                } else if (!listening.get()) {
                    finish();
                }
            } catch (IllegalStateException error) {
                // Completion may win the race with listener registration.
                finish();
            }
        }

        private void finish() {
            if (completed.compareAndSet(false, true)) {
                finishTelemetry(request, traceContext, responseStatus(response, failure), elapsedMs(startedNanos), failure);
            }
        }

        @Override
        public void onComplete(AsyncEvent event) {
            if (failure == null) {
                try {
                    Object containerError = request.getAttribute(RequestDispatcher.ERROR_EXCEPTION);
                    if (containerError instanceof Throwable) {
                        failure = (Throwable) containerError;
                    }
                } catch (RuntimeException ignored) {
                    // Capture the completed response even when error attributes are unavailable.
                }
            }
            finish();
        }

        @Override
        public void onError(AsyncEvent event) {
            if (event.getThrowable() != null) {
                failure = event.getThrowable();
            }
        }

        @Override
        public void onTimeout(AsyncEvent event) {
            // The container or app may still resolve the timeout and change the response.
        }

        @Override
        public void onStartAsync(AsyncEvent event) {
            try {
                event.getAsyncContext().addListener(this, request, response);
            } catch (RuntimeException ignored) {
                // Listener registration must never alter the app's async lifecycle.
            }
        }
    }

    private void finishTelemetry(
        HttpServletRequest request,
        LogBrewTraceContext traceContext,
        int statusCode,
        double durationMs,
        Throwable failure
    ) {
        long eventNumber = nextEventNumber.incrementAndGet();
        captureUnhandledIssue(request, traceContext, statusCode, failure, eventNumber);
        try {
            LogBrewHttpRequestTelemetry telemetry = LogBrewHttpRequestTelemetry.start(
                client,
                request.getMethod(),
                routeTemplate(request),
                traceContext,
                requestMetadata(routeSource(request))
            );
            telemetry.finishSpanAndMetric(
                eventIdPrefix + "_span_" + eventNumber,
                eventIdPrefix + "_metric_" + eventNumber,
                Instant.now().toString(),
                statusCode,
                durationMs
            );
        } catch (RuntimeException error) {
            // Telemetry must never change servlet request behavior.
        }
    }

    private void captureUnhandledIssue(
        HttpServletRequest request,
        LogBrewTraceContext traceContext,
        int statusCode,
        Throwable failure,
        long eventNumber
    ) {
        if (failure == null) {
            return;
        }
        try {
            if (Boolean.TRUE.equals(request.getAttribute(EXCEPTION_CAPTURED_ATTRIBUTE))) {
                return;
            }
            String method = requestMethod(request);
            String route = exceptionRouteTemplate(request);
            Map<String, Object> metadata = requestMetadata(exceptionRouteSource(request));
            metadata.put("method", method);
            metadata.put("routeTemplate", route);
            metadata.put("statusCode", Integer.valueOf(statusCode));
            client.issue(
                eventIdPrefix + "_issue_" + eventNumber,
                Instant.now().toString(),
                IssueAttributes.fromThrowable(
                    method + " " + route + " failed",
                    failure,
                    "jakarta_servlet.filter",
                    false
                )
                    .metadata(LogBrewTrace.metadataWithTrace(traceContext, metadata))
                    .context(traceContext.telemetryContext())
            );
            request.setAttribute(EXCEPTION_CAPTURED_ATTRIBUTE, Boolean.TRUE);
        } catch (RuntimeException error) {
            // Exception diagnostics must never change servlet request behavior.
        }
    }

    private Map<String, Object> requestMetadata(String routeSource) {
        Map<String, Object> values = new LinkedHashMap<>(baseMetadata);
        values.put("source", "jakarta-servlet");
        values.put("routeSource", routeSource);
        return values;
    }

    static String routeTemplate(HttpServletRequest request) {
        String resolvedRoute = resolvedRouteTemplate(request);
        if (resolvedRoute != null) {
            return resolvedRoute;
        }

        String servletPath = request.getServletPath();
        if (servletPath != null && !servletPath.trim().isEmpty()) {
            return servletPath;
        }

        String requestUri = request.getRequestURI();
        if (requestUri != null && !requestUri.trim().isEmpty()) {
            return requestUri;
        }

        return "/";
    }

    static String routeSource(HttpServletRequest request) {
        String resolvedSource = resolvedRouteSource(request);
        if (resolvedSource != null) {
            return resolvedSource;
        }
        if (request.getServletPath() != null && !request.getServletPath().trim().isEmpty()) {
            return "servlet_path";
        }
        return "request_uri";
    }

    static String exceptionRouteTemplate(HttpServletRequest request) {
        String resolvedRoute = resolvedRouteTemplate(request);
        return resolvedRoute == null ? "/" : resolvedRoute;
    }

    static String exceptionRouteSource(HttpServletRequest request) {
        String resolvedSource = resolvedRouteSource(request);
        return resolvedSource == null ? "unmatched" : resolvedSource;
    }

    static String requestMethod(HttpServletRequest request) {
        String method = request.getMethod();
        if (method == null || method.trim().isEmpty()) {
            return "HTTP";
        }
        String normalized = method.trim().toUpperCase(java.util.Locale.ROOT);
        return normalized.matches("[A-Z]+") ? normalized : "HTTP";
    }

    private static String resolvedRouteTemplate(HttpServletRequest request) {
        Object value = request.getAttribute(ROUTE_TEMPLATE_ATTRIBUTE);
        if (value == null) {
            value = request.getAttribute(SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE);
        }
        if (value == null) {
            return null;
        }
        String route = sanitizedRoute(value);
        return route == null ? "/" : route;
    }

    private static String resolvedRouteSource(HttpServletRequest request) {
        Object value = request.getAttribute(ROUTE_TEMPLATE_ATTRIBUTE);
        if (value != null) {
            return sanitizedRoute(value) == null ? "unmatched" : "logbrew_attribute";
        }
        value = request.getAttribute(SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (value != null) {
            return sanitizedRoute(value) == null ? "unmatched" : "spring_best_matching_pattern";
        }
        return null;
    }

    private static String sanitizedRoute(Object value) {
        if (value == null) {
            return null;
        }
        try {
            String route = LogBrewHttpRequestTelemetry.sanitizeRouteTemplate(value.toString());
            return "/**".equals(route) ? null : route;
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static int responseStatus(HttpServletResponse response, Throwable failure) {
        int statusCode = failure == null ? 200 : 500;
        try {
            statusCode = response.getStatus();
        } catch (RuntimeException | AbstractMethodError error) {
            return statusCode;
        }
        if (failure != null && statusCode < 400) {
            return 500;
        }
        if (statusCode < 100 || statusCode > 599) {
            return failure == null ? 200 : 500;
        }
        return statusCode;
    }

    private static double elapsedMs(long startedNanos) {
        return (System.nanoTime() - startedNanos) / 1_000_000.0;
    }

    private static LogBrewTraceContext traceContextFromIncomingHeader(String traceparent) {
        if (traceparent == null || traceparent.trim().isEmpty()) {
            return LogBrewTraceContext.generate();
        }
        try {
            return LogBrewTraceContext.fromTraceparent(traceparent);
        } catch (SdkException error) {
            return LogBrewTraceContext.generate();
        }
    }
}
