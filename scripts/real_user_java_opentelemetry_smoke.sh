#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

main_sources="$tmp_dir/main-sources.txt"
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage" "$tmp_dir/api-only-app/src" "$tmp_dir/api-only-app/classes"
mkdir -p "$tmp_dir/app/src" "$tmp_dir/app/classes"

java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$tmp_dir/java-spring-kafka-deps")"
java_spring_web_classpath="$(fetch_java_spring_web_deps "$tmp_dir/java-spring-web-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath:$java_spring_web_classpath"
java_opentelemetry_api_classpath="$tmp_dir/java-opentelemetry-deps/opentelemetry-api-1.63.0.jar:$tmp_dir/java-opentelemetry-deps/opentelemetry-context-1.63.0.jar:$tmp_dir/java-opentelemetry-deps/opentelemetry-common-1.63.0.jar"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/classes/"
fi
mkdir -p "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .
jar --list --file "$tmp_dir/logbrew-sdk-0.1.0.jar" > "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOpenTelemetry.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOpenTelemetrySdk.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOpenTelemetrySpanExporter.class$' "$tmp_dir/jar-contents.txt"

cat > "$tmp_dir/api-only-app/src/Main.java" <<'JAVA'
import co.logbrew.sdk.LogBrewOpenTelemetry;
import co.logbrew.sdk.LogBrewTraceContext;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import java.util.Optional;

public final class Main {
    public static void main(String[] args) {
        SpanContext parent = SpanContext.createFromRemoteParent(
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "00f067aa0ba902b7",
            TraceFlags.getSampled(),
            TraceState.getDefault()
        );
        Optional<LogBrewTraceContext> copied =
            LogBrewOpenTelemetry.traceContextFromContext(Context.root().with(Span.wrap(parent)), "b7ad6b7169203331");
        if (copied.isEmpty()) {
            throw new AssertionError("OpenTelemetry API-only context copy failed");
        }
        System.out.println(copied.get().traceparent());
    }
}
JAVA

javac -Xlint:all -Werror --release 11 \
  -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$java_opentelemetry_api_classpath" \
  -d "$tmp_dir/api-only-app/classes" \
  "$tmp_dir/api-only-app/src/Main.java"
java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/api-only-app/classes:$java_opentelemetry_api_classpath" Main \
  > "$tmp_dir/java-otel-api-only.stdout"
grep -q '^00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01$' "$tmp_dir/java-otel-api-only.stdout"

cat > "$tmp_dir/app/src/Main.java" <<'JAVA'
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewOpenTelemetry;
import co.logbrew.sdk.LogBrewOpenTelemetrySdk;
import co.logbrew.sdk.LogBrewTraceContext;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.util.Collections;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

public final class Main {
    private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
    private static final String PARENT_SPAN_ID = "00f067aa0ba902b7";

    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "java-otel-smoke", "0.1.0");
        SpanContext parent = SpanContext.createFromRemoteParent(
            TRACE_ID,
            PARENT_SPAN_ID,
            TraceFlags.getSampled(),
            TraceState.getDefault()
        );
        SpanContext linked = SpanContext.createFromRemoteParent(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbb",
            TraceFlags.getDefault(),
            TraceState.getDefault()
        );

        Optional<LogBrewTraceContext> copied =
            LogBrewOpenTelemetry.traceContextFromContext(Context.root().with(Span.wrap(parent)), "b7ad6b7169203331");
        require(copied.isPresent(), "OpenTelemetry context copied");
        require(TRACE_ID.equals(copied.get().traceId()), "copied trace id");
        require(PARENT_SPAN_ID.equals(copied.get().parentSpanId()), "copied parent span id");

        SdkTracerProvider provider = SdkTracerProvider.builder()
            .addSpanProcessor(LogBrewOpenTelemetrySdk.spanProcessor(client))
            .build();
        try {
            Span span = provider.get("checkout-service", "1.2.3")
                .spanBuilder("GET /checkout")
                .setSpanKind(SpanKind.SERVER)
                .setParent(Context.root().with(Span.wrap(parent)))
                .addLink(
                    linked,
                    Attributes.of(
                        AttributeKey.stringKey("messaging.system"),
                        "kafka",
                        AttributeKey.stringKey("messaging.message.id"),
                        "blocked-message-id"
                    )
                )
                .setStartTimestamp(1_780_000_000_000_000_000L, TimeUnit.NANOSECONDS)
                .startSpan();
            span.setAttribute("http.request.method", "GET");
            span.setAttribute("http.route", "/checkout/{cartId}");
            span.setAttribute("http.response.status_code", 502L);
            span.setAttribute("db.system", "postgresql");
            span.setAttribute("db.statement", "select * from users where marker = 'blocked'");
            span.setAttribute("url.full", "https://example.invalid/checkout?debug=blocked");
            span.addEvent(
                "exception",
                Attributes.of(
                    AttributeKey.stringKey("exception.type"),
                    "java.lang.IllegalStateException",
                    AttributeKey.stringKey("exception.message"),
                    "blocked exception message",
                    AttributeKey.stringKey("exception.stacktrace"),
                    "blocked stacktrace"
                ),
                1_780_000_001_000_000_000L,
                TimeUnit.NANOSECONDS
            );
            span.setStatus(StatusCode.ERROR, "blocked status description");
            span.end(1_780_000_002_000_000_000L, TimeUnit.NANOSECONDS);
        } finally {
            provider.shutdown().join(5, TimeUnit.SECONDS);
        }

        require(client.pendingEvents() == 1, "one OpenTelemetry span event queued");
        SpanExporter exporter = LogBrewOpenTelemetrySdk.spanExporter(client);
        require(exporter.flush().isSuccess(), "direct exporter flush succeeds before shutdown");
        require(exporter.shutdown().isSuccess(), "direct exporter shutdown succeeds");
        require(!exporter.export(Collections.emptyList()).isSuccess(), "direct exporter export fails after shutdown");

        String payload = client.previewJson();
        requireContains(payload, "\"type\": \"span\"");
        requireContains(payload, "\"id\": \"otel_span_");
        requireContains(payload, "\"name\": \"GET /checkout\"");
        requireContains(payload, "\"traceId\": \"" + TRACE_ID + "\"");
        requireContains(payload, "\"parentSpanId\": \"" + PARENT_SPAN_ID + "\"");
        requireContains(payload, "\"status\": \"error\"");
        requireContains(payload, "\"source\": \"opentelemetry\"");
        requireContains(payload, "\"spanKind\": \"server\"");
        requireContains(payload, "\"instrumentationScopeName\": \"checkout-service\"");
        requireContains(payload, "\"instrumentationScopeVersion\": \"1.2.3\"");
        requireContains(payload, "\"httpMethod\": \"GET\"");
        requireContains(payload, "\"httpRoute\": \"/checkout/{cartId}\"");
        requireContains(payload, "\"httpStatusCode\": 502");
        requireContains(payload, "\"dbSystem\": \"postgresql\"");
        requireContains(payload, "\"exceptionType\": \"java.lang.IllegalStateException\"");
        requireContains(payload, "\"messagingSystem\": \"kafka\"");
        for (String unsafe : new String[] {
            "blocked-message-id",
            "blocked exception message",
            "blocked stacktrace",
            "blocked status description",
            "debug=blocked",
            "db.statement",
            "select * from users",
            "traceparent"
        }) {
            require(!payload.contains(unsafe), "payload omitted " + unsafe);
        }

        System.out.println(payload);
        System.err.println("{\"ok\":true,\"events\":" + client.pendingEvents() + "}");
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    private static void requireContains(String value, String expected) {
        if (!value.contains(expected)) {
            throw new AssertionError("missing " + expected + " in " + value);
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 \
  -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$java_opentelemetry_classpath" \
  -d "$tmp_dir/app/classes" \
  "$tmp_dir/app/src/Main.java"
java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/app/classes:$java_opentelemetry_classpath" Main \
  > "$tmp_dir/java-otel.stdout.json" \
  2> "$tmp_dir/java-otel.stderr.json"

python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/java-otel.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/java-otel.stderr.json"
grep -q '"events":1' "$tmp_dir/java-otel.stderr.json"
echo "Java OpenTelemetry installed-artifact smoke passed"
