# Java Spring Cache Tracing Comparison - 2026-06-30

## Scope

Reduce the Java/Spring rich-trace gap for teams debugging cache-dependent request paths. Before this pass, LogBrew Java had explicit generic cache operation spans and Spring Boot JDBC auto-configuration, but Spring Cache users still had to wrap cache calls manually. The target is request-correlated Spring Cache spans from app-owned `CacheManager` or `Cache` objects without a Java agent, global cache patching, cache-key capture, or backend/cache-host metadata capture.

## Competitor Sources Read

- Sentry Java `getsentry/sentry-java@012eaebafc1507c0a4767236b7acc5c26fca1988`
- `sentry-spring-7/src/main/java/io/sentry/spring7/cache/SentryCacheBeanPostProcessor.java`: Spring `BeanPostProcessor` wrapping of cache manager beans.
- `sentry-spring-7/src/main/java/io/sentry/spring7/cache/SentryCacheManagerWrapper.java`: delegated `getCache(...)` wrapping and `getCacheNames(...)` pass-through.
- `sentry-spring-7/src/main/java/io/sentry/spring7/cache/SentryCacheWrapper.java`: traced `get`, typed `get`, loader `get`, async `retrieve`, `put`, `putIfAbsent`, `evict`, `evictIfPresent`, `clear`, and `invalidate` behavior, hit/write/error metadata, active-span requirement, and option gating.
- `sentry-spring-7/src/test/kotlin/io/sentry/spring7/cache/SentryCacheWrapperTest.kt` and `SentryCacheBeanPostProcessorTest.kt`: wrapper assertions, span data assertions, disabled-option behavior, and bean post-processor coverage.
- Datadog Java `DataDog/dd-trace-java@750f363785b6756be2c4ae33ac4f6d8f555ec4a0`
- Tree search found concrete cache/client instrumentation rather than a generic Spring Cache `CacheManager` wrapper.
- `dd-java-agent/instrumentation/caffeine-1.0/src/main/java/datadog/trace/instrumentation/caffeine/BoundedLocalCacheInstrumentation.java`: ByteBuddy matching around Caffeine cache internals.
- `dd-java-agent/instrumentation/caffeine-1.0/src/main/java/datadog/trace/instrumentation/caffeine/BoundedLocalCacheAdvice.java`: context suppression around internal cache compute paths.
- `internal-api/src/main/java/datadog/trace/api/naming/v1/CacheNamingV1.java`: cache operation naming pattern.
- OpenTelemetry Java Instrumentation `open-telemetry/opentelemetry-java-instrumentation@27aad94670ac3de1948a82f150fa0ca76edecf89`
- Tree search found concrete cache/client instrumentations rather than a generic Spring Cache `CacheManager` wrapper.
- `instrumentation/spymemcached-2.12/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/spymemcached/v2_12/MemcachedClientInstrumentation.java`: javaagent method advice and async operation wrapping.
- `instrumentation/spymemcached-2.12/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/spymemcached/v2_12/SpymemcachedRequest.java`: request modeling for cache commands.
- `instrumentation/spymemcached-2.12/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/spymemcached/v2_12/SpymemcachedAttributesGetter.java`: cache attributes without payload capture.
- PostHog Java `PostHog/posthog-java@dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e`
- Searched the source tree for `cache`, `spring`, `trace`, and `span`; no comparable Spring Cache tracing implementation was found. Read `src/main/java/com/posthog/java/PostHog.java`, `QueueManager.java`, `HttpSender.java`, and `Sender.java` to confirm the SDK focus is event capture, queueing, and transport rather than dependency tracing.

## Pattern Observed

- Sentry is the closest pattern for Spring Cache: wrap Spring `CacheManager` beans, return wrapped `Cache` instances from `getCache(...)`, require an active span by default, trace common sync and async cache methods, and preserve normal cache behavior.
- Sentry records useful hit/write/error data and supports async completion spans, but its source includes cache-key-oriented span data. That is useful for debugging but a privacy/cardinality risk for LogBrew's public SDK defaults.
- Datadog and OpenTelemetry are stronger for broad automatic cache/client coverage through Java-agent instrumentation and concrete cache backends such as Caffeine or memcached. The tradeoff is heavier runtime coupling and less app-visible control over what gets patched.
- PostHog Java did not provide a comparable tracing/cache pattern in the inspected source.

## LogBrew Design

- Added `LogBrewSpringCacheTracing.instrumentCacheManager(...)` and `instrumentCache(...)`.
- Apps pass an app-owned Spring `CacheManager` or `Cache` plus an existing `LogBrewClient`; LogBrew returns a wrapper for that object only.
- The cache manager wrapper delegates `getCacheNames()` and wraps caches returned by `getCache(...)` unless they are already instrumented.
- The cache wrapper traces `get`, typed `get`, loader `get`, async `retrieve`, async loader `retrieve`, `put`, `putIfAbsent`, `evict`, `evictIfPresent`, `clear`, and `invalidate`.
- Spans are child spans of the active `LogBrewTrace` by default. `traceWithoutActiveContext(true)` is available only for apps that intentionally want standalone cache spans.
- Async spans finish when returned futures complete. Null async futures are preserved and recorded as safe cache misses instead of creating SDK-introduced errors.
- Sync runtime errors propagate unchanged and still mark the cache span as failed; async completion failures also add type-only exception summaries.
- Added `LogBrewSpringBootCacheAutoConfiguration` and `LogBrewSpringBootCacheManagerPostProcessor` so Spring Boot apps that already expose an app-owned `LogBrewClient` and `CacheManager` get initialized cache managers wrapped automatically.
- Spring properties can set `logbrew.cache.enabled`, `logbrew.cache.system`, `logbrew.cache.event-id-prefix`, and `logbrew.cache.trace-without-active-context`.

## Privacy and Runtime Boundary

LogBrew records only bounded operation metadata: `source=cache.operation`, `framework=spring-cache`, cache system, operation, operation kind, cache name, hit/write booleans, sampled state, duration, and failure status; asynchronous completion failures also include type-only exception events. It intentionally avoids Java agents, global cache/client patching, property-created ingest clients, cache keys, values, native cache objects, backend hosts, full URLs, payloads, headers, cookies, command text, arbitrary parameters, baggage, tracestate, exception messages, stack traces, and Spring bean names.

## Where LogBrew Is Better Today

- Safer default privacy than Sentry's key-oriented cache span data: LogBrew keeps keys and values out of telemetry and tests that boundary through unit and installed Spring Boot smokes.
- Lighter than Datadog and OpenTelemetry for teams that want Spring Cache spans without a Java agent or backend-specific instrumentation package.
- More explicit than hidden agent patching: apps can manually wrap one cache manager/cache or let Spring Boot auto-configuration wrap app-owned cache managers only when an app-owned `LogBrewClient` bean exists.
- Better local release confidence for this exact public behavior: packaged jar checks and a temporary Spring Boot app prove request, log, JDBC, cache, and metric correlation in one flushed batch.

## Where LogBrew Is Still Worse

- No hidden automatic Java-agent coverage for concrete cache backends such as Caffeine, Redis, Hazelcast, Ehcache, JCache, or memcached.
- No cache backend/server metadata, cache metrics, cache command semantic-convention depth, span links, baggage, tracestate, or full OpenTelemetry exporter/processor interop.
- No framework-owned Redis/cache-client auto-integration packages yet; users must use Spring Cache wrapping or explicit dependency-span helpers.
- No low-cardinality grouping beyond operation/cache-name metadata yet; Sentry/Datadog/OTel have deeper ecosystem-specific grouping and product-side views.

## Verification

- RED: `bash scripts/check_java_package.sh` failed after adding Spring Cache tests because `LogBrewSpringCacheTracing` and `LogBrewSpringBootCacheManagerPostProcessor` did not exist.
- RED: `bash scripts/check_java_package.sh` failed after adding the null async-loader future regression because the wrapper called `whenComplete(...)` on a null future.
- RED: `bash scripts/check_java_package.sh` covered sync runtime-error preservation and error-span status before the final static-analysis refactor.
- GREEN: `bash scripts/check_java_package.sh` passed with 32 core Java tests, 6 trace tests, 2 servlet tests, 2 span-event tests, 3 OpenTelemetry tests, 4 operation-tracing tests, 10 JDBC-tracing tests, 7 Spring Cache tests, 3 Spring Boot JDBC auto-configuration tests, 2 support-ticket draft tests, Maven metadata, javadocs, source jar, binary jar, README checks, and packaged examples.
- Installed-artifact proof: `bash scripts/real_user_java_smoke.sh` passed after packing the jar and verifying the new Spring Cache classes in the binary/source artifacts and packaged README.
- Spring Boot installed-artifact proof: `bash scripts/real_user_spring_boot_smoke.sh` builds a temporary Spring Boot 4.0.6 app against the locally packed jar, exposes app-owned `LogBrewClient`, `DataSource`, and `CacheManager` beans, sends one request through the real servlet stack, and verifies log/request/JDBC/cache spans plus a request metric in one flushed batch without raw request path, query string, propagation header, SQL text, JDBC login values, cache key, cache value, Spring bean name, or stack-text leakage.

## Remaining Priority

The highest-impact Java trace follow-up is broader automatic framework/dependency depth where it remains safe: Spring messaging/outbound HTTP, Redis/Caffeine/JCache-specific helpers, OpenTelemetry semantic-convention/exporter interoperability, and richer low-noise grouping. Each should stay source-backed against Sentry first, then Datadog, OpenTelemetry, PostHog, and framework-native patterns, with installed-artifact proof before any public availability claim.
