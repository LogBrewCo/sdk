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
grep -q '^co/logbrew/sdk/LogBrewJmsTracing.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewJmsTracing\$ProducerConfig.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewJmsTracing\$ConsumerConfig.class$' "$tmp_dir/binary-jar-contents.txt"
jar --list --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar" > "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewJmsTracing.java$' "$tmp_dir/source-jar-contents.txt"
grep -q 'LogBrewJmsTracing' "$package_dir/README.md"
grep -q 'setStringProperty' "$package_dir/README.md"
grep -q 'getStringProperty' "$package_dir/README.md"

smoke_app="$tmp_dir/java-jms-app"
mkdir -p "$smoke_app/lib" "$smoke_app/src" "$smoke_app/classes"
cp "$tmp_dir/logbrew-sdk-0.1.0.jar" "$smoke_app/lib/logbrew-sdk-0.1.0.jar"
cat > "$smoke_app/src/Main.java" <<'JAVA'
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewJmsTracing;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.TransportResponse;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "java-jms-trace", "0.1.0");
        FakeMessage outgoing = new FakeMessage();
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            "a7ad6b7169203330"
        );
        AtomicReference<LogBrewTraceContext> produced = new AtomicReference<>();

        LogBrewTrace.Scope parentScope = LogBrewTrace.activate(parent);
        try {
            String result = LogBrewJmsTracing.send(
                client,
                outgoing,
                () -> {
                    produced.set(LogBrewTrace.current().orElseThrow());
                    return "delivered";
                },
                LogBrewJmsTracing.ProducerConfig.create()
                    .destinationName("billing-queue")
                    .eventIdPrefix("java_jms_installed")
                    .spanId("b7ad6b7169203700")
                    .metadata(Map.of("component", "billing", "messageBody", "private body"))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:02Z"),
                        Instant.parse("2026-06-02T10:00:02.010Z")
                    )
            );
            require("delivered".equals(result), "JMS send result");
        } finally {
            parentScope.close();
        }
        require(outgoing.properties.get("traceparent").equals(produced.get().traceparent()), "outgoing traceparent property");
        require(parent.traceId().equals(produced.get().traceId()), "send trace id");
        require(parent.spanId().equals(produced.get().parentSpanId()), "send parent span id");

        FakeMessage incoming = new FakeMessage();
        incoming.setStringProperty("traceparent", "00-11111111111111111111111111111111-2222222222222222-01");
        AtomicReference<LogBrewTraceContext> processed = new AtomicReference<>();
        String processResult = LogBrewJmsTracing.process(
            client,
            incoming,
            () -> {
                processed.set(LogBrewTrace.current().orElseThrow());
                return "processed";
            },
            LogBrewJmsTracing.ConsumerConfig.create()
                .destinationName("billing-queue")
                .messageCount(1)
                .timeInQueueMs(125.5)
                .eventIdPrefix("java_jms_process_installed")
                .spanId("b7ad6b7169203701")
                .metadata(Map.of("component", "billing-worker", "messageBody", "private process body"))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:03Z"),
                    Instant.parse("2026-06-02T10:00:03.020Z")
                )
        );
        require("processed".equals(processResult), "JMS process result");
        require("11111111111111111111111111111111".equals(processed.get().traceId()), "process trace id");
        require("2222222222222222".equals(processed.get().parentSpanId()), "process parent span id");

        FailingMessage failing = new FailingMessage();
        List<String> errorCodes = new ArrayList<>();
        require("sent".equals(LogBrewJmsTracing.send(
            client,
            failing,
            () -> "sent",
            LogBrewJmsTracing.ProducerConfig.create()
                .eventIdPrefix("java_jms_write_failure_installed")
                .spanId("b7ad6b7169203702")
                .onError(error -> errorCodes.add(error.code()))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:04Z"),
                    Instant.parse("2026-06-02T10:00:04.010Z")
                )
        )), "JMS write failure result");
        require("processed".equals(LogBrewJmsTracing.process(
            client,
            failing,
            () -> "processed",
            LogBrewJmsTracing.ConsumerConfig.create()
                .eventIdPrefix("java_jms_read_failure_installed")
                .spanId("b7ad6b7169203703")
                .onError(error -> errorCodes.add(error.code()))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:05Z"),
                    Instant.parse("2026-06-02T10:00:05.010Z")
                )
        )), "JMS read failure result");
        require(errorCodes.contains("jms_property_write_failed"), "write diagnostic");
        require(errorCodes.contains("jms_property_read_failed"), "read diagnostic");

        String payload = client.previewJson();
        require(client.pendingEvents() == 4, "JMS smoke queues four spans");
        require(payload.contains("\"source\": \"queue.operation\""), "queue source");
        require(payload.contains("\"queueSystem\": \"jms\""), "JMS queue system");
        require(payload.contains("\"queueOperation\": \"jms.produce\""), "JMS produce operation");
        require(payload.contains("\"queueOperation\": \"jms.process\""), "JMS process operation");
        require(payload.contains("\"queueName\": \"billing-queue\""), "JMS destination name");
        require(payload.contains("\"messageCount\": 1"), "JMS message count");
        require(payload.contains("\"timeInQueueMs\": 125.5"), "JMS queue latency");
        require(payload.contains("\"parentSpanId\": \"2222222222222222\""), "incoming parent span");
        require(!payload.contains("private body"), "send message body omitted");
        require(!payload.contains("private process body"), "process message body omitted");
        require(!payload.contains("private setter failure"), "setter exception message omitted");
        require(!payload.contains("private getter failure"), "getter exception message omitted");
        require(!payload.contains("4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7"), "raw outgoing traceparent omitted");
        require(!payload.contains("11111111111111111111111111111111-2222222222222222"), "raw incoming traceparent omitted");
        require(!payload.contains("traceparent"), "traceparent property name omitted");

        System.out.println(payload);
        TransportResponse response = client.flush(RecordingTransport.alwaysAccept());
        require(response.statusCode() == 202, "flush status");
        require(client.pendingEvents() == 0, "flush clears queue");
        System.err.println("{\"ok\":true,\"events\":4,\"status\":202}");
    }

    public static final class FakeMessage {
        private final Map<String, String> properties = new LinkedHashMap<>();

        public void setStringProperty(String name, String value) {
            properties.put(name, value);
        }

        public String getStringProperty(String name) {
            return properties.get(name);
        }
    }

    public static final class FailingMessage {
        public void setStringProperty(String name, String value) {
            throw new IllegalStateException("private setter failure");
        }

        public String getStringProperty(String name) {
            throw new IllegalStateException("private getter failure");
        }
    }

    private static void require(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 -cp "$smoke_app/lib/logbrew-sdk-0.1.0.jar" -d "$smoke_app/classes" "$smoke_app/src/Main.java"
java -cp "$smoke_app/lib/logbrew-sdk-0.1.0.jar:$smoke_app/classes" Main > "$tmp_dir/java-jms.stdout.json" 2> "$tmp_dir/java-jms.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/java-jms.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/java-jms.stderr.json"
grep -q '"events":4' "$tmp_dir/java-jms.stderr.json"
grep -q '"status":202' "$tmp_dir/java-jms.stderr.json"

echo "java jms smoke passed"
