package co.logbrew.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.Callable;

/**
 * Request-local active trace helpers for Java services.
 *
 * <p>The active trace is stored in a thread-local scope. Apps that hop threads
 * can wrap tasks explicitly instead of relying on global instrumentation.</p>
 */
public final class LogBrewTrace {
    private static final ThreadLocal<LogBrewTraceContext> CURRENT = new ThreadLocal<>();

    private LogBrewTrace() {
    }

    /**
     * Returns the active LogBrew trace for the current thread, if one exists.
     */
    public static Optional<LogBrewTraceContext> current() {
        return Optional.ofNullable(CURRENT.get());
    }

    /**
     * Makes a trace context active until the returned scope is closed.
     */
    public static Scope activate(LogBrewTraceContext context) {
        return new Scope(Objects.requireNonNull(context, "context"));
    }

    /**
     * Returns active trace metadata merged with app metadata.
     */
    public static Map<String, Object> metadataWithCurrentTrace(Map<String, ?> metadata) {
        return metadataWithTrace(CURRENT.get(), metadata);
    }

    /**
     * Returns trace metadata merged with app metadata.
     */
    public static Map<String, Object> metadataWithTrace(LogBrewTraceContext context, Map<String, ?> metadata) {
        Map<String, Object> values = new LinkedHashMap<>();
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        if (copiedMetadata != null) {
            values.putAll(copiedMetadata);
        }
        if (context != null) {
            values.putAll(context.metadata());
        }
        return Collections.unmodifiableMap(values);
    }

    /**
     * Wraps a runnable with the current trace so explicit async handoffs keep correlation.
     */
    public static Runnable wrapCurrent(Runnable runnable) {
        Objects.requireNonNull(runnable, "runnable");
        LogBrewTraceContext captured = CURRENT.get();
        return () -> {
            Scope scope = captured == null ? Scope.clear() : activate(captured);
            try {
                runnable.run();
            } finally {
                scope.close();
            }
        };
    }

    /**
     * Wraps a callable with the current trace so explicit async handoffs keep correlation.
     */
    public static <T> Callable<T> wrapCurrent(Callable<T> callable) {
        Objects.requireNonNull(callable, "callable");
        LogBrewTraceContext captured = CURRENT.get();
        return () -> {
            Scope scope = captured == null ? Scope.clear() : activate(captured);
            try {
                return callable.call();
            } finally {
                scope.close();
            }
        };
    }

    /**
     * Auto-closeable active trace scope.
     */
    public static final class Scope implements AutoCloseable {
        private final LogBrewTraceContext previous;
        private boolean closed;

        private Scope(LogBrewTraceContext context) {
            this.previous = CURRENT.get();
            CURRENT.set(context);
        }

        private Scope() {
            this.previous = CURRENT.get();
            CURRENT.remove();
        }

        private static Scope clear() {
            return new Scope();
        }

        @Override
        public void close() {
            if (closed) {
                return;
            }
            if (previous == null) {
                CURRENT.remove();
            } else {
                CURRENT.set(previous);
            }
            closed = true;
        }
    }
}
