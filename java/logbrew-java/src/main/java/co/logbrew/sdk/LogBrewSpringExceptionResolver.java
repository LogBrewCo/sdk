package co.logbrew.sdk;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.core.Ordered;
import org.springframework.web.servlet.HandlerExceptionResolver;
import org.springframework.web.servlet.ModelAndView;

/**
 * Non-resolving Spring MVC exception observer for correlated LogBrew issues.
 *
 * <p>Spring MVC can resolve controller exceptions before they escape a servlet filter. This
 * resolver observes that boundary, queues one type-only issue with bounded structured frames,
 * and returns {@code null} so the application's normal exception resolvers keep full control.
 * It never captures exception messages, raw stack text, request bodies, response bodies,
 * arbitrary headers, cookies, query strings, or full URLs.</p>
 */
public final class LogBrewSpringExceptionResolver implements HandlerExceptionResolver, Ordered {
    private static final String DEFAULT_EVENT_ID_PREFIX = "spring_request";

    private final LogBrewClient client;
    private final String eventIdPrefix;
    private final Map<String, Object> baseMetadata;
    private final AtomicLong nextEventNumber = new AtomicLong();

    /**
     * Creates a resolver that observes controller exceptions for the provided client.
     */
    public LogBrewSpringExceptionResolver(LogBrewClient client) {
        this(client, DEFAULT_EVENT_ID_PREFIX, null);
    }

    /**
     * Creates a resolver with a custom event id prefix and primitive base metadata.
     */
    public LogBrewSpringExceptionResolver(
        LogBrewClient client,
        String eventIdPrefix,
        Map<String, ?> metadata
    ) {
        this.client = Objects.requireNonNull(client, "client");
        Validation.requireNonEmpty("event id prefix", eventIdPrefix);
        this.eventIdPrefix = eventIdPrefix;
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        this.baseMetadata = copiedMetadata == null
            ? Collections.emptyMap()
            : Collections.unmodifiableMap(copiedMetadata);
    }

    /**
     * Queues one issue and leaves the exception unresolved for the remaining Spring chain.
     */
    @Override
    public ModelAndView resolveException(
        HttpServletRequest request,
        HttpServletResponse response,
        Object handler,
        Exception error
    ) {
        try {
            if (Boolean.TRUE.equals(request.getAttribute(LogBrewServletFilter.EXCEPTION_CAPTURED_ATTRIBUTE))) {
                return null;
            }
            String method = LogBrewServletFilter.requestMethod(request);
            String route = LogBrewServletFilter.exceptionRouteTemplate(request);
            Map<String, Object> metadata = new LinkedHashMap<>(baseMetadata);
            metadata.put("source", "spring-mvc");
            metadata.put("routeSource", LogBrewServletFilter.exceptionRouteSource(request));
            metadata.put("method", method);
            metadata.put("routeTemplate", route);
            metadata.put("statusCode", Integer.valueOf(500));
            client.issue(
                eventIdPrefix + "_issue_" + nextEventNumber.incrementAndGet(),
                Instant.now().toString(),
                IssueAttributes.fromThrowable(
                    method + " " + route + " failed",
                    error,
                    "spring.mvc.exception_resolver",
                    false
                ).metadata(LogBrewTrace.metadataWithCurrentTrace(metadata))
            );
            request.setAttribute(LogBrewServletFilter.EXCEPTION_CAPTURED_ATTRIBUTE, Boolean.TRUE);
        } catch (RuntimeException failure) {
            // Telemetry must never resolve or replace the application's exception.
        }
        return null;
    }

    /**
     * Runs before application resolvers so every controller exception can be observed.
     */
    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }

}
