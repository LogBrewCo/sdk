package probe;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewClientOptions;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.TelemetryContext;
import co.logbrew.sdk.TelemetryResource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class Probe {
    private static final org.slf4j.Logger LOG = LoggerFactory.getLogger("checkout.web");
    private static final String TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    private static final HttpTransport TRANSPORT =
        HttpTransport.builder().endpoint(URI.create(System.getenv("LOGBREW_CAPTURE_ENDPOINT"))).build();
    private static final LogBrewClient CLIENT = LogBrewClient.createAutomatic(
        "LOGBREW_INGEST_KEY",
        "checkout-api",
        "1.2.3",
        TRANSPORT,
        LogBrewClientOptions.builder()
            .context(TelemetryContext.builder()
                .resource(TelemetryResource.builder()
                    .service("checkout-api", "1.2.3")
                    .deployment("production", "checkout@1.2.3")
                    .build())
                .build())
            .build()
    );

    @Bean
    LogBrewClient logBrewClient() {
        return CLIENT;
    }

    @RestController
    static class CheckoutController {
        @GetMapping("/checkout/{cartId}")
        String checkout(@PathVariable String cartId) {
            LOG.info("checkout started");
            return "ok";
        }

        @GetMapping("/fail/{cartId}")
        String fail(@PathVariable String cartId) {
            LOG.warn("payment step failing");
            throw new IllegalStateException("payment declined");
        }
    }

    public static void main(String[] args) throws Exception {
        SpringApplication application = new SpringApplication(Probe.class);
        application.setDefaultProperties(Map.of("server.port", "0", "spring.main.banner-mode", "off"));
        ConfigurableApplicationContext context = application.run(args);
        // Spring Boot resets Logback while it starts, so the appender is attached afterwards.
        LogBrewLogbackAppender appender = new LogBrewLogbackAppender(CLIENT, TRANSPORT, false);
        appender.setContext((LoggerContext) LoggerFactory.getILoggerFactory());
        appender.setName("LOGBREW");
        appender.start();
        ((Logger) LOG).addAppender(appender);
        String base = "http://127.0.0.1:" + context.getEnvironment().getProperty("local.server.port");
        HttpClient http = HttpClient.newHttpClient();
        for (String path : new String[] {"/checkout/cart-1", "/fail/cart-2"}) {
            HttpRequest request = HttpRequest.newBuilder(URI.create(base + path)).header("traceparent", TRACEPARENT).build();
            System.out.println(path + " -> " + http.send(request, HttpResponse.BodyHandlers.ofString()).statusCode());
        }
        appender.stop();
        // Spring calls the client bean's inferred shutdown() destroy method, which drains the queue.
        context.close();
    }
}
