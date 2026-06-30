#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"
# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT
main_sources="$tmp_dir/main-sources.txt"
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage" "$tmp_dir/source-stage"

java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$tmp_dir/java-spring-kafka-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
mkdir -p "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .

cp "$package_dir/pom.xml" "$tmp_dir/source-stage/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/source-stage/README.md"
cp -R "$package_dir/src" "$tmp_dir/source-stage/src"
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar" -C "$tmp_dir/source-stage" .

jar --list --file "$tmp_dir/logbrew-sdk-0.1.0.jar" > "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/SpanLinkSummary.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing\$QueueOperation.class$' "$tmp_dir/binary-jar-contents.txt"
jar --list --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar" > "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/SpanLinkSummary.java$' "$tmp_dir/source-jar-contents.txt"
grep -q 'traceparentHeaderSetter' "$package_dir/README.md"
grep -q 'incomingTraceparent' "$package_dir/README.md"
grep -q 'linkedMessageTraceparent' "$package_dir/README.md"

smoke_app="$tmp_dir/java-queue-trace-app"
mkdir -p "$smoke_app/lib" "$smoke_app/src" "$smoke_app/classes"
cp "$tmp_dir/logbrew-sdk-0.1.0.jar" "$smoke_app/lib/logbrew-sdk-0.1.0.jar"
cat > "$smoke_app/src/Main.java" <<'JAVA'
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewOperationTracing;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.SpanAttributes;
import co.logbrew.sdk.SpanLinkSummary;
import co.logbrew.sdk.TransportResponse;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "java-queue-trace", "0.1.0");
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            "a7ad6b7169203330"
        );
        AtomicReference<String> headerName = new AtomicReference<>("");
        AtomicReference<String> headerValue = new AtomicReference<>("");
        AtomicReference<LogBrewTraceContext> published = new AtomicReference<>();

        LogBrewTrace.Scope parentScope = LogBrewTrace.activate(parent);
        try {
            LogBrewOperationTracing.queueOperation(
                client,
                "publish invoice",
                () -> {
                    published.set(LogBrewTrace.current().orElseThrow());
                    return "delivered";
                },
                LogBrewOperationTracing.QueueOperation.create()
                    .system("kafka")
                    .operationKind("publish")
                    .queueName("billing-events")
                    .taskName("invoice.created")
                    .messageCount(1)
                    .eventIdPrefix("java_queue_installed")
                    .spanId("b7ad6b7169203333")
                    .traceparentHeaderSetter((name, value) -> {
                        headerName.set(name);
                        headerValue.set(value);
                    })
                    .metadata(Map.of("component", "billing", "messageBody", "private body"))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:02Z"),
                        Instant.parse("2026-06-02T10:00:02.010Z")
                    )
            );
        } finally {
            parentScope.close();
        }

        require("traceparent".equals(headerName.get()), "outgoing traceparent header name");
        require(headerValue.get().equals(published.get().traceparent()), "outgoing traceparent value");
        require(parent.traceId().equals(published.get().traceId()), "publish trace id");
        require(parent.spanId().equals(published.get().parentSpanId()), "publish parent span id");

        AtomicReference<LogBrewTraceContext> processed = new AtomicReference<>();
        LogBrewOperationTracing.queueOperation(
            client,
            "process invoices",
            () -> {
                processed.set(LogBrewTrace.current().orElseThrow());
                return "processed";
            },
            LogBrewOperationTracing.QueueOperation.create()
                .system("kafka")
                .operationKind("process")
                .queueName("billing-events")
                .messageCount(2)
                .eventIdPrefix("java_queue_process_installed")
                .spanId("b7ad6b7169203335")
                .enqueuedAt(Instant.parse("2026-06-02T10:00:00Z"))
                .incomingTraceparent("00-11111111111111111111111111111111-2222222222222222-01")
                .linkedMessageTraceparent(
                    "00-33333333333333333333333333333333-4444444444444444-00",
                    Map.of("partition", Integer.valueOf(2), "messageBody", "private")
                )
                .linkedMessageTraceparent("00-55555555555555555555555555555555-6666666666666666-01")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:02.020Z"),
                    Instant.parse("2026-06-02T10:00:02.040Z")
                )
        );
        require("11111111111111111111111111111111".equals(processed.get().traceId()), "process trace id");
        require("2222222222222222".equals(processed.get().parentSpanId()), "process parent span id");

        List<String> errorCodes = new ArrayList<>();
        String malformedResult = LogBrewOperationTracing.queueOperation(
            client,
            "process malformed",
            () -> "processed",
            LogBrewOperationTracing.QueueOperation.create()
                .eventIdPrefix("java_queue_malformed_installed")
                .spanId("b7ad6b7169203336")
                .timeInQueueMs(125.5)
                .incomingTraceparent("not-a-traceparent")
                .linkedMessageTraceparent("also-not-a-traceparent")
                .traceparentHeaderSetter((name, value) -> {
                    throw new IllegalStateException("headers are read-only");
                })
                .onError(error -> errorCodes.add(error.code()))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:03Z"),
                    Instant.parse("2026-06-02T10:00:03.010Z")
                )
        );
        require("processed".equals(malformedResult), "malformed propagation result");
        require(errorCodes.contains("validation_error"), "malformed propagation diagnostic");
        require(errorCodes.contains("traceparent_injection_failed"), "setter diagnostic");

        client.span(
            "evt_span_manual_queue_link",
            "2026-06-02T10:00:03.020Z",
            SpanAttributes.create(
                    "manual linked queue summary",
                    "77777777777777777777777777777777",
                    "8888888888888888",
                    "ok"
                )
                .link(SpanLinkSummary.fromTraceparent(
                    "00-99999999999999999999999999999999-aaaaaaaaaaaaaaaa-01"
                ).metadata(Map.of("component", "billing", "messageBody", "private")))
        );

        String payload = client.previewJson();
        require(client.pendingEvents() == 4, "queue trace smoke queues four spans");
        require(payload.contains("\"source\": \"queue.operation\""), "queue source");
        require(payload.contains("\"parentSpanId\": \"2222222222222222\""), "incoming parent span");
        require(payload.contains("\"timeInQueueMs\": 2020.0"), "computed queue latency");
        require(payload.contains("\"timeInQueueMs\": 125.5"), "explicit queue latency");
        require(payload.contains("\"links\": ["), "span links serialized");
        require(payload.contains("\"traceId\": \"33333333333333333333333333333333\""), "first linked trace id");
        require(payload.contains("\"spanId\": \"4444444444444444\""), "first linked span id");
        require(payload.contains("\"sampled\": false"), "unsampled link flag");
        require(payload.contains("\"traceId\": \"55555555555555555555555555555555\""), "second linked trace id");
        require(payload.contains("\"traceId\": \"99999999999999999999999999999999\""), "manual linked trace id");
        require(!payload.contains("2026-06-02T10:00:00Z"), "raw enqueue timestamp is omitted");
        require(!payload.contains("private body"), "message bodies are omitted");
        require(!payload.contains("not-a-traceparent"), "malformed incoming propagation is omitted");
        require(!payload.contains("also-not-a-traceparent"), "malformed linked propagation is omitted");
        require(!payload.contains("headers are read-only"), "setter exception message is omitted");
        require(!payload.contains("traceFlags"), "raw trace flags are omitted from links");

        System.out.println(payload);
        TransportResponse response = client.flush(RecordingTransport.alwaysAccept());
        require(response.statusCode() == 202, "flush status");
        require(client.pendingEvents() == 0, "flush clears queue");
        System.err.println("{\"ok\":true,\"events\":4,\"status\":202}");
    }

    private static void require(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 -cp "$smoke_app/lib/logbrew-sdk-0.1.0.jar" -d "$smoke_app/classes" "$smoke_app/src/Main.java"
java -cp "$smoke_app/lib/logbrew-sdk-0.1.0.jar:$smoke_app/classes" Main > "$tmp_dir/java-queue-trace.stdout.json" 2> "$tmp_dir/java-queue-trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/java-queue-trace.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/java-queue-trace.stderr.json"
grep -q '"events":4' "$tmp_dir/java-queue-trace.stderr.json"
grep -q '"status":202' "$tmp_dir/java-queue-trace.stderr.json"

echo "java queue trace smoke passed"
