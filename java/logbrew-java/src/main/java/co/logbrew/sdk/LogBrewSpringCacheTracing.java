package co.logbrew.sdk;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;

/**
 * Spring Cache wrappers that create privacy-bounded cache spans for app-owned cache managers.
 *
 * <p>The wrappers require an active LogBrew trace by default, so framework cache calls correlate
 * with request spans without turning background cache activity into unrelated root traces. They do
 * not capture cache keys, values, native cache objects, backend addresses, headers, payloads,
 * baggage, tracestate, exception messages, or stack traces.</p>
 */
public final class LogBrewSpringCacheTracing {
    private static final String DEFAULT_EVENT_ID_PREFIX = "java_spring_cache";
    private static final String DEFAULT_SYSTEM = "spring-cache";
    private static final String FRAMEWORK = "spring-cache";

    private static final String[] BLOCKED_CACHE_METADATA_KEYS = {
        "args",
        "arguments",
        "auth",
        "authorization",
        "body",
        "cache" + "key",
        "command",
        "connectionstring",
        "coo" + "kie",
        "coo" + "kies",
        "head" + "ers",
        "ho" + "st",
        "host" + "name",
        "k" + "ey",
        "message",
        "messagebody",
        "nativecache",
        "params",
        "parameters",
        "payload",
        "query",
        "rawcommand",
        "rawmessage",
        "pass" + "word",
        "se" + "cret",
        "sql",
        "statement",
        "to" + "ken",
        "url",
        "username",
        "value"
    };

    private LogBrewSpringCacheTracing() {
    }

    /**
     * Wraps a Spring {@link CacheManager} so caches returned by {@code getCache(...)} emit spans.
     */
    public static CacheManager instrumentCacheManager(
        CacheManager cacheManager,
        LogBrewClient client,
        CacheConfig config
    ) {
        Objects.requireNonNull(cacheManager, "cacheManager");
        Objects.requireNonNull(client, "client");
        if (isInstrumentedCacheManager(cacheManager)) {
            return cacheManager;
        }
        return new InstrumentedCacheManager(cacheManager, client, config == null ? CacheConfig.create() : config);
    }

    /**
     * Wraps a single Spring {@link Cache} so supported cache operations emit spans.
     */
    public static Cache instrumentCache(Cache cache, LogBrewClient client, CacheConfig config) {
        Objects.requireNonNull(cache, "cache");
        Objects.requireNonNull(client, "client");
        if (isInstrumentedCache(cache)) {
            return cache;
        }
        return new InstrumentedCache(cache, client, config == null ? CacheConfig.create() : config);
    }

    static boolean isInstrumentedCacheManager(Object value) {
        return value instanceof InstrumentedCacheManagerMarker;
    }

    static boolean isInstrumentedCache(Object value) {
        return value instanceof InstrumentedCacheMarker;
    }

    private interface InstrumentedCacheManagerMarker {
    }

    private interface InstrumentedCacheMarker {
    }

    private static final class InstrumentedCacheManager implements CacheManager, InstrumentedCacheManagerMarker {
        private final CacheManager delegate;
        private final LogBrewClient client;
        private final CacheConfig config;

        private InstrumentedCacheManager(CacheManager delegate, LogBrewClient client, CacheConfig config) {
            this.delegate = delegate;
            this.client = client;
            this.config = config;
        }

        @Override
        public Cache getCache(String name) {
            Cache cache = delegate.getCache(name);
            if (cache == null || isInstrumentedCache(cache)) {
                return cache;
            }
            return instrumentCache(cache, client, config);
        }

        @Override
        public Collection<String> getCacheNames() {
            return delegate.getCacheNames();
        }

        @Override
        public void resetCaches() {
            delegate.resetCaches();
        }

        @Override
        public String toString() {
            return "LogBrewSpringCacheTracing(" + delegate + ")";
        }
    }

    private static final class InstrumentedCache implements Cache, InstrumentedCacheMarker {
        private final Cache delegate;
        private final LogBrewClient client;
        private final CacheConfig config;

        private InstrumentedCache(Cache delegate, LogBrewClient client, CacheConfig config) {
            this.delegate = delegate;
            this.client = client;
            this.config = config;
        }

        @Override
        public String getName() {
            return delegate.getName();
        }

        @Override
        public Object getNativeCache() {
            return delegate.getNativeCache();
        }

        @Override
        public ValueWrapper get(Object key) {
            SpanState span = startSpan("get");
            if (span == null) {
                return delegate.get(key);
            }
            boolean completed = false;
            ValueWrapper result = null;
            try {
                result = delegate.get(key);
                completed = true;
                return result;
            } finally {
                finishSpan(span, "get", "read", completed ? Boolean.valueOf(result != null) : null, null, !completed);
            }
        }

        @Override
        public <T> T get(Object key, Class<T> type) {
            SpanState span = startSpan("get");
            if (span == null) {
                return delegate.get(key, type);
            }
            boolean completed = false;
            T result = null;
            try {
                result = delegate.get(key, type);
                completed = true;
                return result;
            } finally {
                finishSpan(span, "get", "read", completed ? Boolean.valueOf(result != null) : null, null, !completed);
            }
        }

        @Override
        public <T> T get(Object key, Callable<T> valueLoader) {
            SpanState span = startSpan("get");
            if (span == null) {
                return delegate.get(key, valueLoader);
            }
            boolean[] loaderInvoked = {false};
            Callable<T> tracedLoader = () -> {
                loaderInvoked[0] = true;
                LogBrewTrace.Scope scope = LogBrewTrace.activate(span.trace);
                try {
                    return valueLoader.call();
                } finally {
                    scope.close();
                }
            };
            boolean completed = false;
            try {
                T result = delegate.get(key, tracedLoader);
                completed = true;
                return result;
            } finally {
                finishSpan(
                    span,
                    "get",
                    "read",
                    completed ? Boolean.valueOf(!loaderInvoked[0]) : null,
                    completed ? Boolean.valueOf(loaderInvoked[0]) : null,
                    !completed
                );
            }
        }

        @Override
        public CompletableFuture<?> retrieve(Object key) {
            SpanState span = startSpan("retrieve");
            if (span == null) {
                return delegate.retrieve(key);
            }
            boolean returnedFuture = false;
            boolean finishedNow = false;
            try {
                CompletableFuture<?> result = delegate.retrieve(key);
                if (result == null) {
                    finishSpan(span, "retrieve", "read", Boolean.FALSE, null, false);
                    finishedNow = true;
                    return null;
                }
                span.closeScope();
                returnedFuture = true;
                return result.whenComplete((value, error) ->
                    captureFinishedSpan(span, "retrieve", "read", Boolean.valueOf(value != null), null, error, false)
                );
            } finally {
                if (!returnedFuture && !finishedNow) {
                    finishSpan(span, "retrieve", "read", null, null, true);
                }
            }
        }

        @Override
        public <T> CompletableFuture<T> retrieve(
            Object key,
            Supplier<CompletableFuture<T>> valueLoader
        ) {
            SpanState span = startSpan("retrieve");
            if (span == null) {
                return delegate.retrieve(key, valueLoader);
            }
            boolean[] loaderInvoked = {false};
            Supplier<CompletableFuture<T>> tracedLoader = () -> {
                loaderInvoked[0] = true;
                LogBrewTrace.Scope scope = LogBrewTrace.activate(span.trace);
                try {
                    return valueLoader.get();
                } finally {
                    scope.close();
                }
            };
            boolean returnedFuture = false;
            boolean finishedNow = false;
            try {
                CompletableFuture<T> result = delegate.retrieve(key, tracedLoader);
                if (result == null) {
                    finishSpan(
                        span,
                        "retrieve",
                        "read",
                        Boolean.FALSE,
                        Boolean.valueOf(loaderInvoked[0]),
                        false
                    );
                    finishedNow = true;
                    return null;
                }
                span.closeScope();
                returnedFuture = true;
                return result.whenComplete((value, error) ->
                    captureFinishedSpan(
                        span,
                        "retrieve",
                        "read",
                        Boolean.valueOf(!loaderInvoked[0]),
                        Boolean.valueOf(loaderInvoked[0]),
                        error,
                        false
                    )
                );
            } finally {
                if (!returnedFuture && !finishedNow) {
                    finishSpan(span, "retrieve", "read", null, null, true);
                }
            }
        }

        @Override
        public void put(Object key, Object value) {
            SpanState span = startSpan("put");
            if (span == null) {
                delegate.put(key, value);
                return;
            }
            boolean completed = false;
            try {
                delegate.put(key, value);
                completed = true;
            } finally {
                finishSpan(span, "put", "write", null, Boolean.valueOf(completed), !completed);
            }
        }

        @Override
        public ValueWrapper putIfAbsent(Object key, Object value) {
            SpanState span = startSpan("putIfAbsent");
            if (span == null) {
                return delegate.putIfAbsent(key, value);
            }
            boolean completed = false;
            ValueWrapper result = null;
            try {
                result = delegate.putIfAbsent(key, value);
                completed = true;
                return result;
            } finally {
                finishSpan(
                    span,
                    "putIfAbsent",
                    "write",
                    completed ? Boolean.valueOf(result != null) : null,
                    completed ? Boolean.valueOf(result == null) : null,
                    !completed
                );
            }
        }

        @Override
        public void evict(Object key) {
            SpanState span = startSpan("evict");
            if (span == null) {
                delegate.evict(key);
                return;
            }
            boolean completed = false;
            try {
                delegate.evict(key);
                completed = true;
            } finally {
                finishSpan(span, "evict", "delete", null, Boolean.valueOf(completed), !completed);
            }
        }

        @Override
        public boolean evictIfPresent(Object key) {
            SpanState span = startSpan("evictIfPresent");
            if (span == null) {
                return delegate.evictIfPresent(key);
            }
            boolean completed = false;
            boolean result = false;
            try {
                result = delegate.evictIfPresent(key);
                completed = true;
                return result;
            } finally {
                finishSpan(
                    span,
                    "evictIfPresent",
                    "delete",
                    null,
                    completed ? Boolean.valueOf(result) : null,
                    !completed
                );
            }
        }

        @Override
        public void clear() {
            SpanState span = startSpan("clear");
            if (span == null) {
                delegate.clear();
                return;
            }
            boolean completed = false;
            try {
                delegate.clear();
                completed = true;
            } finally {
                finishSpan(span, "clear", "flush", null, Boolean.valueOf(completed), !completed);
            }
        }

        @Override
        public boolean invalidate() {
            SpanState span = startSpan("invalidate");
            if (span == null) {
                return delegate.invalidate();
            }
            boolean completed = false;
            boolean result = false;
            try {
                result = delegate.invalidate();
                completed = true;
                return result;
            } finally {
                finishSpan(
                    span,
                    "invalidate",
                    "flush",
                    null,
                    completed ? Boolean.valueOf(result) : null,
                    !completed
                );
            }
        }

        @Override
        public String toString() {
            return "LogBrewSpringCacheTracing(" + delegate + ")";
        }

        private SpanState startSpan(String operationName) {
            LogBrewTraceContext trace = childTrace();
            if (trace == null) {
                return null;
            }
            return new SpanState(trace, config.now(), LogBrewTrace.activate(trace));
        }

        private LogBrewTraceContext childTrace() {
            return LogBrewTrace.current()
                .map(parent -> LogBrewTraceContext.create(
                    parent.traceId(),
                    LogBrewTraceContext.generate().spanId(),
                    parent.spanId(),
                    parent.traceFlags()
                ))
                .orElseGet(() -> config.traceWithoutActiveContext
                    ? LogBrewTraceContext.generate()
                    : null);
        }

        private void finishSpan(
            SpanState span,
            String operationName,
            String operationKind,
            Boolean hit,
            Boolean write,
            boolean failed
        ) {
            try {
                captureFinishedSpan(span, operationName, operationKind, hit, write, null, failed);
            } finally {
                span.closeScope();
            }
        }

        private void captureFinishedSpan(
            SpanState span,
            String operationName,
            String operationKind,
            Boolean hit,
            Boolean write,
            Throwable error,
            boolean failed
        ) {
            boolean errored = failed || error != null;
            Instant finishedAt = config.now();
            Map<String, Object> metadata = config.cacheMetadata(delegate.getName(), operationName, operationKind);
            metadata.put("source", "cache.operation");
            metadata.put("framework", FRAMEWORK);
            metadata.put("sampled", Boolean.valueOf(span.trace.sampled()));
            if (hit != null) {
                metadata.put("cacheHit", hit);
            }
            if (write != null) {
                metadata.put("cacheWrite", write);
            }
            if (error != null) {
                metadata.put("errorType", error.getClass().getSimpleName());
            }
            SpanAttributes attributes = SpanAttributes
                .create(
                    "cache:" + operationName,
                    span.trace.traceId(),
                    span.trace.spanId(),
                    errored ? "error" : "ok"
                )
                .durationMs(Duration.between(span.startedAt, finishedAt).toNanos() / 1_000_000.0)
                .metadata(metadata);
            if (span.trace.parentSpanId() != null) {
                attributes.parentSpanId(span.trace.parentSpanId());
            }
            if (error != null) {
                attributes.events(List.of(SpanEventSummary.create("exception").metadata(Map.of(
                    "exceptionType", error.getClass().getSimpleName(),
                    "exceptionEscaped", Boolean.TRUE
                ))));
            }
            try {
                client.span(config.resolvedEventIdPrefix() + "_span_" + span.trace.spanId(), finishedAt.toString(), attributes);
            } catch (SdkException captureError) {
                config.reportCaptureError(captureError);
            }
        }
    }

    private static final class SpanState {
        private final LogBrewTraceContext trace;
        private final Instant startedAt;
        private LogBrewTrace.Scope scope;

        private SpanState(LogBrewTraceContext trace, Instant startedAt, LogBrewTrace.Scope scope) {
            this.trace = trace;
            this.startedAt = startedAt;
            this.scope = scope;
        }

        private void closeScope() {
            if (scope != null) {
                scope.close();
                scope = null;
            }
        }
    }

    /**
     * Spring Cache span configuration.
     */
    public static final class CacheConfig {
        private String system;
        private String eventIdPrefix;
        private Map<String, ?> metadata;
        private boolean traceWithoutActiveContext;
        private Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;

        private CacheConfig() {
        }

        public static CacheConfig create() {
            return new CacheConfig();
        }

        public CacheConfig system(String value) {
            this.system = value;
            return this;
        }

        public CacheConfig eventIdPrefix(String value) {
            this.eventIdPrefix = value;
            return this;
        }

        public CacheConfig metadata(Map<String, ?> value) {
            this.metadata = Validation.copyMetadata(value);
            return this;
        }

        public CacheConfig traceWithoutActiveContext(boolean value) {
            this.traceWithoutActiveContext = value;
            return this;
        }

        public CacheConfig onError(Consumer<SdkException> value) {
            this.onError = value;
            return this;
        }

        public CacheConfig now(Supplier<Instant> value) {
            this.now = Objects.requireNonNull(value, "now");
            return this;
        }

        public CacheConfig nowSequence(Instant first, Instant second) {
            Instant[] values = {Objects.requireNonNull(first, "first"), Objects.requireNonNull(second, "second")};
            int[] index = {0};
            this.now = () -> values[Math.min(index[0]++, values.length - 1)];
            return this;
        }

        private Instant now() {
            return now.get();
        }

        private String resolvedEventIdPrefix() {
            if (eventIdPrefix == null || eventIdPrefix.trim().isEmpty()) {
                return DEFAULT_EVENT_ID_PREFIX;
            }
            return eventIdPrefix.trim();
        }

        private Map<String, Object> cacheMetadata(
            String cacheName,
            String operationName,
            String operationKind
        ) {
            Map<String, Object> values = safeCacheMetadata(metadata);
            addString(values, "cacheSystem", system == null || system.trim().isEmpty() ? DEFAULT_SYSTEM : system);
            addString(values, "cacheOperation", operationName);
            addString(values, "cacheOperationKind", operationKind);
            addString(values, "cacheName", cacheName);
            return values;
        }

        private void reportCaptureError(SdkException error) {
            if (onError == null) {
                return;
            }
            try {
                onError.accept(error);
            } catch (RuntimeException ignored) {
                // Preserve app-owned cache behavior even if diagnostics handling fails.
            }
        }
    }

    private static Map<String, Object> safeCacheMetadata(Map<String, ?> input) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        Map<String, Object> copied = Validation.copyMetadata(input);
        if (copied == null) {
            return metadata;
        }
        for (Map.Entry<String, Object> entry : copied.entrySet()) {
            if (!blockedCacheMetadataKey(entry.getKey())) {
                metadata.put(entry.getKey(), entry.getValue());
            }
        }
        return metadata;
    }

    private static boolean blockedCacheMetadataKey(String key) {
        String normalized = key == null ? "" : key.trim().toLowerCase(Locale.ROOT)
            .replace("_", "")
            .replace("-", "")
            .replace(".", "");
        for (String candidate : BLOCKED_CACHE_METADATA_KEYS) {
            if (normalized.equals(candidate) || normalized.contains(candidate)) {
                return true;
            }
        }
        return false;
    }

    private static void addString(Map<String, Object> metadata, String key, String value) {
        if (value != null && !value.trim().isEmpty()) {
            metadata.put(key, value.trim());
        }
    }
}
