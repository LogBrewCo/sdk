package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

final class Validation {
    private Validation() {
    }

    static void requireNonEmpty(String label, String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new SdkException("validation_error", label + " must be non-empty");
        }
    }

    static void requireAllowedValue(String label, String value, String[] allowedValues) {
        requireNonEmpty(label, value);
        for (String allowedValue : allowedValues) {
            if (allowedValue.equals(value)) {
                return;
            }
        }
        throw new SdkException("validation_error", label + " must be one of: " + String.join(", ", allowedValues));
    }

    static void requireTimestamp(String timestamp) {
        requireNonEmpty("timestamp", timestamp);
        if (timestamp.endsWith("Z")) {
            return;
        }
        int separator = timestamp.indexOf('T');
        if (separator < 0 || separator == timestamp.length() - 1) {
            throw timestampError(timestamp);
        }
        String timePortion = timestamp.substring(separator + 1);
        if (timePortion.contains("+")) {
            return;
        }
        if (timePortion.lastIndexOf('-') > 0) {
            return;
        }
        throw timestampError(timestamp);
    }

    static Map<String, Object> copyMetadata(Map<String, ?> metadata) {
        if (metadata == null) {
            return null;
        }
        Map<String, Object> copied = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : metadata.entrySet()) {
            String key = entry.getKey();
            if (key == null) {
                throw new SdkException("validation_error", "metadata keys must be strings");
            }
            Object value = entry.getValue();
            if (!isMetadataValue(value)) {
                throw new SdkException(
                    "validation_error",
                    "metadata value for " + key + " must be a string, number, boolean, or null"
                );
            }
            copied.put(key, value);
        }
        return copied;
    }

    static void putOptionalString(Map<String, Object> target, String key, String value) {
        if (value != null) {
            target.put(key, value);
        }
    }

    static void putOptionalMetadata(Map<String, Object> target, Map<String, ?> metadata) {
        Map<String, Object> copied = copyMetadata(metadata);
        if (copied != null) {
            target.put("metadata", copied);
        }
    }

    static void requireNonNegativeNumber(String label, Double value) {
        if (value != null && (value.doubleValue() < 0.0 || value.isNaN() || value.isInfinite())) {
            throw new SdkException("validation_error", label + " must be non-negative");
        }
    }

    private static SdkException timestampError(String timestamp) {
        return new SdkException("validation_error", "timestamp must include a timezone offset: " + timestamp);
    }

    private static boolean isMetadataValue(Object value) {
        if (value == null || value instanceof String || value instanceof Boolean) {
            return true;
        }
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) {
            return true;
        }
        if (value instanceof Double) {
            Double number = (Double) value;
            return !number.isNaN() && !number.isInfinite();
        }
        if (value instanceof Float) {
            Float number = (Float) value;
            return !number.isNaN() && !number.isInfinite();
        }
        return false;
    }
}
