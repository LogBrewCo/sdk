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
java_spring_web_classpath="$(fetch_java_spring_web_deps "$tmp_dir/java-spring-web-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath:$java_spring_web_classpath"

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
import co.logbrew.sdk.LogBrewSpringBootKafkaAutoConfiguration;
import co.logbrew.sdk.LogBrewSpringKafkaTracing;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Future;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.Producer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.apache.kafka.common.record.TimestampType;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaOperations;
import org.springframework.kafka.core.ProducerPostProcessor;
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

        RecordingKafkaProducer directProducer = new RecordingKafkaProducer();
        List<Optional<LogBrewTraceContext>> callbackTrace = new ArrayList<>();
        Producer<String, String> tracedProducer = LogBrewSpringKafkaTracing.producer(
            client,
            directProducer.proxy(),
            LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_wrapped_packaged")
                .spanId("b7ad6b7169203802")
                .metadata(Map.of("service", "checkout"))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:01.100Z"),
                    Instant.parse("2026-06-02T10:00:01.145Z")
                )
        );
        LogBrewTrace.Scope wrappedScope = LogBrewTrace.activate(parent);
        try {
            Future<RecordMetadata> wrappedFuture = tracedProducer.send(
                producerRecord,
                (metadata, exception) -> callbackTrace.add(LogBrewTrace.current())
            );
            require(wrappedFuture == directProducer.future, "wrapped producer returns app-owned future");
        } finally {
            wrappedScope.close();
        }
        require(directProducer.sentRecord != producerRecord, "wrapped producer clones the record before trace injection");
        require(
            "00-33333333333333333333333333333333-b7ad6b7169203802-01".equals(lastTraceparent(directProducer.sentRecord.headers())),
            "wrapped producer traceparent is injected"
        );
        require(directProducer.activeTraceDuringSend.isPresent(), "wrapped producer trace is active during send");
        directProducer.callback.onCompletion(null, null);
        require(callbackTrace.size() == 1, "wrapped producer calls user callback");
        require(callbackTrace.get(0).isPresent(), "wrapped producer callback has active trace");
        require(
            "b7ad6b7169203802".equals(callbackTrace.get(0).get().spanId()),
            "wrapped producer callback uses child span"
        );

        RecordingKafkaProducer postProcessedProducer = new RecordingKafkaProducer();
        ProducerPostProcessor<String, String> postProcessor = LogBrewSpringKafkaTracing.producerPostProcessor(
            client,
            LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_post_processor_packaged")
                .spanId("b7ad6b7169203803")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:01.200Z"),
                    Instant.parse("2026-06-02T10:00:01.255Z")
                )
        );
        Producer<String, String> postProcessed = postProcessor.apply(postProcessedProducer.proxy());
        LogBrewTrace.Scope postProcessorScope = LogBrewTrace.activate(parent);
        try {
            Future<RecordMetadata> postProcessorFuture = postProcessed.send(producerRecord);
            require(postProcessorFuture == postProcessedProducer.future, "post processor producer returns app-owned future");
        } finally {
            postProcessorScope.close();
        }
        require(
            "00-33333333333333333333333333333333-b7ad6b7169203803-01".equals(lastTraceparent(postProcessedProducer.sentRecord.headers())),
            "post processor producer traceparent is injected"
        );
        require(postProcessedProducer.activeTraceDuringSend.isPresent(), "post processor producer trace is active during send");
        postProcessedProducer.callback.onCompletion(null, null);

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

        runAutoConfigurationPackagedProof(client, producerRecord, record, parent);
        require(client.pendingEvents() == 6, "six Spring Kafka spans are queued");

        String payload = client.previewJson();
        requireContains(payload, "\"id\": \"spring_kafka_producer_packaged_span_b7ad6b7169203801\"");
        requireContains(payload, "\"name\": \"spring.kafka.produce:orders-events\"");
        requireContains(payload, "\"source\": \"spring.kafka.producer\"");
        requireContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        requireContains(payload, "\"parentSpanId\": \"4444444444444444\"");
        requireContains(payload, "\"id\": \"spring_kafka_wrapped_packaged_span_b7ad6b7169203802\"");
        requireContains(payload, "\"id\": \"spring_kafka_post_processor_packaged_span_b7ad6b7169203803\"");
        requireContains(payload, "\"id\": \"spring_kafka_packaged_span_b7ad6b7169203800\"");
        requireContains(payload, "\"id\": \"spring_kafka_auto_packaged_span_");
        requireContains(payload, "\"springApplicationName\": \"checkout-service\"");
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
        requireNotContains(payload, "localhost:9092");
        requireNotContains(payload, "ordersProducerFactory");
        requireNotContains(payload, "ordersListenerFactory");
        System.out.println(payload);
        System.err.println("{\"springKafkaEvents\":" + client.pendingEvents() + ",\"autoConfigured\":true}");
    }

    private static void runAutoConfigurationPackagedProof(
        LogBrewClient client,
        ProducerRecord<String, String> producerRecord,
        ConsumerRecord<String, String> record,
        LogBrewTraceContext parent
    ) {
        BeanPostProcessor disabledProcessor = LogBrewSpringBootKafkaAutoConfiguration
            .logBrewSpringKafkaBeanPostProcessor(new SingleLogBrewClientProvider(client), new StandardEnvironment());
        DefaultKafkaProducerFactory<String, String> defaultProducerFactory = kafkaProducerFactory();
        ConcurrentKafkaListenerContainerFactory<String, String> defaultListenerFactory =
            new ConcurrentKafkaListenerContainerFactory<>();

        disabledProcessor.postProcessAfterInitialization(defaultProducerFactory, "defaultProducerFactory");
        disabledProcessor.postProcessAfterInitialization(defaultListenerFactory, "defaultListenerFactory");

        require(defaultProducerFactory.getPostProcessors().isEmpty(), "auto config stays off without explicit property");
        require(defaultListenerFactory.getRecordInterceptor() == null, "auto listener stays off without explicit property");

        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("logbrew", Map.of(
            "logbrew.kafka.enabled", "true",
            "logbrew.kafka.event-id-prefix", "spring_kafka_auto_packaged",
            "spring.application.name", "checkout-service"
        )));
        BeanPostProcessor enabledProcessor = LogBrewSpringBootKafkaAutoConfiguration
            .logBrewSpringKafkaBeanPostProcessor(new SingleLogBrewClientProvider(client), environment);
        DefaultKafkaProducerFactory<String, String> producerFactory = kafkaProducerFactory();
        ConcurrentKafkaListenerContainerFactory<String, String> listenerFactory =
            new ConcurrentKafkaListenerContainerFactory<>();

        enabledProcessor.postProcessAfterInitialization(producerFactory, "ordersProducerFactory");
        enabledProcessor.postProcessAfterInitialization(listenerFactory, "ordersListenerFactory");

        require(producerFactory.getPostProcessors().size() == 1, "auto config adds producer post processor");
        require(listenerFactory.getRecordInterceptor() != null, "auto config adds listener interceptor");

        RecordingKafkaProducer autoProducer = new RecordingKafkaProducer();
        Producer<String, String> tracedAutoProducer = producerFactory
            .getPostProcessors()
            .get(0)
            .apply(autoProducer.proxy());
        LogBrewTrace.Scope autoProducerScope = LogBrewTrace.activate(parent);
        try {
            tracedAutoProducer.send(producerRecord);
        } finally {
            autoProducerScope.close();
        }
        require(autoProducer.sentRecord != null, "auto producer delegates send");
        require(countTraceparentHeaders(autoProducer.sentRecord.headers()) == 1, "auto producer writes one traceparent");
        autoProducer.callback.onCompletion(null, null);

        ConsumerRecord<String, String> intercepted = listenerFactory.getRecordInterceptor().intercept(record, null);
        require(intercepted == record, "auto listener returns original record");
        require(LogBrewTrace.current().isPresent(), "auto listener has active trace");
        listenerFactory.getRecordInterceptor().success(record, null);
        require(!LogBrewTrace.current().isPresent(), "auto listener clears trace");
    }

    private static DefaultKafkaProducerFactory<String, String> kafkaProducerFactory() {
        return new DefaultKafkaProducerFactory<>(Map.of(
            ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092",
            ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
            ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class
        ));
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

    private static final class SingleLogBrewClientProvider implements ObjectProvider<LogBrewClient> {
        private final LogBrewClient client;

        private SingleLogBrewClientProvider(LogBrewClient client) {
            this.client = client;
        }

        @Override
        public LogBrewClient getObject(Object... args) {
            return client;
        }

        @Override
        public LogBrewClient getIfAvailable() {
            return client;
        }

        @Override
        public LogBrewClient getIfUnique() {
            return client;
        }

        @Override
        public LogBrewClient getObject() {
            return client;
        }
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

    private static final class RecordingKafkaProducer implements InvocationHandler {
        private final CompletableFuture<RecordMetadata> future = new CompletableFuture<>();
        private ProducerRecord<String, String> sentRecord;
        private org.apache.kafka.clients.producer.Callback callback;
        private Optional<LogBrewTraceContext> activeTraceDuringSend = Optional.empty();

        @SuppressWarnings("unchecked")
        private Producer<String, String> proxy() {
            return (Producer<String, String>) Proxy.newProxyInstance(
                Producer.class.getClassLoader(),
                new Class<?>[] {Producer.class},
                this
            );
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("send".equals(method.getName()) && args != null && args.length == 2 && args[0] instanceof ProducerRecord) {
                @SuppressWarnings("unchecked")
                ProducerRecord<String, String> record = (ProducerRecord<String, String>) args[0];
                sentRecord = record;
                callback = (org.apache.kafka.clients.producer.Callback) args[1];
                activeTraceDuringSend = LogBrewTrace.current();
                return future;
            }
            if ("toString".equals(method.getName())) {
                return "RecordingKafkaProducer";
            }
            if ("close".equals(method.getName()) || "flush".equals(method.getName())) {
                return null;
            }
            throw new UnsupportedOperationException(method.getName());
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 -cp "$spring_kafka_app/lib/logbrew-sdk-0.1.0.jar:$java_optional_classpath" -d "$spring_kafka_app/classes" "$spring_kafka_app/src/SpringKafkaApp.java"
java -cp "$spring_kafka_app/lib/logbrew-sdk-0.1.0.jar:$spring_kafka_app/classes:$java_optional_classpath" SpringKafkaApp > "$tmp_dir/spring-kafka-app.stdout.json" 2> "$tmp_dir/spring-kafka-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/spring-kafka-app.stdout.json" >/dev/null
grep -q '"springKafkaEvents":6,"autoConfigured":true' "$tmp_dir/spring-kafka-app.stderr.json"

echo "java spring kafka installed-artifact smoke passed"
