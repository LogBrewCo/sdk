package co.logbrew.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

final class TelemetryValues {
    static final int MAX_TAGS = 32;

    private static final int MAX_ID_LENGTH = 200;
    private static final int MAX_STRING_LENGTH = 256;
    private static final Pattern TRACE_ID_PATTERN = Pattern.compile("^[0-9a-fA-F]{32}$");
    private static final Pattern SPAN_ID_PATTERN = Pattern.compile("^[0-9a-fA-F]{16}$");
    private static final Pattern TAG_KEY_PATTERN = Pattern.compile("^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
    private static final String ZERO_TRACE_ID = "00000000000000000000000000000000";
    private static final String ZERO_SPAN_ID = "0000000000000000";

    private TelemetryValues() {
    }

    static String requiredString(String value, String label) {
        String normalized = normalize(value);
        if (!validString(normalized, MAX_STRING_LENGTH)) {
            throw invalid(label + " is invalid");
        }
        return normalized;
    }

    static String optionalString(String value, String label) {
        if (value == null || value.isEmpty()) {
            return null;
        }
        return requiredString(value, label);
    }

    static String safeOptionalString(String value) {
        if (value == null) {
            return null;
        }
        String normalized = normalize(value);
        return validString(normalized, MAX_STRING_LENGTH) ? normalized : null;
    }

    static String requiredId(String value, String label) {
        String normalized = normalize(value);
        if (!validString(normalized, MAX_ID_LENGTH)) {
            throw invalid(label + " is invalid");
        }
        return normalized;
    }

    static String optionalId(String value, String label) {
        if (value == null || value.isEmpty()) {
            return null;
        }
        return requiredId(value, label);
    }

    static String traceId(String value, String label) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (!TRACE_ID_PATTERN.matcher(normalized).matches() || ZERO_TRACE_ID.equals(normalized)) {
            throw invalid(label + " must be 32 non-zero hex characters");
        }
        return normalized;
    }

    static String optionalSpanId(String value, String label) {
        if (value == null || value.isEmpty()) {
            return null;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        if (!SPAN_ID_PATTERN.matcher(normalized).matches() || ZERO_SPAN_ID.equals(normalized)) {
            throw invalid(label + " must be 16 non-zero hex characters");
        }
        return normalized;
    }

    static String tagKey(String value) {
        if (value == null || !TAG_KEY_PATTERN.matcher(value).matches()) {
            throw invalid("tag key is invalid");
        }
        return value;
    }

    static Map<String, Object> immutableMap(Map<String, Object> source) {
        Map<String, Object> copied = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : source.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Map<?, ?>) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nested = (Map<String, Object>) value;
                value = immutableMap(nested);
            }
            copied.put(entry.getKey(), value);
        }
        return Collections.unmodifiableMap(copied);
    }

    static Map<String, Object> mutableMap(Map<String, Object> source) {
        Map<String, Object> copied = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : source.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Map<?, ?>) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nested = (Map<String, Object>) value;
                value = mutableMap(nested);
            }
            copied.put(entry.getKey(), value);
        }
        return copied;
    }

    static SdkException invalid(String message) {
        return new SdkException("validation_error", message);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }

    private static boolean validString(String value, int maximumCodePoints) {
        if (value.isEmpty() || value.codePointCount(0, value.length()) > maximumCodePoints) {
            return false;
        }
        for (int index = 0; index < value.length();) {
            int codePoint = value.codePointAt(index);
            if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
                return false;
            }
            index += Character.charCount(codePoint);
        }
        return true;
    }
}
