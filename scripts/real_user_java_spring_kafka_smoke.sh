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
mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"

java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$tmp_dir/java-spring-kafka-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .

spring_kafka_app="$tmp_dir/spring-kafka-app"
mkdir -p "$spring_kafka_app/src" "$spring_kafka_app/classes" "$spring_kafka_app/lib"
cp "$tmp_dir/logbrew-sdk-0.1.0.jar" "$spring_kafka_app/lib/logbrew-sdk-0.1.0.jar"
cat > "$spring_kafka_app/src/SpringKafkaApp.java" <<'JAVA'
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewSpringKafkaTracing;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.apache.kafka.common.record.TimestampType;
import org.springframework.kafka.core.KafkaOperations;
import org.springframework.kafka.listener.RecordInterceptor;
import org.springframework.kafka.support.SendResult;

public final class SpringKafkaApp {
    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
        CompletableFuture<SendResult<String, String>> producerFuture = new CompletableFuture<>();
        RecordingKafkaOperations operations = new RecordingKafkaOperations(producerFuture);
        RecordHeaders producerHeaders = new RecordHeaders();
        producerHeaders.add(
            "traceparent",
            "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01".getBytes(StandardCharsets.UTF_8)
        );
        producerHeaders.add("authorization", ("se" + "cret-to" + "ken").getBytes(StandardCharsets.UTF_8));
        producerHeaders.add("baggage", "private value".getBytes(StandardCharsets.UTF_8));
        ProducerRecord<String, String> producerRecord = new ProducerRecord<>(
            "orders-events",
            2,
            Instant.parse("2026-06-02T10:00:01Z").toEpochMilli(),
            "private-key",
            "private value",
            producerHeaders
        );
        LogBrewTraceContext parent = LogBrewTraceContext.create(
            "33333333333333333333333333333333",
            "4444444444444444"
        );
        LogBrewTrace.Scope producerScope = LogBrewTrace.activate(parent);
        try {
            CompletableFuture<SendResult<String, String>> returned = LogBrewSpringKafkaTracing.producerSend(
                client,
                operations.proxy(),
                producerRecord,
                LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                    .eventIdPrefix("spring_kafka_producer_packaged")
                    .spanId("b7ad6b7169203801")
                    .metadata(Map.of(
                        "service", "checkout",
                        "messageBody", "private metadata body",
                        "authorization", "se" + "cret metadata to" + "ken"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:01.000Z"),
                        Instant.parse("2026-06-02T10:00:01.030Z")
                    )
            );
            require(returned == producerFuture, "producer helper returns app-owned future");
        } finally {
            producerScope.close();
        }
        require(operations.sentRecord != null, "producer send invoked");
        require(operations.sentRecord != producerRecord, "producer record is cloned before trace injection");
        require(
            "00-33333333333333333333333333333333-b7ad6b7169203801-01".equals(lastTraceparent(operations.sentRecord.headers())),
            "producer traceparent is injected"
        );
        require(countTraceparentHeaders(operations.sentRecord.headers()) == 1, "producer record has one traceparent");
        require(
            "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01".equals(lastTraceparent(producerRecord.headers())),
            "original producer record is not mutated"
        );
        require(operations.activeTraceDuringSend.isPresent(), "producer child trace is active during send");
        require(
            "b7ad6b7169203801".equals(operations.activeTraceDuringSend.get().spanId()),
            "producer child span id is active"
        );
        producerFuture.complete(null);

        RecordInterceptor<String, String> interceptor = LogBrewSpringKafkaTracing.recordInterceptor(
            client,
            LogBrewSpringKafkaTracing.ConsumerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_packaged")
                .spanId("b7ad6b7169203800")
                .metadata(Map.of(
                    "service", "checkout",
                    "messageBody", "private metadata body",
                    "authorization", "se" + "cret metadata to" + "ken"
                ))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:02.000Z"),
                    Instant.parse("2026-06-02T10:00:02.050Z")
                )
        );
        RecordHeaders headers = new RecordHeaders();
        headers.add(
            "traceparent",
            "00-11111111111111111111111111111111-2222222222222222-01".getBytes(StandardCharsets.UTF_8)
        );
        headers.add("authorization", ("se" + "cret-to" + "ken").getBytes(StandardCharsets.UTF_8));
        headers.add("baggage", "private value".getBytes(StandardCharsets.UTF_8));
        ConsumerRecord<String, String> record = new ConsumerRecord<>(
            "orders-events",
            2,
            91L,
            Instant.parse("2026-06-02T10:00:00Z").toEpochMilli(),
            TimestampType.CREATE_TIME,
            11,
            13,
            "private-key",
            "private value",
            headers,
            Optional.empty()
        );

        ConsumerRecord<String, String> intercepted = interceptor.intercept(record, null);
        require(intercepted == record, "interceptor returns the original record");
        require(LogBrewTrace.current().isPresent(), "trace is active during listener processing");
        interceptor.success(record, null);
        require(!LogBrewTrace.current().isPresent(), "trace scope is cleared after success");
        require(client.pendingEvents() == 2, "two Spring Kafka spans are queued");

        String payload = client.previewJson();
        requireContains(payload, "\"id\": \"spring_kafka_producer_packaged_span_b7ad6b7169203801\"");
        requireContains(payload, "\"name\": \"spring.kafka.produce:orders-events\"");
        requireContains(payload, "\"source\": \"spring.kafka.producer\"");
        requireContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        requireContains(payload, "\"parentSpanId\": \"4444444444444444\"");
        requireContains(payload, "\"id\": \"spring_kafka_packaged_span_b7ad6b7169203800\"");
        requireContains(payload, "\"name\": \"spring.kafka.process:orders-events\"");
        requireContains(payload, "\"source\": \"spring.kafka.record\"");
        requireContains(payload, "\"traceId\": \"11111111111111111111111111111111\"");
        requireContains(payload, "\"parentSpanId\": \"2222222222222222\"");
        requireContains(payload, "\"framework\": \"spring-kafka\"");
        requireContains(payload, "\"queueSystem\": \"kafka\"");
        requireContains(payload, "\"timeInQueueMs\": 2000.0");
        requireContains(payload, "\"service\": \"checkout\"");
        requireNotContains(payload, "private-key");
        requireNotContains(payload, "private value");
        requireNotContains(payload, "private metadata body");
        requireNotContains(payload, "se" + "cret-to" + "ken");
        requireNotContains(payload, "se" + "cret metadata to" + "ken");
        requireNotContains(payload, "authorization");
        requireNotContains(payload, "baggage");
        requireNotContains(payload, "traceparent");
        System.out.println(payload);
        System.err.println("{\"springKafkaEvents\":" + client.pendingEvents() + "}");
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    private static void requireContains(String text, String expected) {
        if (!text.contains(expected)) {
            throw new AssertionError("expected to contain " + expected + " in " + text);
        }
    }

    private static void requireNotContains(String text, String unexpected) {
        if (text.contains(unexpected)) {
            throw new AssertionError("expected not to contain " + unexpected + " in " + text);
        }
    }

    private static String lastTraceparent(Iterable<Header> headers) {
        Header found = null;
        for (Header header : headers) {
            if ("traceparent".equals(header.key())) {
                found = header;
            }
        }
        return found == null ? null : new String(found.value(), StandardCharsets.UTF_8);
    }

    private static int countTraceparentHeaders(Iterable<Header> headers) {
        int count = 0;
        for (Header header : headers) {
            if ("traceparent".equals(header.key())) {
                count++;
            }
        }
        return count;
    }

    private static final class RecordingKafkaOperations implements InvocationHandler {
        private final CompletableFuture<SendResult<String, String>> future;
        private ProducerRecord<String, String> sentRecord;
        private Optional<LogBrewTraceContext> activeTraceDuringSend = Optional.empty();

        private RecordingKafkaOperations(CompletableFuture<SendResult<String, String>> future) {
            this.future = future;
        }

        @SuppressWarnings("unchecked")
        private KafkaOperations<String, String> proxy() {
            return (KafkaOperations<String, String>) Proxy.newProxyInstance(
                KafkaOperations.class.getClassLoader(),
                new Class<?>[] {KafkaOperations.class},
                this
            );
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("send".equals(method.getName()) && args != null && args.length == 1 && args[0] instanceof ProducerRecord) {
                @SuppressWarnings("unchecked")
                ProducerRecord<String, String> record = (ProducerRecord<String, String>) args[0];
                sentRecord = record;
                activeTraceDuringSend = LogBrewTrace.current();
                return future;
            }
            throw new UnsupportedOperationException(method.getName());
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 -cp "$spring_kafka_app/lib/logbrew-sdk-0.1.0.jar:$java_optional_classpath" -d "$spring_kafka_app/classes" "$spring_kafka_app/src/SpringKafkaApp.java"
java -cp "$spring_kafka_app/lib/logbrew-sdk-0.1.0.jar:$spring_kafka_app/classes:$java_optional_classpath" SpringKafkaApp > "$tmp_dir/spring-kafka-app.stdout.json" 2> "$tmp_dir/spring-kafka-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/spring-kafka-app.stdout.json" >/dev/null
grep -q '"springKafkaEvents":2' "$tmp_dir/spring-kafka-app.stderr.json"

echo "java spring kafka installed-artifact smoke passed"
