package co.logbrew.sdk;

import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Local-only support-ticket payload draft for planned backend support routes.
 *
 * <p>This helper validates the planned public support-ticket fields and redacts
 * diagnostics for explicit user or agent handoff. It does not send data, open a
 * ticket, call backend support-ticket routes, or use account/session API
 * credentials.</p>
 */
public final class SupportTicketDraft {
    private static final String[] SUPPORT_TICKET_SOURCES = {"cli", "sdk", "website", "docs", "mobile"};
    private static final String[] SUPPORT_TICKET_CATEGORIES = {
        "sdk_install_failure",
        "ingest_failure",
        "auth_failure",
        "project_setup",
        "dashboard_issue",
        "docs_confusion",
        "cli_issue",
        "mobile_issue",
        "billing_question",
        "other"
    };
    private static final Set<String> SENSITIVE_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "apikey",
        "auth",
        "authorization",
        "authtoken",
        "bearer",
        "clientsecret",
        "connectionstring",
        "cookie",
        "credential",
        "credentials",
        "dsn",
        "password",
        "passwd",
        "privatekey",
        "refreshtoken",
        "secret",
        "session",
        "setcookie",
        "token"
    )));
    private static final String[] SENSITIVE_KEY_MARKERS = {
        "auth",
        "connectionstring",
        "cookie",
        "credential",
        "dsn",
        "password",
        "passwd",
        "privatekey",
        "secret",
        "session",
        "token"
    };
    private static final Pattern TRACE_ID_PATTERN = Pattern.compile("^[0-9a-fA-F]{32}$");
    private static final String ZERO_TRACE_ID = "00000000000000000000000000000000";
    private static final Pattern SENSITIVE_ASSIGNMENT_PATTERN = Pattern.compile(
        "(?i)(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]"
    );
    private static final Pattern TOKEN_PATTERN = Pattern.compile(
        "(?i)(?:\\bBearer\\s+[A-Za-z0-9._~+/=-]+|\\blbw_ingest_[A-Za-z0-9._-]+"
            + "|\\b(?:sk|pk|xox[abprs]?)-[A-Za-z0-9_-]{10,}|\\bAKIA[0-9A-Z]{16}\\b)"
    );
    private static final Pattern URL_PATTERN = Pattern.compile("(?i)https?://[^\\s\"'<>]+");
    private static final Pattern POSIX_PATH_PATTERN = Pattern.compile(
        "(?:^|[^\\w.-])(?:/Users|/home|/var/folders|/private/var|/tmp)/[^\\s\"'<>]+"
    );
    private static final Pattern WINDOWS_PATH_PATTERN = Pattern.compile("\\b[A-Za-z]:\\\\[^\\s\"'<>]+");
    private static final String REDACTED = "[redacted]";
    private static final String REDACTED_PATH = "[redacted-path]";
    private static final String REDACTED_URL = "[redacted-url]";
    private static final int MAX_DIAGNOSTIC_DEPTH = 5;
    private static final int MAX_DIAGNOSTIC_ITEMS = 20;
    private static final int MAX_STRING_LENGTH = 500;
    private static final Object OMIT = new Object();

    private final String projectId;
    private final String source;
    private final String category;
    private final String title;
    private final String description;
    private final String environment;
    private final String runtime;
    private final String framework;
    private final String sdkPackage;
    private final String sdkVersion;
    private final String release;
    private final String traceId;
    private final String eventId;
    private final Map<String, Object> diagnostics;

    private SupportTicketDraft(
        String projectId,
        String source,
        String category,
        String title,
        String description,
        String environment,
        String runtime,
        String framework,
        String sdkPackage,
        String sdkVersion,
        String release,
        String traceId,
        String eventId,
        Map<String, Object> diagnostics
    ) {
        this.projectId = projectId;
        this.source = source;
        this.category = category;
        this.title = title;
        this.description = description;
        this.environment = environment;
        this.runtime = runtime;
        this.framework = framework;
        this.sdkPackage = sdkPackage;
        this.sdkVersion = sdkVersion;
        this.release = release;
        this.traceId = traceId;
        this.eventId = eventId;
        this.diagnostics = diagnostics == null ? Collections.emptyMap() : diagnostics;
    }

    /**
     * Creates a local-only support-ticket draft from validated input.
     */
    public static SupportTicketDraft create(Input input) {
        if (input == null) {
            throw new SdkException("validation_error", "support ticket draft input must be provided");
        }
        Validation.requireAllowedValue("support ticket source", input.source, SUPPORT_TICKET_SOURCES);
        Validation.requireAllowedValue("support ticket category", input.category, SUPPORT_TICKET_CATEGORIES);
        Validation.requireNonEmpty("support ticket title", input.title);
        Validation.requireNonEmpty("support ticket description", input.description);
        return new SupportTicketDraft(
            cleanOptionalString("support ticket project_id", input.projectId),
            input.source,
            input.category,
            input.title.trim(),
            input.description.trim(),
            cleanOptionalString("support ticket environment", input.environment),
            cleanOptionalString("support ticket runtime", input.runtime),
            cleanOptionalString("support ticket framework", input.framework),
            cleanOptionalString("support ticket sdk_package", input.sdkPackage),
            cleanOptionalString("support ticket sdk_version", input.sdkVersion),
            cleanOptionalString("support ticket release", input.release),
            normalizeTraceId(input.traceId),
            cleanOptionalString("support ticket event_id", input.eventId),
            sanitizeDiagnostics(input.diagnostics)
        );
    }

    /**
     * Returns the optional project ID.
     */
    public String projectId() {
        return projectId;
    }

    /**
     * Returns the planned source value.
     */
    public String source() {
        return source;
    }

    /**
     * Returns the planned category value.
     */
    public String category() {
        return category;
    }

    /**
     * Returns the required ticket title.
     */
    public String title() {
        return title;
    }

    /**
     * Returns the required ticket description.
     */
    public String description() {
        return description;
    }

    /**
     * Returns the optional environment.
     */
    public String environment() {
        return environment;
    }

    /**
     * Returns the optional runtime.
     */
    public String runtime() {
        return runtime;
    }

    /**
     * Returns the optional framework.
     */
    public String framework() {
        return framework;
    }

    /**
     * Returns the optional SDK package name.
     */
    public String sdkPackage() {
        return sdkPackage;
    }

    /**
     * Returns the optional SDK version.
     */
    public String sdkVersion() {
        return sdkVersion;
    }

    /**
     * Returns the optional release identifier.
     */
    public String release() {
        return release;
    }

    /**
     * Returns the optional normalized W3C trace ID.
     */
    public String traceId() {
        return traceId;
    }

    /**
     * Returns the optional event ID.
     */
    public String eventId() {
        return eventId;
    }

    /**
     * Returns a defensive copy of sanitized diagnostics.
     */
    public Map<String, Object> diagnostics() {
        return copyMap(diagnostics);
    }

    /**
     * Returns the planned backend create payload fields.
     */
    public Map<String, Object> toMap() {
        Map<String, Object> payload = new LinkedHashMap<>();
        putOptional(payload, "project_id", projectId);
        payload.put("source", source);
        payload.put("category", category);
        payload.put("title", title);
        payload.put("description", description);
        putOptional(payload, "environment", environment);
        putOptional(payload, "runtime", runtime);
        putOptional(payload, "framework", framework);
        putOptional(payload, "sdk_package", sdkPackage);
        putOptional(payload, "sdk_version", sdkVersion);
        putOptional(payload, "release", release);
        putOptional(payload, "trace_id", traceId);
        putOptional(payload, "event_id", eventId);
        if (!diagnostics.isEmpty()) {
            payload.put("diagnostics", copyMap(diagnostics));
        }
        return payload;
    }

    /**
     * Returns the planned backend create payload as JSON.
     */
    public String toJson() {
        return Json.write(toMap());
    }

    /**
     * Inputs for creating a local-only support-ticket draft.
     */
    public static final class Input {
        private final String source;
        private final String category;
        private final String title;
        private final String description;
        private String projectId;
        private String environment;
        private String runtime;
        private String framework;
        private String sdkPackage;
        private String sdkVersion;
        private String release;
        private String traceId;
        private String eventId;
        private Map<String, ?> diagnostics;

        private Input(String source, String category, String title, String description) {
            this.source = source;
            this.category = category;
            this.title = title;
            this.description = description;
        }

        /**
         * Creates input with the required planned support-ticket fields.
         */
        public static Input create(String source, String category, String title, String description) {
            return new Input(source, category, title, description);
        }

        /**
         * Sets optional project ID.
         */
        public Input projectId(String projectId) {
            this.projectId = projectId;
            return this;
        }

        /**
         * Sets optional environment.
         */
        public Input environment(String environment) {
            this.environment = environment;
            return this;
        }

        /**
         * Sets optional runtime.
         */
        public Input runtime(String runtime) {
            this.runtime = runtime;
            return this;
        }

        /**
         * Sets optional framework.
         */
        public Input framework(String framework) {
            this.framework = framework;
            return this;
        }

        /**
         * Sets optional SDK package.
         */
        public Input sdkPackage(String sdkPackage) {
            this.sdkPackage = sdkPackage;
            return this;
        }

        /**
         * Sets optional SDK version.
         */
        public Input sdkVersion(String sdkVersion) {
            this.sdkVersion = sdkVersion;
            return this;
        }

        /**
         * Sets optional release identifier.
         */
        public Input release(String release) {
            this.release = release;
            return this;
        }

        /**
         * Sets optional W3C trace ID for correlation.
         */
        public Input traceId(String traceId) {
            this.traceId = traceId;
            return this;
        }

        /**
         * Sets optional event ID.
         */
        public Input eventId(String eventId) {
            this.eventId = eventId;
            return this;
        }

        /**
         * Sets optional diagnostics. Values are sanitized while creating the draft.
         */
        public Input diagnostics(Map<String, ?> diagnostics) {
            this.diagnostics = diagnostics == null ? null : new LinkedHashMap<>(diagnostics);
            return this;
        }
    }

    private static String cleanOptionalString(String label, String value) {
        if (value == null) {
            return null;
        }
        Validation.requireNonEmpty(label, value);
        return value.trim();
    }

    private static String normalizeTraceId(String traceId) {
        if (traceId == null) {
            return null;
        }
        Validation.requireNonEmpty("support ticket trace_id", traceId);
        String normalized = traceId.trim().toLowerCase(Locale.ROOT);
        if (!TRACE_ID_PATTERN.matcher(normalized).matches()) {
            throw new SdkException("validation_error", "support ticket trace_id must be 32 hex characters");
        }
        if (ZERO_TRACE_ID.equals(normalized)) {
            throw new SdkException("validation_error", "support ticket trace_id must not be all zeros");
        }
        return normalized;
    }

    private static Map<String, Object> sanitizeDiagnostics(Map<String, ?> diagnostics) {
        if (diagnostics == null) {
            return Collections.emptyMap();
        }
        Map<String, Object> safe = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : diagnostics.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.isEmpty()) {
                continue;
            }
            if (isSensitiveKey(key)) {
                safe.put(key, REDACTED);
                continue;
            }
            Object sanitized = sanitizeDiagnosticValue(entry.getValue(), 0);
            if (sanitized != OMIT) {
                safe.put(key, sanitized);
            }
        }
        return safe;
    }

    private static Object sanitizeDiagnosticValue(Object value, int depth) {
        if (depth > MAX_DIAGNOSTIC_DEPTH) {
            return OMIT;
        }
        if (value == null || value instanceof Boolean) {
            return value;
        }
        if (value instanceof String) {
            return sanitizeString((String) value);
        }
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) {
            return value;
        }
        if (value instanceof Double) {
            Double number = (Double) value;
            return number.isNaN() || number.isInfinite() ? OMIT : number;
        }
        if (value instanceof Float) {
            Float number = (Float) value;
            return number.isNaN() || number.isInfinite() ? OMIT : number;
        }
        if (value instanceof Throwable) {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("type", value.getClass().getName());
            return error;
        }
        if (value instanceof Map<?, ?>) {
            return sanitizeDiagnosticMap((Map<?, ?>) value, depth);
        }
        if (value instanceof Iterable<?>) {
            return sanitizeDiagnosticIterable((Iterable<?>) value, depth);
        }
        Class<?> valueClass = value.getClass();
        if (valueClass.isArray()) {
            return sanitizeDiagnosticArray(value, depth);
        }
        return OMIT;
    }

    private static Map<String, Object> sanitizeDiagnosticMap(Map<?, ?> value, int depth) {
        Map<String, Object> safe = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : value.entrySet()) {
            Object keyValue = entry.getKey();
            if (!(keyValue instanceof String)) {
                continue;
            }
            String key = (String) keyValue;
            if (key.isEmpty()) {
                continue;
            }
            if (isSensitiveKey(key)) {
                safe.put(key, REDACTED);
                continue;
            }
            Object sanitized = sanitizeDiagnosticValue(entry.getValue(), depth + 1);
            if (sanitized != OMIT) {
                safe.put(key, sanitized);
            }
        }
        return safe;
    }

    private static List<Object> sanitizeDiagnosticIterable(Iterable<?> value, int depth) {
        List<Object> safe = new ArrayList<>();
        for (Object item : value) {
            if (safe.size() >= MAX_DIAGNOSTIC_ITEMS) {
                break;
            }
            Object sanitized = sanitizeDiagnosticValue(item, depth + 1);
            if (sanitized != OMIT) {
                safe.add(sanitized);
            }
        }
        return safe;
    }

    private static List<Object> sanitizeDiagnosticArray(Object value, int depth) {
        int limit = Math.min(Array.getLength(value), MAX_DIAGNOSTIC_ITEMS);
        List<Object> safe = new ArrayList<>();
        for (int index = 0; index < limit; index++) {
            Object sanitized = sanitizeDiagnosticValue(Array.get(value, index), depth + 1);
            if (sanitized != OMIT) {
                safe.add(sanitized);
            }
        }
        return safe;
    }

    private static boolean isSensitiveKey(String key) {
        String normalized = normalizeKey(key);
        if (SENSITIVE_KEYS.contains(normalized)) {
            return true;
        }
        for (String marker : SENSITIVE_KEY_MARKERS) {
            if (normalized.contains(marker)) {
                return true;
            }
        }
        return false;
    }

    private static String normalizeKey(String key) {
        StringBuilder normalized = new StringBuilder();
        String lower = key.toLowerCase(Locale.ROOT);
        for (int index = 0; index < lower.length(); index++) {
            char character = lower.charAt(index);
            if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')) {
                normalized.append(character);
            }
        }
        return normalized.toString();
    }

    private static String sanitizeString(String value) {
        if (SENSITIVE_ASSIGNMENT_PATTERN.matcher(value).find() || TOKEN_PATTERN.matcher(value).find()) {
            return REDACTED;
        }
        String sanitized = redactUrls(value);
        sanitized = redactPosixPaths(sanitized);
        sanitized = WINDOWS_PATH_PATTERN.matcher(sanitized).replaceAll(REDACTED_PATH);
        if (sanitized.length() > MAX_STRING_LENGTH) {
            return sanitized.substring(0, MAX_STRING_LENGTH - 3) + "...";
        }
        return sanitized;
    }

    private static String redactUrls(String value) {
        Matcher matcher = URL_PATTERN.matcher(value);
        StringBuffer output = new StringBuffer();
        while (matcher.find()) {
            String replacement = REDACTED_URL + pathFromUrl(matcher.group());
            matcher.appendReplacement(output, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(output);
        return output.toString();
    }

    private static String pathFromUrl(String value) {
        int schemeIndex = value.indexOf("://");
        int pathIndex = value.indexOf('/', schemeIndex < 0 ? 0 : schemeIndex + 3);
        if (pathIndex < 0) {
            return "";
        }
        String path = value.substring(pathIndex);
        int queryIndex = path.indexOf('?');
        if (queryIndex >= 0) {
            path = path.substring(0, queryIndex);
        }
        int fragmentIndex = path.indexOf('#');
        if (fragmentIndex >= 0) {
            path = path.substring(0, fragmentIndex);
        }
        return path;
    }

    private static String redactPosixPaths(String value) {
        Matcher matcher = POSIX_PATH_PATTERN.matcher(value);
        StringBuffer output = new StringBuffer();
        while (matcher.find()) {
            String match = matcher.group();
            String replacement = match.startsWith("/") ? REDACTED_PATH : match.substring(0, 1) + REDACTED_PATH;
            matcher.appendReplacement(output, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(output);
        return output.toString();
    }

    private static void putOptional(Map<String, Object> target, String key, String value) {
        if (value != null) {
            target.put(key, value);
        }
    }

    private static Map<String, Object> copyMap(Map<String, ?> source) {
        Map<String, Object> copied = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : source.entrySet()) {
            copied.put(entry.getKey(), copyValue(entry.getValue()));
        }
        return copied;
    }

    private static Object copyValue(Object value) {
        if (value instanceof Map<?, ?>) {
            Map<String, Object> copied = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                copied.put(String.valueOf(entry.getKey()), copyValue(entry.getValue()));
            }
            return copied;
        }
        if (value instanceof Iterable<?>) {
            List<Object> copied = new ArrayList<>();
            for (Object item : (Iterable<?>) value) {
                copied.add(copyValue(item));
            }
            return copied;
        }
        return value;
    }
}
