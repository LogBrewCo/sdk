package co.logbrew.sdk;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Builders for app-owned product and network timeline milestones.
 *
 * <p>The helpers create normal action attributes with privacy-safe primitive
 * metadata. They do not patch HTTP clients, capture payloads, capture headers,
 * or collect visual session replay.</p>
 */
public final class ProductTimeline {
    private ProductTimeline() {
    }

    /**
     * Starts a product action builder with the required action name.
     */
    public static ProductAction productAction(String name) {
        return new ProductAction(name);
    }

    /**
     * Starts a network milestone builder with the required route template.
     */
    public static NetworkMilestone networkMilestone(String routeTemplate) {
        return new NetworkMilestone(routeTemplate);
    }

    /**
     * Builder for a user- or product-owned action milestone.
     */
    public static final class ProductAction {
        private final String name;
        private String status = "success";
        private String routeTemplate;
        private String sessionId;
        private String traceId;
        private String screen;
        private String funnel;
        private String step;
        private Map<String, ?> metadata;

        private ProductAction(String name) {
            this.name = name;
        }

        /**
         * Sets the action status. Defaults to {@code success}.
         */
        public ProductAction status(String status) {
            this.status = status;
            return this;
        }

        /**
         * Sets a route template. Query strings and hash fragments are removed.
         */
        public ProductAction routeTemplate(String routeTemplate) {
            this.routeTemplate = routeTemplate;
            return this;
        }

        /**
         * Sets an app-owned session identifier.
         */
        public ProductAction sessionId(String sessionId) {
            this.sessionId = sessionId;
            return this;
        }

        /**
         * Sets a trace identifier that correlates the action with backend work.
         */
        public ProductAction traceId(String traceId) {
            this.traceId = traceId;
            return this;
        }

        /**
         * Sets the current app screen or view name.
         */
        public ProductAction screen(String screen) {
            this.screen = screen;
            return this;
        }

        /**
         * Sets the funnel name for product-analysis workflows.
         */
        public ProductAction funnel(String funnel) {
            this.funnel = funnel;
            return this;
        }

        /**
         * Sets the product step name inside a funnel.
         */
        public ProductAction step(String step) {
            this.step = step;
            return this;
        }

        /**
         * Sets optional primitive metadata. Nested objects are rejected.
         */
        public ProductAction metadata(Map<String, ?> metadata) {
            this.metadata = Validation.copyMetadata(metadata);
            return this;
        }

        /**
         * Builds normal LogBrew action attributes with timeline metadata.
         */
        public ActionAttributes toActionAttributes() {
            Validation.requireNonEmpty("product action name", name);
            Validation.requireAllowedValue("product action status", status, LogBrewClient.ACTION_STATUSES);
            Map<String, Object> timeline = timelineMetadata("product.action", metadata);
            putIfPresent(timeline, "routeTemplate", sanitizeRouteTemplate(routeTemplate));
            putIfPresent(timeline, "sessionId", stringOrNull(sessionId));
            putIfPresent(timeline, "traceId", stringOrNull(traceId));
            putIfPresent(timeline, "screen", stringOrNull(screen));
            putIfPresent(timeline, "funnel", stringOrNull(funnel));
            putIfPresent(timeline, "step", stringOrNull(step));

            ActionAttributes attributes = ActionAttributes.create(name, status).metadata(timeline);
            attributes.toMap();
            return attributes;
        }
    }

    /**
     * Builder for app-owned API milestones.
     */
    public static final class NetworkMilestone {
        private final String routeTemplate;
        private String name;
        private String method;
        private String status;
        private Integer statusCode;
        private Double durationMs;
        private String sessionId;
        private String traceId;
        private Map<String, ?> metadata;

        private NetworkMilestone(String routeTemplate) {
            this.routeTemplate = routeTemplate;
        }

        /**
         * Sets a custom action name. Defaults to {@code network.method route}.
         */
        public NetworkMilestone name(String name) {
            this.name = name;
            return this;
        }

        /**
         * Sets the HTTP method. Defaults to {@code GET}.
         */
        public NetworkMilestone method(String method) {
            this.method = method;
            return this;
        }

        /**
         * Sets the action status. Defaults from {@code statusCode} when omitted.
         */
        public NetworkMilestone status(String status) {
            this.status = status;
            return this;
        }

        /**
         * Sets the HTTP response status code.
         */
        public NetworkMilestone statusCode(int statusCode) {
            this.statusCode = Integer.valueOf(statusCode);
            return this;
        }

        /**
         * Sets the request duration in milliseconds.
         */
        public NetworkMilestone durationMs(double durationMs) {
            this.durationMs = Double.valueOf(durationMs);
            return this;
        }

        /**
         * Sets an app-owned session identifier.
         */
        public NetworkMilestone sessionId(String sessionId) {
            this.sessionId = sessionId;
            return this;
        }

        /**
         * Sets a trace identifier that correlates the milestone with backend work.
         */
        public NetworkMilestone traceId(String traceId) {
            this.traceId = traceId;
            return this;
        }

        /**
         * Sets optional primitive metadata. Nested objects are rejected.
         */
        public NetworkMilestone metadata(Map<String, ?> metadata) {
            this.metadata = Validation.copyMetadata(metadata);
            return this;
        }

        /**
         * Builds normal LogBrew action attributes with timeline metadata.
         */
        public ActionAttributes toActionAttributes() {
            String route = requireRouteTemplate(routeTemplate);
            String normalizedMethod = normalizeHttpMethod(method);
            Integer code = validateStatusCode(statusCode);
            String resolvedStatus = status == null ? statusFromStatusCode(code) : status;
            Validation.requireAllowedValue("network milestone status", resolvedStatus, LogBrewClient.ACTION_STATUSES);
            Validation.requireNonNegativeNumber("network milestone durationMs", durationMs);
            String resolvedName = name == null || name.trim().isEmpty()
                ? "network." + normalizedMethod.toLowerCase(Locale.ROOT) + " " + route
                : name;

            Map<String, Object> timeline = timelineMetadata("network.milestone", metadata);
            putIfPresent(timeline, "routeTemplate", route);
            putIfPresent(timeline, "method", normalizedMethod);
            putIfPresent(timeline, "statusCode", code);
            putIfPresent(timeline, "durationMs", durationMs);
            putIfPresent(timeline, "sessionId", stringOrNull(sessionId));
            putIfPresent(timeline, "traceId", stringOrNull(traceId));

            ActionAttributes attributes = ActionAttributes.create(resolvedName, resolvedStatus).metadata(timeline);
            attributes.toMap();
            return attributes;
        }
    }

    private static Map<String, Object> timelineMetadata(
        String source,
        Map<String, ?> localMetadata
    ) {
        Map<String, Object> merged = new LinkedHashMap<>();
        merged.put("source", source);
        Map<String, Object> copied = Validation.copyMetadata(localMetadata);
        if (copied != null) {
            merged.putAll(copied);
        }
        return merged;
    }

    private static void putIfPresent(Map<String, Object> metadata, String key, Object value) {
        if (value != null) {
            metadata.put(key, value);
        }
    }

    private static String requireRouteTemplate(String routeTemplate) {
        String sanitized = sanitizeRouteTemplate(routeTemplate);
        Validation.requireNonEmpty("network milestone routeTemplate", sanitized);
        return sanitized;
    }

    private static String sanitizeRouteTemplate(String routeTemplate) {
        if (routeTemplate == null) {
            return null;
        }
        String trimmed = routeTemplate.trim();
        if (trimmed.isEmpty()) {
            return "";
        }
        try {
            URI uri = URI.create(trimmed);
            if (uri.isAbsolute() || uri.getRawAuthority() != null) {
                String path = uri.getRawPath();
                return path == null || path.isEmpty() ? "/" : path;
            }
        } catch (IllegalArgumentException ignored) {
            // Fall back to simple query/hash stripping for route templates that are not valid URIs.
        }
        int query = trimmed.indexOf('?');
        int hash = trimmed.indexOf('#');
        int cutoff = firstPresentIndex(query, hash);
        if (cutoff >= 0) {
            trimmed = trimmed.substring(0, cutoff);
        }
        return trimmed.isEmpty() ? "/" : trimmed;
    }

    private static int firstPresentIndex(int left, int right) {
        if (left < 0) {
            return right;
        }
        if (right < 0) {
            return left;
        }
        return Math.min(left, right);
    }

    private static String normalizeHttpMethod(String method) {
        String value = method == null ? "GET" : method.trim();
        if (value.isEmpty()) {
            throw new SdkException("validation_error", "network milestone method must be a non-empty string");
        }
        String normalized = value.toUpperCase(Locale.ROOT);
        if (!isValidHttpMethod(normalized)) {
            throw new SdkException("validation_error", "network milestone method must be a valid HTTP method");
        }
        return normalized;
    }

    private static boolean isValidHttpMethod(String method) {
        for (int index = 0; index < method.length(); index++) {
            char character = method.charAt(index);
            if (index == 0 && (character < 'A' || character > 'Z')) {
                return false;
            }
            boolean allowed = (character >= 'A' && character <= 'Z')
                || (character >= '0' && character <= '9')
                || character == '_'
                || character == '-';
            if (!allowed) {
                return false;
            }
        }
        return true;
    }

    private static Integer validateStatusCode(Integer statusCode) {
        if (statusCode == null) {
            return null;
        }
        if (statusCode.intValue() < 100 || statusCode.intValue() > 599) {
            throw new SdkException("validation_error", "network milestone statusCode must be an integer from 100 to 599");
        }
        return statusCode;
    }

    private static String statusFromStatusCode(Integer statusCode) {
        if (statusCode != null && statusCode.intValue() >= 400) {
            return "failure";
        }
        return "success";
    }

    private static String stringOrNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }
}
