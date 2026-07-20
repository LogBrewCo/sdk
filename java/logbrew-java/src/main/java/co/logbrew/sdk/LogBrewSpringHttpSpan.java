package co.logbrew.sdk;

import java.net.IDN;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

final class LogBrewSpringHttpSpan {
    private final String eventIdPrefix;
    private final String framework;
    private final String host;
    private final String method;
    private final String source;
    private final Instant startedAt;
    private final LogBrewTraceContext trace;

    private LogBrewSpringHttpSpan(
        String method,
        URI uri,
        String source,
        String framework,
        String eventIdPrefix,
        Instant startedAt
    ) {
        this.method = Objects.requireNonNull(method, "method").toUpperCase(Locale.ROOT);
        this.host = normalizedHost(Objects.requireNonNull(uri, "uri"));
        this.source = Objects.requireNonNull(source, "source");
        this.framework = Objects.requireNonNull(framework, "framework");
        this.eventIdPrefix = Objects.requireNonNull(eventIdPrefix, "eventIdPrefix");
        this.startedAt = Objects.requireNonNull(startedAt, "startedAt");
        this.trace = childTrace();
    }

    static LogBrewSpringHttpSpan start(
        String method,
        URI uri,
        String source,
        String framework,
        String eventIdPrefix,
        Instant startedAt
    ) {
        return new LogBrewSpringHttpSpan(method, uri, source, framework, eventIdPrefix, startedAt);
    }

    String traceparent() {
        return trace.traceparent();
    }

    LogBrewTrace.Scope activate() {
        return LogBrewTrace.activate(trace);
    }

    void finish(
        LogBrewClient client,
        int statusCode,
        Throwable requestError,
        boolean cancelled,
        boolean empty,
        Instant finishedAt
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("source", source);
        metadata.put("framework", framework);
        metadata.put("sampled", Boolean.valueOf(trace.sampled()));
        metadata.put("method", method);
        metadata.put("http.request.method", method);
        if (host != null) {
            metadata.put("host", host);
            metadata.put("server.address", host);
        }
        if (statusCode > 0) {
            metadata.put("statusCode", Integer.valueOf(statusCode));
            metadata.put("http.response.status_code", Integer.valueOf(statusCode));
        }
        if (cancelled) {
            metadata.put("cancelled", Boolean.TRUE);
            addErrorType(metadata, "CancellationException");
        } else if (requestError != null) {
            addErrorType(metadata, errorType(requestError));
        } else if (empty) {
            metadata.put("empty", Boolean.TRUE);
            addErrorType(metadata, "EmptyResponseException");
        }
        metadata = LogBrewTrace.metadataWithTrace(trace, metadata);

        boolean successful = !cancelled && !empty && requestError == null && statusCode < 400;
        Instant safeFinishedAt = Objects.requireNonNull(finishedAt, "finishedAt");
        double durationMs = Duration.between(startedAt, safeFinishedAt).toNanos() / 1_000_000.0;
        SpanAttributes attributes = SpanAttributes.create(
            "HTTP " + method,
            trace.traceId(),
            trace.spanId(),
            successful ? "ok" : "error"
        ).durationMs(durationMs).metadata(metadata);
        if (trace.parentSpanId() != null) {
            attributes.parentSpanId(trace.parentSpanId());
        }
        client.span(eventIdPrefix + "_span_" + trace.spanId(), safeFinishedAt.toString(), attributes);
    }

    private static void addErrorType(Map<String, Object> metadata, String errorType) {
        metadata.put("errorType", errorType);
        metadata.put("error.type", errorType);
    }

    private static LogBrewTraceContext childTrace() {
        LogBrewTraceContext generated = LogBrewTraceContext.generate();
        return LogBrewTrace.current()
            .map(parent -> LogBrewTraceContext.create(
                parent.traceId(),
                generated.spanId(),
                parent.spanId(),
                parent.traceFlags()
            ))
            .orElse(generated);
    }

    private static String normalizedHost(URI uri) {
        String host = uri.getHost();
        if (host == null) {
            host = hostFromAuthority(uri.getRawAuthority());
        }
        if (host == null || host.trim().isEmpty()) {
            return null;
        }
        String normalized = host.trim();
        if (normalized.startsWith("[") && normalized.endsWith("]")) {
            normalized = normalized.substring(1, normalized.length() - 1);
        }
        if (normalized.indexOf(':') >= 0) {
            return normalized.toLowerCase(Locale.ROOT);
        }
        return IDN.toASCII(normalized).toLowerCase(Locale.ROOT);
    }

    private static String hostFromAuthority(String authority) {
        if (authority == null || authority.isEmpty()) {
            return null;
        }
        String value = authority;
        int userInfoSeparator = value.lastIndexOf('@');
        if (userInfoSeparator >= 0) {
            value = value.substring(userInfoSeparator + 1);
        }
        if (value.startsWith("[")) {
            int closingBracket = value.indexOf(']');
            return closingBracket > 0 ? value.substring(1, closingBracket) : null;
        }
        int firstColon = value.indexOf(':');
        int lastColon = value.lastIndexOf(':');
        return firstColon >= 0 && firstColon == lastColon ? value.substring(0, firstColon) : value;
    }

    private static String errorType(Throwable error) {
        String simpleName = error.getClass().getSimpleName();
        return simpleName.isEmpty() ? "Throwable" : simpleName;
    }
}
