package co.logbrew.sdk;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.Callback;
import org.apache.kafka.clients.producer.Producer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.apache.kafka.common.record.TimestampType;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.ProducerPostProcessor;
import org.springframework.kafka.listener.RecordInterceptor;

/**
 * Dependency-free test runner for Spring Boot Kafka auto-configuration.
 */
public final class LogBrewSpringBootKafkaAutoConfigurationTest {
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewSpringBootKafkaAutoConfigurationTest().run();
    }

    private void run() throws Exception {
        testAutoConfigurationImportIsPackaged();
        testPostProcessorRequiresExplicitEnablement();
        testPostProcessorAddsProducerPostProcessorWithoutLeakingKafkaConfig();
        testPostProcessorComposesExistingRecordInterceptor();
        testPostProcessorDoesNotTreatClassNameMatchesAsLogBrewInterceptors();
        testProducerAndConsumerCanBeDisabledIndependently();
        testPostProcessorCanBeDisabled();
        System.out.println("java spring boot kafka auto-configuration tests ok (" + testsRun + " tests)");
    }

    private void testAutoConfigurationImportIsPackaged() throws IOException {
        String imports = resourceText("META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports");

        assertContains(imports, "co.logbrew.sdk.LogBrewSpringBootKafkaAutoConfiguration");
        testsRun++;
    }

    private void testPostProcessorRequiresExplicitEnablement() throws Exception {
        LogBrewClient client = sampleClient();
        BeanPostProcessor processor = kafkaBeanPostProcessor(client, environment(Map.of()));
        DefaultKafkaProducerFactory<String, String> producerFactory = kafkaProducerFactory();
        ConcurrentKafkaListenerContainerFactory<String, String> listenerFactory =
            new ConcurrentKafkaListenerContainerFactory<>();

        Object processedProducer = processor.postProcessAfterInitialization(producerFactory, "ordersProducerFactory");
        Object processedListener = processor.postProcessAfterInitialization(listenerFactory, "ordersListenerFactory");

        assertTrue(processedProducer == producerFactory, "default producer factory is preserved");
        assertTrue(processedListener == listenerFactory, "default listener factory is preserved");
        assertEquals(0, producerFactory.getPostProcessors().size(), "default producer has no post processors");
        assertTrue(listenerFactory.getRecordInterceptor() == null, "default listener has no interceptor");
        testsRun++;
    }

    @SuppressWarnings("unchecked")
    private void testPostProcessorAddsProducerPostProcessorWithoutLeakingKafkaConfig() throws Exception {
        LogBrewClient client = sampleClient();
        BeanPostProcessor processor = kafkaBeanPostProcessor(
            client,
            environment(Map.of(
                "logbrew.kafka.enabled", "true",
                "spring.application.name", "checkout-service",
                "logbrew.kafka.event-id-prefix", "spring_kafka_auto"
            ))
        );
        DefaultKafkaProducerFactory<String, String> factory = kafkaProducerFactory();

        Object processed = processor.postProcessAfterInitialization(factory, "ordersProducerFactory");

        assertTrue(processed == factory, "producer factory bean is preserved");
        assertEquals(1, factory.getPostProcessors().size(), "producer post processor is installed");
        ProducerPostProcessor<String, String> postProcessor = factory.getPostProcessors().get(0);
        RecordingKafkaProducer delegate = new RecordingKafkaProducer();
        Producer<String, String> producer = postProcessor.apply(delegate.proxy());
        LogBrewTrace.Scope scope = LogBrewTrace.activate(LogBrewTraceContext.create(
            "33333333333333333333333333333333",
            "4444444444444444"
        ));
        try {
            producer.send(producerRecordWithHeaders());
        } finally {
            scope.close();
        }
        delegate.callback.onCompletion(null, null);

        assertTrue(delegate.sentRecord != null, "wrapped producer delegates send");
        assertEquals("00-33333333333333333333333333333333-" + delegate.sentSpanId() + "-01", lastTraceparent(delegate.sentRecord.headers()), "auto producer injects traceparent");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_auto_span_");
        assertContains(payload, "\"source\": \"spring.kafka.producer\"");
        assertContains(payload, "\"framework\": \"spring-kafka\"");
        assertContains(payload, "\"springApplicationName\": \"checkout-service\"");
        assertContains(payload, "\"queueSystem\": \"kafka\"");
        assertContains(payload, "\"queueOperation\": \"produce\"");
        assertContains(payload, "\"queueName\": \"orders-events\"");
        assertNotContains(payload, "ordersProducerFactory");
        assertNotContains(payload, "localhost:9092");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private void testPostProcessorComposesExistingRecordInterceptor() throws Exception {
        LogBrewClient client = sampleClient();
        BeanPostProcessor processor = kafkaBeanPostProcessor(
            client,
            environment(Map.of(
                "logbrew.kafka.enabled", "true",
                "spring.application.name", "checkout-service",
                "logbrew.kafka.event-id-prefix", "spring_kafka_listener_auto"
            ))
        );
        ConcurrentKafkaListenerContainerFactory<String, String> factory =
            new ConcurrentKafkaListenerContainerFactory<>();
        RecordingInterceptor delegate = new RecordingInterceptor();
        factory.setRecordInterceptor(delegate);

        Object processed = processor.postProcessAfterInitialization(factory, "ordersListenerFactory");

        assertTrue(processed == factory, "listener factory bean is preserved");
        RecordInterceptor<String, String> interceptor = factory.getRecordInterceptor();
        assertTrue(interceptor != null, "record interceptor is installed");
        assertTrue(interceptor != delegate, "existing record interceptor is composed");
        ConsumerRecord<String, String> record = recordWithHeaders();

        ConsumerRecord<String, String> intercepted = interceptor.intercept(record, null);

        assertTrue(intercepted == record, "composed interceptor returns delegate record");
        assertEquals(1, delegate.intercepts, "existing record interceptor is invoked");
        assertTrue(LogBrewTrace.current().isPresent(), "auto listener trace is active during delegate interceptor");
        interceptor.success(record, null);

        assertEquals(1, delegate.successes, "existing success callback is invoked");
        assertTrue(!LogBrewTrace.current().isPresent(), "auto listener trace clears after success");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_listener_auto_span_");
        assertContains(payload, "\"source\": \"spring.kafka.record\"");
        assertContains(payload, "\"framework\": \"spring-kafka\"");
        assertContains(payload, "\"springApplicationName\": \"checkout-service\"");
        assertContains(payload, "\"queueSystem\": \"kafka\"");
        assertContains(payload, "\"queueOperation\": \"process\"");
        assertContains(payload, "\"queueName\": \"orders-events\"");
        assertNotContains(payload, "ordersListenerFactory");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private void testPostProcessorDoesNotTreatClassNameMatchesAsLogBrewInterceptors() throws Exception {
        LogBrewClient client = sampleClient();
        BeanPostProcessor processor = kafkaBeanPostProcessor(
            client,
            environment(Map.of("logbrew.kafka.enabled", "true"))
        );
        ConcurrentKafkaListenerContainerFactory<String, String> factory =
            new ConcurrentKafkaListenerContainerFactory<>();
        ThirdPartyLogBrewRecordInterceptor delegate = new ThirdPartyLogBrewRecordInterceptor();
        factory.setRecordInterceptor(delegate);

        processor.postProcessAfterInitialization(factory, "ordersListenerFactory");

        RecordInterceptor<String, String> interceptor = factory.getRecordInterceptor();
        assertTrue(interceptor != delegate, "third-party interceptor is composed, not mistaken for LogBrew");
        ConsumerRecord<String, String> record = recordWithHeaders();

        ConsumerRecord<String, String> intercepted = interceptor.intercept(record, null);

        assertTrue(intercepted == record, "class-name match delegate record is preserved");
        assertEquals(1, delegate.intercepts, "class-name match delegate is invoked");
        interceptor.success(record, null);
        assertEquals(1, delegate.successes, "class-name match delegate success is invoked");
        testsRun++;
    }

    private void testProducerAndConsumerCanBeDisabledIndependently() throws Exception {
        LogBrewClient client = sampleClient();
        BeanPostProcessor producerDisabledProcessor = kafkaBeanPostProcessor(
            client,
            environment(Map.of(
                "logbrew.kafka.enabled", "true",
                "logbrew.kafka.producer.enabled", "false"
            ))
        );
        DefaultKafkaProducerFactory<String, String> producerDisabledFactory = kafkaProducerFactory();
        ConcurrentKafkaListenerContainerFactory<String, String> producerDisabledListenerFactory =
            new ConcurrentKafkaListenerContainerFactory<>();

        producerDisabledProcessor.postProcessAfterInitialization(producerDisabledFactory, "ordersProducerFactory");
        producerDisabledProcessor.postProcessAfterInitialization(producerDisabledListenerFactory, "ordersListenerFactory");

        assertEquals(0, producerDisabledFactory.getPostProcessors().size(), "producer switch disables producer");
        assertTrue(producerDisabledListenerFactory.getRecordInterceptor() != null, "consumer stays enabled");

        BeanPostProcessor consumerDisabledProcessor = kafkaBeanPostProcessor(
            client,
            environment(Map.of(
                "logbrew.kafka.enabled", "true",
                "logbrew.kafka.consumer.enabled", "false"
            ))
        );
        DefaultKafkaProducerFactory<String, String> consumerDisabledFactory = kafkaProducerFactory();
        ConcurrentKafkaListenerContainerFactory<String, String> consumerDisabledListenerFactory =
            new ConcurrentKafkaListenerContainerFactory<>();

        consumerDisabledProcessor.postProcessAfterInitialization(consumerDisabledFactory, "ordersProducerFactory");
        consumerDisabledProcessor.postProcessAfterInitialization(consumerDisabledListenerFactory, "ordersListenerFactory");

        assertEquals(1, consumerDisabledFactory.getPostProcessors().size(), "producer stays enabled");
        assertTrue(consumerDisabledListenerFactory.getRecordInterceptor() == null, "consumer switch disables listener");
        testsRun++;
    }

    private void testPostProcessorCanBeDisabled() throws Exception {
        LogBrewClient client = sampleClient();
        BeanPostProcessor processor = kafkaBeanPostProcessor(
            client,
            environment(Map.of("logbrew.kafka.enabled", "false"))
        );
        DefaultKafkaProducerFactory<String, String> producerFactory = kafkaProducerFactory();
        ConcurrentKafkaListenerContainerFactory<String, String> listenerFactory =
            new ConcurrentKafkaListenerContainerFactory<>();

        Object processedProducer = processor.postProcessAfterInitialization(producerFactory, "ordersProducerFactory");
        Object processedListener = processor.postProcessAfterInitialization(listenerFactory, "ordersListenerFactory");

        assertTrue(processedProducer == producerFactory, "disabled producer factory is preserved");
        assertTrue(processedListener == listenerFactory, "disabled listener factory is preserved");
        assertEquals(0, producerFactory.getPostProcessors().size(), "disabled producer has no post processors");
        assertTrue(listenerFactory.getRecordInterceptor() == null, "disabled listener has no interceptor");
        testsRun++;
    }

    private static BeanPostProcessor kafkaBeanPostProcessor(LogBrewClient client, StandardEnvironment environment)
        throws Exception {
        Class<?> configClass = Class.forName("co.logbrew.sdk.LogBrewSpringBootKafkaAutoConfiguration");
        Method factoryMethod = configClass.getDeclaredMethod(
            "logBrewSpringKafkaBeanPostProcessor",
            ObjectProvider.class,
            org.springframework.core.env.Environment.class
        );
        return (BeanPostProcessor) factoryMethod.invoke(null, new SingleLogBrewClientProvider(client), environment);
    }

    private static StandardEnvironment environment(Map<String, Object> values) {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", values));
        return environment;
    }

    private static String resourceText(String path) throws IOException {
        InputStream stream = LogBrewSpringBootKafkaAutoConfigurationTest
            .class
            .getClassLoader()
            .getResourceAsStream(path);
        if (stream == null) {
            throw new AssertionError("expected resource " + path);
        }
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                text.append(line).append('\n');
            }
        }
        return text.toString();
    }

    private static ConsumerRecord<String, String> recordWithHeaders() {
        RecordHeaders headers = new RecordHeaders();
        headers.add(
            "traceparent",
            "00-11111111111111111111111111111111-2222222222222222-01".getBytes(StandardCharsets.UTF_8)
        );
        headers.add("authorization", ("se" + "cret-to" + "ken").getBytes(StandardCharsets.UTF_8));
        headers.add("baggage", "private value".getBytes(StandardCharsets.UTF_8));
        return new ConsumerRecord<>(
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
    }

    private static ProducerRecord<String, String> producerRecordWithHeaders() {
        RecordHeaders headers = new RecordHeaders();
        headers.add(
            "traceparent",
            "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01".getBytes(StandardCharsets.UTF_8)
        );
        headers.add("authorization", ("se" + "cret-to" + "ken").getBytes(StandardCharsets.UTF_8));
        headers.add("baggage", "private value".getBytes(StandardCharsets.UTF_8));
        return new ProducerRecord<>(
            "orders-events",
            2,
            Instant.parse("2026-06-02T10:00:07Z").toEpochMilli(),
            "private-key",
            "private value",
            headers
        );
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static DefaultKafkaProducerFactory<String, String> kafkaProducerFactory() {
        return new DefaultKafkaProducerFactory<>(Map.of(
            ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092",
            ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
            ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class
        ));
    }

    private static String lastTraceparent(Iterable<org.apache.kafka.common.header.Header> headers) {
        org.apache.kafka.common.header.Header found = null;
        for (org.apache.kafka.common.header.Header header : headers) {
            if ("traceparent".equals(header.key())) {
                found = header;
            }
        }
        return found == null ? null : new String(found.value(), StandardCharsets.UTF_8);
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

    private static final class RecordingInterceptor implements RecordInterceptor<String, String> {
        private int intercepts;
        private int successes;

        @Override
        public ConsumerRecord<String, String> intercept(
            ConsumerRecord<String, String> record,
            Consumer<String, String> consumer
        ) {
            intercepts++;
            return record;
        }

        @Override
        public void success(ConsumerRecord<String, String> record, Consumer<String, String> consumer) {
            successes++;
        }
    }

    private static final class ThirdPartyLogBrewRecordInterceptor implements RecordInterceptor<String, String> {
        private int intercepts;
        private int successes;

        @Override
        public ConsumerRecord<String, String> intercept(
            ConsumerRecord<String, String> record,
            Consumer<String, String> consumer
        ) {
            intercepts++;
            return record;
        }

        @Override
        public void success(ConsumerRecord<String, String> record, Consumer<String, String> consumer) {
            successes++;
        }
    }

    private static final class RecordingKafkaProducer implements InvocationHandler {
        private final CompletableFuture<RecordMetadata> future = new CompletableFuture<>();
        private ProducerRecord<String, String> sentRecord;
        private Callback callback;

        @SuppressWarnings("unchecked")
        private Producer<String, String> proxy() {
            return (Producer<String, String>) Proxy.newProxyInstance(
                Producer.class.getClassLoader(),
                new Class<?>[] {Producer.class},
                this
            );
        }

        private String sentSpanId() {
            String traceparent = lastTraceparent(sentRecord.headers());
            return traceparent == null ? null : traceparent.split("-")[2];
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("send".equals(method.getName()) && args != null && args.length == 2 && args[0] instanceof ProducerRecord) {
                @SuppressWarnings("unchecked")
                ProducerRecord<String, String> record = (ProducerRecord<String, String>) args[0];
                sentRecord = record;
                callback = (Callback) args[1];
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
}
