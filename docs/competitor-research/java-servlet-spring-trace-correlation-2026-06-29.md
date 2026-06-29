# Java Servlet and Spring Request Tracing - 2026-06-29

## Goal

Improve Java rich tracing where LogBrew was weaker than Sentry, Datadog, and OpenTelemetry: Spring and Jakarta Servlet apps should get request spans, duration metrics, and correlated logs from a real installed SDK package without a Java agent, bytecode weaving, or hidden framework patching.

## Sources Read

- Sentry Java SDK: `https://github.com/getsentry/sentry-java.git` at `d8b6ce11cabd05be9a3f03a1d20fe247956d091d`.
- Sentry files/functions: `sentry-spring-jakarta/src/main/java/io/sentry/spring/jakarta/tracing/SentryTracingFilter.java` (`doFilterInternal`, `doFilterWithTransaction`, `startTransaction`), `sentry-spring-jakarta/src/main/java/io/sentry/spring/jakarta/tracing/SpringMvcTransactionNameProvider.java` (`provideTransactionName`), `sentry-spring-jakarta/src/main/java/io/sentry/spring/jakarta/tracing/SpringServletTransactionNameProvider.java` (`provideTransactionName`), and `sentry-spring-boot-4/src/main/java/io/sentry/spring/boot4/SentryAutoConfiguration.java` filter registration.
- OpenTelemetry Java Instrumentation: `https://github.com/open-telemetry/opentelemetry-java-instrumentation.git` at `b0a6cdb02533b3d2278b1dfb22bb6c228ec24b3b`.
- OpenTelemetry files/functions: `instrumentation/servlet/servlet-5.0/library/src/main/java/io/opentelemetry/instrumentation/servlet/v5_0/internal/Servlet5TelemetryFilter.java` (`doFilter`), `instrumentation/servlet/servlet-common/library/src/main/java/io/opentelemetry/instrumentation/servlet/common/internal/ServletHttpAttributesGetter.java` (`getHttpResponseStatusCode`), `instrumentation-api/src/main/java/io/opentelemetry/instrumentation/api/semconv/http/HttpSpanNameExtractor.java` (`extract`), `instrumentation/spring/spring-webmvc/spring-webmvc-6.0/library/src/main/java/io/opentelemetry/instrumentation/spring/webmvc/v6_0/WebMvcTelemetryProducingFilter.java` (`doFilter`), `HttpRouteSupport.java` (`route`), `SpringWebMvcServerSpanNaming.java`, and `OpenTelemetryHandlerMappingFilter.java`.
- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at `ffb48aeb95a05df3d20c27afe3a7b1c5d0ba59c4`.
- Datadog files/functions: `dd-java-agent/instrumentation/servlet/javax-servlet/javax-servlet-3.0/src/main/java/datadog/trace/instrumentation/servlet3/Servlet3Advice.java` (`startSpan`, `stopSpan` advice paths), `Servlet3Decorator.java`, `HttpServletExtractAdapter.java`, `dd-java-agent/instrumentation/spring/spring-webmvc/spring-webmvc-6.0/src/main/java17/datadog/trace/instrumentation/springweb6/HandlerMappingResourceNameFilter.java` (`doFilterInternal`), `HandleMatchAdvice.java`, and `SpringWebHttpServerDecorator.java`.

## Competitor Pattern

- Sentry starts a transaction in a servlet/Spring filter, binds it to request scope while the handler runs, then updates the transaction name from Spring's best matching route template after route resolution.
- OpenTelemetry keeps trace context current through the servlet chain and uses Spring route attributes to rename the span to `METHOD /route/{template}` after handler mapping resolves. It also handles async servlet completion and route-source side effects carefully.
- Datadog uses agent instrumentation to start/extract servlet spans, attach trace/span IDs to request attributes, record status/error behavior, and rename resources from Spring MVC route templates.

## LogBrew Implementation

- Added `LogBrewServletFilter`, an app-owned Jakarta Servlet `Filter` with no Spring dependency and no Java agent.
- The filter reads only W3C `traceparent`, activates a `LogBrewTraceContext` during the downstream filter chain, then records one request span and one `http.server.duration` metric.
- Added `LogBrewSpringBootAutoConfiguration`, which registers that filter only when Spring Boot, Jakarta Servlet, and an application-provided `LogBrewClient` bean are present.
- Route naming prefers an app-owned `co.logbrew.routeTemplate` request attribute, then Spring MVC's `org.springframework.web.servlet.HandlerMapping.bestMatchingPattern`, then lower-quality servlet/request fallbacks.
- The filter rethrows the original app exception, closes active trace scope, and swallows telemetry finish failures so logging/telemetry cannot change request behavior.
- The public README now shows the lower-friction Spring Boot bean setup first, then the manual `FilterRegistrationBean` path for non-Boot or custom servlet apps. The auto-configuration backs off when the app provides a `LogBrewServletFilter` bean or the named registration bean, and the README states the privacy boundary plus the `logbrew.servlet.enabled`, `logbrew.servlet.event-id-prefix`, and `logbrew.servlet.order` controls.

## Tradeoffs

- Better for explicit production safety: no hidden bytecode weaving, no global HTTP patching, no client creation from properties, no body/header/cookie/query/full-URL capture, no baggage/tracestate capture, and no exporter/processor ownership.
- Better for first useful installed-package proof: the Spring Boot smoke packs the local Maven artifact, installs it into a temporary app, sends a real HTTP request, verifies correlated Logback logs, request span, duration metric, W3C parent span, route template, retry-safe flushing, and privacy omissions.
- Still more conservative than Sentry, Datadog, and OpenTelemetry: LogBrew now auto-registers inside Spring Boot when an app-owned client bean exists, but it does not provide a dedicated starter that creates clients from properties, async servlet completion tracking, `javax.servlet` compatibility, automatic outbound/JDBC/cache/messaging spans, full semantic conventions, baggage/tracestate, or agent-managed context propagation.

## Verification

- Red test first: `bash scripts/check_java_package.sh` failed because `LogBrewServletFilter` did not exist.
- Follow-up red test: `bash scripts/real_user_spring_boot_smoke.sh` failed after removing the manual `FilterRegistrationBean`, proving the installed Spring Boot app had no automatic request span.
- Green package gate: `bash scripts/check_java_package.sh` passed Java package tests, trace correlation tests, servlet filter tests, span event summary tests, OTel context tests, operation tracing tests, support-ticket draft tests, Maven metadata checks, javadocs, source jar checks, binary jar checks, and packaged examples.
- Installed-artifact Spring smoke: `bash scripts/real_user_spring_boot_smoke.sh` passed with `spring-boot@4.0.6`. The smoke proved packed local SDK installation, Jakarta Servlet/Spring Web runtime dependencies, app-owned `LogBrewClient` bean auto-registration, Logback request log correlation, route-template request span, duration metric, incoming W3C parent span continuation, no raw request path/query/propagation header, and bounded diagnostics for app-run failures.
- Additional local gates: `bash scripts/check_java_static.sh`, `bash scripts/real_user_java_smoke.sh`, `bash scripts/real_user_java_high_load_smoke.sh`, `bash scripts/check_shell_static.sh`, `bash scripts/build_maven_central_bundle.sh --output <temp>/maven-central-bundle.zip`, and `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_generated_artifacts.py` passed.

## Remaining Gaps

- Add async servlet completion tracking only if real-user proof shows the current synchronous filter misses important spans.
- Decide whether a dedicated Spring Boot starter or property-driven client setup is worth the extra coupling; current behavior intentionally requires an app-owned client bean to avoid ingest-config ambiguity.
- Java still needs source-backed automatic JDBC/cache/messaging/outbound HTTP integrations, deeper semantic conventions, baggage/tracestate decisions, and richer trace visual context before it can beat Sentry/Datadog on the full rich-trace experience.
