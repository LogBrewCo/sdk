package co.logbrew.sdk;

import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

final class IssueDiagnostics {
    static final int MAX_STACK_FRAMES = 32;
    static final int MAX_BREADCRUMBS = 64;
    static final int MAX_EXCEPTIONS = 8;

    private static final int MAX_EXCEPTION_TYPE = 256;
    private static final int MAX_EXCEPTION_MESSAGE = 1024;
    private static final int MAX_EXCEPTION_MODULE = 512;
    private static final int MAX_MECHANISM_TYPE = 64;
    private static final int MAX_FRAME_FILENAME = 2048;
    private static final int MAX_FRAME_FUNCTION = 256;
    private static final int MAX_FRAME_MODULE = 512;
    private static final int MAX_BREADCRUMB_NAME = 64;
    private static final int MAX_BREADCRUMB_MESSAGE = 512;
    private static final int MAX_BREADCRUMB_DATA_FIELDS = 8;
    private static final int MAX_BREADCRUMB_DATA_STRING = 256;

    private static final Pattern MACHINE_NAME = Pattern.compile("^[A-Za-z][A-Za-z0-9_.:-]{0,63}$");
    private static final Pattern DATA_KEY = Pattern.compile("^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
    private static final Pattern DEBUG_ID = Pattern.compile(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    );
    private static final Pattern RFC3339 = Pattern.compile(
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$"
    );

    private IssueDiagnostics() {
    }

    static String requireExceptionType(String value) {
        return requireText("issue exception type", value, MAX_EXCEPTION_TYPE, true);
    }

    static String requireMechanismType(String value) {
        return requireMachineName("issue exception mechanism type", value, MAX_MECHANISM_TYPE, true);
    }

    static String requireExceptionMessage(String value) {
        return requireText("issue exceptionChain message", value, MAX_EXCEPTION_MESSAGE, false);
    }

    static String requireExceptionModule(String value) {
        return requireText("issue exceptionChain module", value, MAX_EXCEPTION_MODULE, true);
    }

    static String requireBreadcrumbName(String label, String value, boolean allowColon) {
        return requireMachineName(label, value, MAX_BREADCRUMB_NAME, allowColon);
    }

    static String requireBreadcrumbMessage(String value) {
        return requireText("issue breadcrumb message", value, MAX_BREADCRUMB_MESSAGE, false);
    }

    static String requireFrameFunction(String value) {
        return requireText("issue stack frame function", value, MAX_FRAME_FUNCTION, false);
    }

    static String requireFrameModule(String value) {
        return requireText("issue stack frame module", value, MAX_FRAME_MODULE, true);
    }

    static int requireCoordinate(String label, int value) {
        if (value < 1) {
            throw validation(label + " must be a positive integer");
        }
        return value;
    }

    static String normalizeDebugId(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (!DEBUG_ID.matcher(normalized).matches()) {
            throw validation("issue stack frame debugId is invalid");
        }
        return normalized;
    }

    static String sanitizeFilename(String value) {
        if (value == null) {
            throw validation("issue stack frame filename is invalid");
        }
        String filename = value.trim();
        boolean fileUrl = filename.startsWith("file://");
        if (fileUrl) {
            filename = filename.substring("file://".length());
        }
        int query = filename.indexOf('?');
        int fragment = filename.indexOf('#');
        int end = filename.length();
        if (query >= 0) {
            end = Math.min(end, query);
        }
        if (fragment >= 0) {
            end = Math.min(end, fragment);
        }
        filename = filename.substring(0, end).trim();
        boolean absolute = fileUrl
            || filename.startsWith("/")
            || filename.startsWith("\\")
            || (filename.length() >= 3
                && isAsciiLetter(filename.charAt(0))
                && filename.charAt(1) == ':'
                && (filename.charAt(2) == '/' || filename.charAt(2) == '\\'));
        if (absolute) {
            filename = basename(filename);
        }
        return requireText("issue stack frame filename", filename, MAX_FRAME_FILENAME, true);
    }

    static void requireBreadcrumbTimestamp(String value) {
        if (value == null || !RFC3339.matcher(value).matches()) {
            throw validation("issue breadcrumb timestamp must be RFC 3339 with an explicit timezone");
        }
        try {
            OffsetDateTime.parse(value);
        } catch (DateTimeParseException error) {
            throw validation("issue breadcrumb timestamp must be RFC 3339 with an explicit timezone");
        }
    }

    static String normalizeBreadcrumbLevel(String value) {
        if (value == null) {
            return null;
        }
        switch (value) {
            case "trace":
            case "debug":
                return "debug";
            case "log":
            case "info":
                return "info";
            case "warn":
            case "warning":
                return "warning";
            case "error":
                return "error";
            case "fatal":
            case "critical":
                return "critical";
            default:
                throw validation(
                    "issue breadcrumb level must be one of: trace, debug, info, log, warn, warning, error, fatal, critical"
                );
        }
    }

    static Map<String, Object> copyBreadcrumbData(Map<String, ?> input) {
        if (input == null) {
            throw validation("issue breadcrumb data must be provided");
        }
        if (input.size() > MAX_BREADCRUMB_DATA_FIELDS) {
            throw validation("issue breadcrumb data must contain at most 8 fields");
        }
        Map<String, Object> copied = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : input.entrySet()) {
            String key = entry.getKey();
            if (key == null || !DATA_KEY.matcher(key).matches()) {
                throw validation("issue breadcrumb data keys must be stable machine names");
            }
            Object value = entry.getValue();
            if (value == null || value instanceof Boolean || isInteger(value)) {
                copied.put(key, value);
            } else if (value instanceof Double) {
                Double number = (Double) value;
                if (number.isNaN() || number.isInfinite()) {
                    throw primitiveError(key);
                }
                copied.put(key, number);
            } else if (value instanceof Float) {
                Float number = (Float) value;
                if (number.isNaN() || number.isInfinite()) {
                    throw primitiveError(key);
                }
                copied.put(key, number);
            } else if (value instanceof String) {
                copied.put(
                    key,
                    requireText(
                        "issue breadcrumb data value for " + key,
                        (String) value,
                        MAX_BREADCRUMB_DATA_STRING,
                        false
                    )
                );
            } else {
                throw primitiveError(key);
            }
        }
        return copied;
    }

    static String safeExceptionType(Throwable error) {
        if (error == null) {
            throw validation("issue error must be provided");
        }
        String candidate;
        try {
            candidate = error.getClass().getSimpleName();
            if (candidate.trim().isEmpty()) {
                candidate = basename(error.getClass().getName().replace('.', '/'));
            }
        } catch (RuntimeException | LinkageError failure) {
            candidate = "Throwable";
        }
        return safeText(candidate, MAX_EXCEPTION_TYPE, true, "Throwable");
    }

    static List<IssueStackFrame> stackFrames(Throwable error) {
        return stackEvidence(error).frames();
    }

    static StackEvidence stackEvidence(Throwable error) {
        if (error == null) {
            throw validation("issue error must be provided");
        }
        StackTraceElement[] elements;
        try {
            elements = error.getStackTrace();
        } catch (RuntimeException | LinkageError failure) {
            return new StackEvidence(List.of(), false);
        }
        List<IssueStackFrame> frames = new ArrayList<>();
        for (StackTraceElement element : elements) {
            if (element == null) {
                continue;
            }
            String module = safeText(element.getClassName(), MAX_FRAME_MODULE, true, null);
            String function = safeText(element.getMethodName(), MAX_FRAME_FUNCTION, false, null);
            String filename = generatedFilename(element.getFileName(), module);
            int line = element.getLineNumber();
            IssueStackFrame frame = IssueStackFrame.create(filename, line > 0 ? line : 1, 1);
            if (function != null) {
                frame.function(function);
            }
            if (module != null) {
                frame.module(module);
            }
            frames.add(frame);
            if (frames.size() == MAX_STACK_FRAMES) {
                break;
            }
        }
        return new StackEvidence(frames, elements.length > MAX_STACK_FRAMES);
    }

    static String safeExceptionModule(Throwable error) {
        try {
            Package exceptionPackage = error.getClass().getPackage();
            String value = exceptionPackage == null ? null : exceptionPackage.getName();
            return safeText(value, MAX_EXCEPTION_MODULE, true, null);
        } catch (RuntimeException | LinkageError failure) {
            return null;
        }
    }

    static boolean hasExceptionMessage(Throwable error) {
        try {
            String message = error.getMessage();
            return message != null && !message.trim().isEmpty();
        } catch (RuntimeException | LinkageError failure) {
            return false;
        }
    }

    static Throwable safeCause(Throwable error) {
        try {
            return error.getCause();
        } catch (RuntimeException | LinkageError failure) {
            return null;
        }
    }

    static Throwable[] safeSuppressed(Throwable error) {
        try {
            Throwable[] values = error.getSuppressed();
            return values == null ? new Throwable[0] : values;
        } catch (RuntimeException | LinkageError failure) {
            return new Throwable[0];
        }
    }

    private static String generatedFilename(String fileName, String module) {
        String candidate = fileName;
        if (candidate == null || candidate.trim().isEmpty()) {
            String leaf = module == null ? "Thread" : basename(module.replace('.', '/'));
            candidate = safeText(leaf, 240, false, "Thread") + ".java";
        }
        try {
            return basename(sanitizeFilename(candidate));
        } catch (SdkException error) {
            return "Thread.java";
        }
    }

    private static String requireMachineName(String label, String value, int maximum, boolean allowColon) {
        String normalized = value == null ? "" : value.trim();
        Pattern pattern = allowColon ? MACHINE_NAME : DATA_KEY;
        if (codePointLength(normalized) > maximum || !pattern.matcher(normalized).matches()) {
            throw validation(label + " must be a stable machine name");
        }
        return normalized;
    }

    private static String requireText(
        String label,
        String value,
        int maximum,
        boolean rejectLocationText
    ) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty()
            || codePointLength(normalized) > maximum
            || hasControlCharacter(normalized)
            || (rejectLocationText && (normalized.indexOf('?') >= 0 || normalized.indexOf('#') >= 0))) {
            throw validation(label + " is invalid or exceeds " + maximum + " characters");
        }
        return normalized;
    }

    private static String safeText(String value, int maximum, boolean rejectLocationText, String fallback) {
        try {
            return requireText("issue diagnostic identity", value, maximum, rejectLocationText);
        } catch (SdkException error) {
            return fallback;
        }
    }

    private static String basename(String value) {
        String normalized = value.replace('\\', '/');
        while (normalized.endsWith("/") && normalized.length() > 1) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        int separator = normalized.lastIndexOf('/');
        return separator >= 0 ? normalized.substring(separator + 1) : normalized;
    }

    private static boolean isInteger(Object value) {
        return value instanceof Byte
            || value instanceof Short
            || value instanceof Integer
            || value instanceof Long;
    }

    private static boolean hasControlCharacter(String value) {
        return value.codePoints().anyMatch(codePoint -> codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
    }

    private static int codePointLength(String value) {
        return value.codePointCount(0, value.length());
    }

    private static boolean isAsciiLetter(char value) {
        return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
    }

    private static SdkException primitiveError(String key) {
        return validation("issue breadcrumb data value for " + key + " must be a finite primitive");
    }

    static SdkException validation(String message) {
        return new SdkException("validation_error", message);
    }

    static final class StackEvidence {
        private final List<IssueStackFrame> frames;
        private final boolean truncated;

        StackEvidence(List<IssueStackFrame> frames, boolean truncated) {
            this.frames = frames;
            this.truncated = truncated;
        }

        List<IssueStackFrame> frames() {
            return frames;
        }

        boolean truncated() {
            return truncated;
        }
    }
}
