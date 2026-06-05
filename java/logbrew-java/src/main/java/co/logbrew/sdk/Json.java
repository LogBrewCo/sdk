package co.logbrew.sdk;

import java.util.Iterator;
import java.util.Map;

final class Json {
    private Json() {
    }

    static String write(Object value) {
        StringBuilder builder = new StringBuilder();
        writeValue(builder, value, 0);
        return builder.toString();
    }

    private static void writeValue(StringBuilder builder, Object value, int depth) {
        if (value == null) {
            builder.append("null");
            return;
        }
        if (value instanceof String) {
            writeString(builder, (String) value);
            return;
        }
        if (value instanceof Boolean) {
            builder.append(((Boolean) value).booleanValue() ? "true" : "false");
            return;
        }
        if (value instanceof Number) {
            writeNumber(builder, (Number) value);
            return;
        }
        if (value instanceof Map<?, ?>) {
            writeMap(builder, (Map<?, ?>) value, depth);
            return;
        }
        if (value instanceof Iterable<?>) {
            writeIterable(builder, (Iterable<?>) value, depth);
            return;
        }
        throw new SdkException("serialization_error", "unsupported JSON value: " + value.getClass().getName());
    }

    private static void writeMap(StringBuilder builder, Map<?, ?> value, int depth) {
        builder.append('{');
        if (!value.isEmpty()) {
            builder.append('\n');
            Iterator<? extends Map.Entry<?, ?>> iterator = value.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<?, ?> entry = iterator.next();
                indent(builder, depth + 1);
                writeString(builder, String.valueOf(entry.getKey()));
                builder.append(": ");
                writeValue(builder, entry.getValue(), depth + 1);
                if (iterator.hasNext()) {
                    builder.append(',');
                }
                builder.append('\n');
            }
            indent(builder, depth);
        }
        builder.append('}');
    }

    private static void writeIterable(StringBuilder builder, Iterable<?> value, int depth) {
        builder.append('[');
        Iterator<?> iterator = value.iterator();
        if (iterator.hasNext()) {
            builder.append('\n');
            while (iterator.hasNext()) {
                Object item = iterator.next();
                indent(builder, depth + 1);
                writeValue(builder, item, depth + 1);
                if (iterator.hasNext()) {
                    builder.append(',');
                }
                builder.append('\n');
            }
            indent(builder, depth);
        }
        builder.append(']');
    }

    private static void writeNumber(StringBuilder builder, Number value) {
        if (value instanceof Double) {
            Double number = (Double) value;
            if (number.isNaN() || number.isInfinite()) {
                throw new SdkException("serialization_error", "JSON numbers must be finite");
            }
        }
        if (value instanceof Float) {
            Float number = (Float) value;
            if (number.isNaN() || number.isInfinite()) {
                throw new SdkException("serialization_error", "JSON numbers must be finite");
            }
        }
        builder.append(value);
    }

    private static void writeString(StringBuilder builder, String value) {
        builder.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"':
                    builder.append("\\\"");
                    break;
                case '\\':
                    builder.append("\\\\");
                    break;
                case '\b':
                    builder.append("\\b");
                    break;
                case '\f':
                    builder.append("\\f");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (character < 0x20) {
                        builder.append(String.format("\\u%04x", Integer.valueOf(character)));
                    } else {
                        builder.append(character);
                    }
                    break;
            }
        }
        builder.append('"');
    }

    private static void indent(StringBuilder builder, int depth) {
        for (int index = 0; index < depth; index++) {
            builder.append("  ");
        }
    }
}
