package co.logbrew.sdk;

import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

/**
 * Dependency-free test runner for Spring Cache tracing.
 */
public final class LogBrewSpringCacheTracingTest {
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewSpringCacheTracingTest().run();
    }

    private void run() throws Exception {
        testCacheManagerWrapperCapturesCacheHitWriteAndPrivacy();
        testCacheWrapperCapturesAsyncCompletionErrorsTypeOnly();
        testCacheWrapperHandlesNullAsyncLoaderFuture();
        testCacheWrapperPreservesSyncRuntimeErrorAndRecordsErrorStatus();
        testCacheWrapperDoesNotTraceWithoutActiveContextByDefault();
        testSpringBootCachePostProcessorWrapsCacheManagerBeans();
        testSpringBootCachePostProcessorCanBeDisabled();
        System.out.println("java spring cache tracing tests ok (" + testsRun + " tests)");
    }

    private void testCacheManagerWrapperCapturesCacheHitWriteAndPrivacy() {
        LogBrewClient client = sampleClient();
        FakeCacheManager delegate = new FakeCacheManager(new FakeCache("checkout-cache"));
        CacheManager manager = LogBrewSpringCacheTracing.instrumentCacheManager(
            delegate,
            client,
            LogBrewSpringCacheTracing.CacheConfig.create()
                .system("caffeine")
                .eventIdPrefix("spring_cache")
                .metadata(Map.of(
                    "service", "checkout",
                    "cacheKey", "cart:private",
                    "value", "fixture-value"
                ))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:00Z"),
                    Instant.parse("2026-06-02T10:00:00.011Z")
                )
        );
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "a7ad6b7169203330"
        );

        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            Cache cache = manager.getCache("checkout-cache");
            cache.put("cart:private", "fixture-value");
            Cache.ValueWrapper hit = cache.get("cart:private");
            boolean evicted = cache.evictIfPresent("cart:private");

            assertEquals("fixture-value", hit.get(), "cache hit value is preserved");
            assertTrue(evicted, "evict result is preserved");
            assertEquals(3, client.pendingEvents(), "three cache spans queued");
        } finally {
            scope.close();
        }

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_cache_span_");
        assertContains(payload, "\"traceId\": \"" + parent.traceId() + "\"");
        assertContains(payload, "\"parentSpanId\": \"" + parent.spanId() + "\"");
        assertContains(payload, "\"name\": \"cache:put\"");
        assertContains(payload, "\"name\": \"cache:get\"");
        assertContains(payload, "\"name\": \"cache:evictIfPresent\"");
        assertContains(payload, "\"source\": \"cache.operation\"");
        assertContains(payload, "\"framework\": \"spring-cache\"");
        assertContains(payload, "\"cacheSystem\": \"caffeine\"");
        assertContains(payload, "\"cacheName\": \"checkout-cache\"");
        assertContains(payload, "\"cacheOperationKind\": \"read\"");
        assertContains(payload, "\"cacheOperationKind\": \"write\"");
        assertContains(payload, "\"cacheOperationKind\": \"delete\"");
        assertContains(payload, "\"cacheHit\": true");
        assertContains(payload, "\"cacheWrite\": true");
        assertContains(payload, "\"service\": \"checkout\"");
        assertNotContains(payload, "cart:private");
        assertNotContains(payload, "fixture-value");
        testsRun++;
    }

    private void testCacheWrapperCapturesAsyncCompletionErrorsTypeOnly() {
        LogBrewClient client = sampleClient();
        FakeCache cacheDelegate = new FakeCache("async-cache");
        Cache cache = LogBrewSpringCacheTracing.instrumentCache(
            cacheDelegate,
            client,
            LogBrewSpringCacheTracing.CacheConfig.create()
                .eventIdPrefix("spring_cache_async")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:00Z"),
                    Instant.parse("2026-06-02T10:00:00.019Z")
                )
        );
        CompletableFuture<String> future = new CompletableFuture<>();
        cacheDelegate.retrieveFuture = future;
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "a7ad6b7169203330"
        );

        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        CompletableFuture<?> traced;
        try {
            traced = cache.retrieve("async-private-key");
        } finally {
            scope.close();
        }

        IllegalStateException original = new IllegalStateException("async failure detail");
        future.completeExceptionally(original);
        expectException(Exception.class, () -> traced.get());

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_cache_async_span_");
        assertContains(payload, "\"name\": \"cache:retrieve\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"errorType\": \"IllegalStateException\"");
        assertContains(payload, "\"exceptionType\": \"IllegalStateException\"");
        assertContains(payload, "\"exceptionEscaped\": true");
        assertNotContains(payload, "async-private-key");
        assertNotContains(payload, "async failure detail");
        testsRun++;
    }

    private void testCacheWrapperHandlesNullAsyncLoaderFuture() {
        LogBrewClient client = sampleClient();
        Cache cache = LogBrewSpringCacheTracing.instrumentCache(
            new FakeCache("async-cache"),
            client,
            LogBrewSpringCacheTracing.CacheConfig.create()
                .eventIdPrefix("spring_cache_async_null")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:00Z"),
                    Instant.parse("2026-06-02T10:00:00.007Z")
                )
        );
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "a7ad6b7169203330"
        );

        CompletableFuture<String> traced;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            traced = cache.retrieve("async-null-private-key", () -> null);
        } finally {
            scope.close();
        }

        assertTrue(traced == null, "null async loader future is preserved");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_cache_async_null_span_");
        assertContains(payload, "\"name\": \"cache:retrieve\"");
        assertContains(payload, "\"status\": \"ok\"");
        assertContains(payload, "\"cacheHit\": false");
        assertNotContains(payload, "async-null-private-key");
        testsRun++;
    }

    private void testCacheWrapperPreservesSyncRuntimeErrorAndRecordsErrorStatus() {
        LogBrewClient client = sampleClient();
        FakeCache cacheDelegate = new FakeCache("error-cache");
        IllegalStateException original = new IllegalStateException("sync failure detail");
        cacheDelegate.getFailure = original;
        Cache cache = LogBrewSpringCacheTracing.instrumentCache(
            cacheDelegate,
            client,
            LogBrewSpringCacheTracing.CacheConfig.create()
                .eventIdPrefix("spring_cache_sync_error")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:00Z"),
                    Instant.parse("2026-06-02T10:00:00.005Z")
                )
        );
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "a7ad6b7169203330"
        );

        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        IllegalStateException thrown;
        try {
            thrown = expectException(IllegalStateException.class, () -> cache.get("sync-private-key"));
        } finally {
            scope.close();
        }

        assertTrue(thrown == original, "sync cache exception is preserved");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_cache_sync_error_span_");
        assertContains(payload, "\"name\": \"cache:get\"");
        assertContains(payload, "\"status\": \"error\"");
        assertNotContains(payload, "sync-private-key");
        assertNotContains(payload, "sync failure detail");
        testsRun++;
    }

    private void testCacheWrapperDoesNotTraceWithoutActiveContextByDefault() {
        LogBrewClient client = sampleClient();
        Cache cache = LogBrewSpringCacheTracing.instrumentCache(
            new FakeCache("checkout-cache"),
            client,
            LogBrewSpringCacheTracing.CacheConfig.create()
        );

        cache.put("cart:private", "fixture-value");

        assertEquals(0, client.pendingEvents(), "default wrapper requires active context");
        testsRun++;
    }

    private void testSpringBootCachePostProcessorWrapsCacheManagerBeans() {
        LogBrewClient client = sampleClient();
        FakeCacheManager original = new FakeCacheManager(new FakeCache("orders-cache"));
        BeanPostProcessor processor = new LogBrewSpringBootCacheManagerPostProcessor(
            client,
            environment(Map.of(
                "spring.application.name", "checkout-service",
                "logbrew.cache.system", "spring-cache",
                "logbrew.cache.event-id-prefix", "boot_cache"
            ))
        );

        Object processed = processor.postProcessAfterInitialization(original, "ordersCacheManager");

        assertTrue(processed instanceof CacheManager, "processed cache manager type");
        assertTrue(processed != original, "cache manager is wrapped");
        assertTrue(
            LogBrewSpringCacheTracing.isInstrumentedCacheManager(processed),
            "marker identifies wrapped cache manager"
        );
        LogBrewTrace.Scope scope = LogBrewTrace.activate(LogBrewTraceContext.fromTraceparent(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "a7ad6b7169203330"
        ));
        try {
            ((CacheManager) processed).getCache("orders-cache").get("order:private");
        } finally {
            scope.close();
        }

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"boot_cache_span_");
        assertContains(payload, "\"springApplicationName\": \"checkout-service\"");
        assertContains(payload, "\"cacheName\": \"orders-cache\"");
        assertContains(payload, "\"cacheHit\": false");
        assertNotContains(payload, "ordersCacheManager");
        assertNotContains(payload, "order:private");
        testsRun++;
    }

    private void testSpringBootCachePostProcessorCanBeDisabled() {
        LogBrewClient client = sampleClient();
        FakeCacheManager original = new FakeCacheManager(new FakeCache("orders-cache"));
        BeanPostProcessor processor = new LogBrewSpringBootCacheManagerPostProcessor(
            client,
            environment(Map.of("logbrew.cache.enabled", "false"))
        );

        Object processed = processor.postProcessAfterInitialization(original, "ordersCacheManager");

        assertTrue(processed == original, "disabled Spring cache wrapper preserves original bean");
        testsRun++;
    }

    private static StandardEnvironment environment(Map<String, Object> values) {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", values));
        return environment;
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static void assertContains(String text, String expected) {
        if (!text.contains(expected)) {
            throw new AssertionError("expected to contain " + expected + " in " + text);
        }
    }

    private static void assertNotContains(String text, String unexpected) {
        if (text.contains(unexpected)) {
            throw new AssertionError("expected not to contain " + unexpected + " in " + text);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }

    private static <T extends Throwable> T expectException(Class<T> type, ThrowingRunnable runnable) {
        try {
            runnable.run();
        } catch (Throwable error) {
            if (type.isInstance(error)) {
                return type.cast(error);
            }
            throw new AssertionError("expected " + type.getSimpleName() + " but got " + error, error);
        }
        throw new AssertionError("expected " + type.getSimpleName());
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static final class FakeCacheManager implements CacheManager {
        private final Cache cache;

        private FakeCacheManager(Cache cache) {
            this.cache = cache;
        }

        @Override
        public Cache getCache(String name) {
            return cache.getName().equals(name) ? cache : null;
        }

        @Override
        public Collection<String> getCacheNames() {
            return List.of(cache.getName());
        }
    }

    private static final class FakeCache implements Cache {
        private final String name;
        private final Map<Object, Object> values = new LinkedHashMap<>();
        private CompletableFuture<?> retrieveFuture;
        private RuntimeException getFailure;

        private FakeCache(String name) {
            this.name = name;
        }

        @Override
        public String getName() {
            return name;
        }

        @Override
        public Object getNativeCache() {
            return values;
        }

        @Override
        public ValueWrapper get(Object key) {
            if (getFailure != null) {
                throw getFailure;
            }
            Object value = values.get(key);
            return value == null ? null : () -> value;
        }

        @Override
        public <T> T get(Object key, Class<T> type) {
            Object value = values.get(key);
            return value == null ? null : type.cast(value);
        }

        @Override
        public <T> T get(Object key, Callable<T> valueLoader) {
            Object value = values.get(key);
            if (value != null) {
                @SuppressWarnings("unchecked")
                T typed = (T) value;
                return typed;
            }
            try {
                T loaded = valueLoader.call();
                values.put(key, loaded);
                return loaded;
            } catch (Exception error) {
                throw new ValueRetrievalException(key, valueLoader, error);
            }
        }

        @Override
        public CompletableFuture<?> retrieve(Object key) {
            return retrieveFuture;
        }

        @Override
        public <T> CompletableFuture<T> retrieve(
            Object key,
            Supplier<CompletableFuture<T>> valueLoader
        ) {
            return valueLoader.get();
        }

        @Override
        public void put(Object key, Object value) {
            values.put(key, value);
        }

        @Override
        public ValueWrapper putIfAbsent(Object key, Object value) {
            Object existing = values.putIfAbsent(key, value);
            return existing == null ? null : () -> existing;
        }

        @Override
        public void evict(Object key) {
            values.remove(key);
        }

        @Override
        public boolean evictIfPresent(Object key) {
            return values.remove(key) != null;
        }

        @Override
        public void clear() {
            values.clear();
        }

        @Override
        public boolean invalidate() {
            boolean hadValues = !values.isEmpty();
            values.clear();
            return hadValues;
        }
    }
}
