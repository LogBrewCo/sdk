package co.logbrew.sdk;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

public final class LogBrewSpringBootHttpClientAutoConfigurationTest {
    private int testsRun;

    public static void main(String[] args) {
        new LogBrewSpringBootHttpClientAutoConfigurationTest().run();
    }

    private void run() {
        testBlockingPostProcessorInstrumentsBuildersAndTemplatesOnce();
        testBlockingPostProcessorHonorsManualInstrumentation();
        testReactivePostProcessorInstrumentsBuilderOnce();
        testReactivePostProcessorHonorsManualInstrumentation();
        testPropertyDisablesBothPostProcessors();
        testBlockingPostProcessorDoesNotResolveClientForOtherBeans();
        testAutoConfigurationFactoriesExposePostProcessors();
        System.out.println("java Spring Boot HTTP client auto-configuration tests ok (" + testsRun + " tests)");
    }

    private void testBlockingPostProcessorInstrumentsBuildersAndTemplatesOnce() {
        LogBrewSpringBootHttpClientPostProcessor processor = new LogBrewSpringBootHttpClientPostProcessor(
            sampleClient(),
            environment(Map.of())
        );
        RestClient.Builder builder = RestClient.builder();
        RestTemplate template = new RestTemplate();

        processor.postProcessBeforeInitialization(builder, "restClientBuilder");
        processor.postProcessAfterInitialization(builder, "restClientBuilder");
        processor.postProcessBeforeInitialization(template, "restTemplate");
        processor.postProcessAfterInitialization(template, "restTemplate");

        assertEquals(1, blockingInterceptorCount(builder), "RestClient interceptor count");
        assertEquals(1, blockingInterceptorCount(template.getInterceptors()), "RestTemplate interceptor count");
        testsRun++;
    }

    private void testBlockingPostProcessorHonorsManualInstrumentation() {
        LogBrewClient client = sampleClient();
        LogBrewSpringBootHttpClientPostProcessor processor = new LogBrewSpringBootHttpClientPostProcessor(
            client,
            environment(Map.of())
        );
        RestTemplate template = new RestTemplate();
        template.getInterceptors().add(LogBrewSpringHttpTracing.restTemplateInterceptor(client));

        processor.postProcessAfterInitialization(template, "restTemplate");

        assertEquals(1, blockingInterceptorCount(template.getInterceptors()), "manual interceptor count");
        testsRun++;
    }

    private void testReactivePostProcessorInstrumentsBuilderOnce() {
        LogBrewSpringBootWebClientPostProcessor processor = new LogBrewSpringBootWebClientPostProcessor(
            sampleClient(),
            environment(Map.of())
        );
        WebClient.Builder builder = WebClient.builder();

        processor.postProcessBeforeInitialization(builder, "webClientBuilder");
        processor.postProcessAfterInitialization(builder, "webClientBuilder");

        assertEquals(1, reactiveFilterCount(builder), "WebClient filter count");
        testsRun++;
    }

    private void testReactivePostProcessorHonorsManualInstrumentation() {
        LogBrewClient client = sampleClient();
        LogBrewSpringBootWebClientPostProcessor processor = new LogBrewSpringBootWebClientPostProcessor(
            client,
            environment(Map.of())
        );
        WebClient.Builder builder = WebClient.builder()
            .filter(LogBrewSpringWebClientTracing.filter(client));

        processor.postProcessAfterInitialization(builder, "webClientBuilder");

        assertEquals(1, reactiveFilterCount(builder), "manual filter count");
        testsRun++;
    }

    private void testPropertyDisablesBothPostProcessors() {
        StandardEnvironment environment = environment(Map.of("logbrew.http-client.enabled", "false"));
        RestTemplate template = new RestTemplate();
        WebClient.Builder builder = WebClient.builder();

        new LogBrewSpringBootHttpClientPostProcessor(sampleClient(), environment)
            .postProcessAfterInitialization(template, "restTemplate");
        new LogBrewSpringBootWebClientPostProcessor(sampleClient(), environment)
            .postProcessAfterInitialization(builder, "webClientBuilder");

        assertEquals(0, blockingInterceptorCount(template.getInterceptors()), "disabled blocking count");
        assertEquals(0, reactiveFilterCount(builder), "disabled reactive count");
        testsRun++;
    }

    private void testAutoConfigurationFactoriesExposePostProcessors() {
        StandardEnvironment environment = environment(Map.of());
        BeanPostProcessor blocking = LogBrewSpringBootHttpClientAutoConfiguration
            .logBrewSpringHttpClientPostProcessor(singleClientProvider(sampleClient()), environment);
        BeanPostProcessor reactive = LogBrewSpringBootWebClientAutoConfiguration
            .logBrewSpringWebClientPostProcessor(singleClientProvider(sampleClient()), environment);

        assertTrue(blocking instanceof LogBrewSpringBootHttpClientPostProcessor, "blocking post-processor type");
        assertTrue(reactive instanceof LogBrewSpringBootWebClientPostProcessor, "reactive post-processor type");
        testsRun++;
    }

    private void testBlockingPostProcessorDoesNotResolveClientForOtherBeans() {
        AtomicInteger resolutions = new AtomicInteger();
        LogBrewClient client = sampleClient();
        org.springframework.beans.factory.ObjectProvider<LogBrewClient> provider =
            new org.springframework.beans.factory.ObjectProvider<>() {
                @Override
                public LogBrewClient getObject(Object... args) {
                    resolutions.incrementAndGet();
                    return client;
                }

                @Override
                public LogBrewClient getIfAvailable() {
                    resolutions.incrementAndGet();
                    return client;
                }

                @Override
                public LogBrewClient getIfUnique() {
                    resolutions.incrementAndGet();
                    return client;
                }

                @Override
                public LogBrewClient getObject() {
                    resolutions.incrementAndGet();
                    return client;
                }
            };
        LogBrewSpringBootHttpClientPostProcessor processor = new LogBrewSpringBootHttpClientPostProcessor(
            provider,
            environment(Map.of())
        );

        Object bean = new Object();
        assertTrue(processor.postProcessAfterInitialization(bean, "otherBean") == bean, "other bean preserved");
        assertEquals(0, resolutions.get(), "unrelated bean client resolutions");
        testsRun++;
    }

    private static int blockingInterceptorCount(RestClient.Builder builder) {
        AtomicInteger count = new AtomicInteger();
        builder.requestInterceptors(interceptors -> count.set(blockingInterceptorCount(interceptors)));
        return count.get();
    }

    private static int blockingInterceptorCount(List<?> interceptors) {
        return Math.toIntExact(interceptors.stream().filter(LogBrewSpringHttpTracing::isTracingInterceptor).count());
    }

    private static int reactiveFilterCount(WebClient.Builder builder) {
        AtomicInteger count = new AtomicInteger();
        builder.filters(filters -> count.set(Math.toIntExact(filters.stream()
            .filter(LogBrewSpringWebClientTracing::isTracingFilter)
            .count())));
        return count.get();
    }

    private static StandardEnvironment environment(Map<String, Object> values) {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", values));
        return environment;
    }

    private static org.springframework.beans.factory.ObjectProvider<LogBrewClient> singleClientProvider(
        LogBrewClient client
    ) {
        return new org.springframework.beans.factory.ObjectProvider<>() {
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
        };
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "spring-boot-http", "0.1.0");
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
}
