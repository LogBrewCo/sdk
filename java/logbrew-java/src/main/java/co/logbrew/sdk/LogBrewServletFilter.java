package co.logbrew.sdk;

import jakarta.servlet.Filter;
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

/**
 * App-owned Jakarta Servlet filter for request trace, log, span, and metric correlation.
 *
 * <p>The filter reads only W3C {@code traceparent}, activates the request trace while the
 * downstream filter chain runs, then records one request span and one
 * {@code http.server.duration} metric. It does not capture request bodies, response bodies,
 * arbitrary headers, cookies, query strings, full URLs, baggage, or tracestate.</p>
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

    private static final String TRACEPARENT_HEADER = "traceparent";
    private static final String DEFAULT_EVENT_ID_PREFIX = "servlet_request";

    private final LogBrewClient client;
    private final String eventIdPrefix;
    private final Map<String, Object> baseMetadata;
    private final AtomicLong nextEventNumber = new AtomicLong();

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
        LogBrewTraceContext traceContext = traceContextFromIncomingHeader(httpRequest.getHeader(TRACEPARENT_HEADER));
        LogBrewTrace.Scope traceScope = LogBrewTrace.activate(traceContext);
        long startedNanos = System.nanoTime();
        Throwable failure = null;

        try {
            chain.doFilter(request, response);
        } catch (IOException | ServletException | RuntimeException | Error error) {
            failure = error;
            throw error;
        } finally {
            if (traceScope != null) {
                traceScope.close();
            }
            finishTelemetry(
                httpRequest,
                traceContext,
                responseStatus(httpResponse, failure),
                elapsedMs(startedNanos)
            );
        }
    }

    private void finishTelemetry(
        HttpServletRequest request,
        LogBrewTraceContext traceContext,
        int statusCode,
        double durationMs
    ) {
        long eventNumber = nextEventNumber.incrementAndGet();
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

    private Map<String, Object> requestMetadata(String routeSource) {
        Map<String, Object> values = new LinkedHashMap<>(baseMetadata);
        values.put("source", "jakarta-servlet");
        values.put("routeSource", routeSource);
        return values;
    }

    private static String routeTemplate(HttpServletRequest request) {
        Object explicitRoute = request.getAttribute(ROUTE_TEMPLATE_ATTRIBUTE);
        if (isUsableRoute(explicitRoute)) {
            return explicitRoute.toString();
        }

        Object springRoute = request.getAttribute(SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (isUsableRoute(springRoute)) {
            return springRoute.toString();
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

    private static String routeSource(HttpServletRequest request) {
        if (isUsableRoute(request.getAttribute(ROUTE_TEMPLATE_ATTRIBUTE))) {
            return "logbrew_attribute";
        }
        if (isUsableRoute(request.getAttribute(SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE))) {
            return "spring_best_matching_pattern";
        }
        if (request.getServletPath() != null && !request.getServletPath().trim().isEmpty()) {
            return "servlet_path";
        }
        return "request_uri";
    }

    private static boolean isUsableRoute(Object value) {
        if (value == null) {
            return false;
        }
        String route = value.toString().trim();
        return !route.isEmpty() && !"/**".equals(route);
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
