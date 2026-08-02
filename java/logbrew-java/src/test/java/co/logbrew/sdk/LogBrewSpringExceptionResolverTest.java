package co.logbrew.sdk;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.core.Ordered;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.web.servlet.ModelAndView;

/**
 * Spring MVC exception issue capture test runner for the Java SDK.
 */
public final class LogBrewSpringExceptionResolverTest {
    private static final LogBrewTraceContext TRACE = LogBrewTraceContext.create(
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "00f067aa0ba902b7"
    );

    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewSpringExceptionResolverTest().run();
    }

    private void run() throws Exception {
        testResolverCapturesOnceWithoutResolvingTheException();
        testUnmatchedRouteDoesNotLeakRawRequestPath();
        testTelemetryFailureDoesNotChangeSpringBehavior();
        testSpringBootAutoConfigurationFactoryAndImport();
        System.out.println("java Spring exception resolver tests ok (" + testsRun + " tests)");
    }

    private void testResolverCapturesOnceWithoutResolvingTheException() {
        LogBrewClient client = sampleClient();
        LogBrewSpringExceptionResolver resolver = new LogBrewSpringExceptionResolver(
            client,
            "spring_request",
            Map.of("service", "checkout-api")
        );
        FakeHttpServletRequest request = new FakeHttpServletRequest("POST", "/checkout/42")
            .queryString("debug=redacted")
            .attribute(
                LogBrewServletFilter.SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE,
                "/checkout/{cartId}"
            );
        IllegalArgumentException failure = new IllegalArgumentException("user-entered checkout value");
        failure.setStackTrace(new StackTraceElement[] {
            new StackTraceElement(
                "app.checkout.CheckoutController",
                "submit",
                "C:\\private\\CheckoutController.java#local",
                91
            )
        });

        ModelAndView result;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(TRACE);
        try {
            result = resolver.resolveException(
                request.proxy(),
                fakeResponse(),
                new Object(),
                failure
            );
            resolver.resolveException(request.proxy(), fakeResponse(), null, failure);
        } finally {
            scope.close();
        }

        assertNull(result, "resolver leaves exception handling to Spring");
        assertEquals(Ordered.HIGHEST_PRECEDENCE, resolver.getOrder(), "resolver order");
        String payload = client.previewJson();
        assertOccurrenceCount(payload, "\"type\": \"issue\"", 1);
        assertContains(payload, "\"title\": \"POST /checkout/{cartId} failed\"");
        assertContains(payload, "\"type\": \"IllegalArgumentException\"");
        assertContains(payload, "\"type\": \"spring.mvc.exception_resolver\"");
        assertContains(payload, "\"handled\": false");
        assertContains(payload, "\"filename\": \"CheckoutController.java\"");
        assertContains(payload, "\"function\": \"submit\"");
        assertContains(payload, "\"module\": \"app.checkout.CheckoutController\"");
        assertContains(payload, "\"routeTemplate\": \"/checkout/{cartId}\"");
        assertContains(payload, "\"routeSource\": \"spring_best_matching_pattern\"");
        assertContains(payload, "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"");
        assertContains(payload, "\"spanId\": \"00f067aa0ba902b7\"");
        assertContains(payload, "\"service\": \"checkout-api\"");
        assertNotContains(payload, "user-entered checkout value");
        assertNotContains(payload, "C:\\\\private");
        assertNotContains(payload, "/checkout/42");
        assertNotContains(payload, "debug=redacted");
        assertTrue(LogBrewTrace.current().isEmpty(), "resolver closes no trace scope of its own");
        testsRun++;
    }

    private void testUnmatchedRouteDoesNotLeakRawRequestPath() {
        LogBrewClient client = sampleClient();
        LogBrewSpringExceptionResolver resolver = new LogBrewSpringExceptionResolver(client);
        FakeHttpServletRequest request = new FakeHttpServletRequest("GET", "/accounts/sample-id")
            .queryString("email=private@example.invalid");

        resolver.resolveException(
            request.proxy(),
            fakeResponse(),
            null,
            new IllegalStateException("private user lookup")
        );

        String payload = client.previewJson();
        assertContains(payload, "\"title\": \"GET / failed\"");
        assertContains(payload, "\"routeTemplate\": \"/\"");
        assertContains(payload, "\"routeSource\": \"unmatched\"");
        assertNotContains(payload, "sample-id");
        assertNotContains(payload, "private@example.invalid");
        assertNotContains(payload, "private user lookup");
        testsRun++;
    }

    private void testTelemetryFailureDoesNotChangeSpringBehavior() {
        LogBrewClient closedClient = sampleClient();
        closedClient.shutdown(RecordingTransport.alwaysAccept());
        LogBrewSpringExceptionResolver resolver = new LogBrewSpringExceptionResolver(closedClient);
        FakeHttpServletRequest request = new FakeHttpServletRequest("GET", "/private")
            .attribute(LogBrewServletFilter.ROUTE_TEMPLATE_ATTRIBUTE, "/safe");

        ModelAndView result = resolver.resolveException(
            request.proxy(),
            fakeResponse(),
            null,
            new IllegalStateException("private")
        );

        assertNull(result, "closed telemetry client does not resolve the exception");
        testsRun++;
    }

    private void testSpringBootAutoConfigurationFactoryAndImport() throws IOException {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource(
            "test",
            Map.of(
                "logbrew.servlet.event-id-prefix", "configured_request",
                "spring.application.name", "checkout-service"
            )
        ));
        LogBrewSpringExceptionResolver resolver = new LogBrewSpringBootExceptionAutoConfiguration()
            .logBrewSpringExceptionResolver(sampleClient(), environment);

        assertTrue(resolver != null, "auto-configuration exposes resolver");
        assertContains(
            resourceText("META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports"),
            "co.logbrew.sdk.LogBrewSpringBootExceptionAutoConfiguration"
        );
        testsRun++;
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static String resourceText(String name) throws IOException {
        try (InputStream input = LogBrewSpringExceptionResolverTest.class.getClassLoader().getResourceAsStream(name)) {
            if (input == null) {
                throw new AssertionError("missing resource " + name);
            }
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static HttpServletResponse fakeResponse() {
        return HttpServletResponse.class.cast(Proxy.newProxyInstance(
            HttpServletResponse.class.getClassLoader(),
            new Class<?>[] {HttpServletResponse.class},
            (proxy, method, args) -> defaultValue(method.getReturnType())
        ));
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("expected " + value + " to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected " + value + " to omit " + needle);
        }
    }

    private static void assertOccurrenceCount(String value, String needle, int expected) {
        int actual = 0;
        int offset = 0;
        while ((offset = value.indexOf(needle, offset)) >= 0) {
            actual++;
            offset += needle.length();
        }
        assertEquals(expected, actual, "occurrences of " + needle);
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void assertNull(Object value, String label) {
        if (value != null) {
            throw new AssertionError(label + ": expected null, got " + value);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError("expected true: " + label);
        }
    }

    private static final class FakeHttpServletRequest implements InvocationHandler {
        private final String method;
        private final String requestUri;
        private final Map<String, Object> attributes = new LinkedHashMap<>();
        private String queryString;

        private FakeHttpServletRequest(String method, String requestUri) {
            this.method = method;
            this.requestUri = requestUri;
        }

        private FakeHttpServletRequest queryString(String value) {
            queryString = value;
            return this;
        }

        private FakeHttpServletRequest attribute(String key, Object value) {
            attributes.put(key, value);
            return this;
        }

        private HttpServletRequest proxy() {
            return HttpServletRequest.class.cast(Proxy.newProxyInstance(
                HttpServletRequest.class.getClassLoader(),
                new Class<?>[] {HttpServletRequest.class},
                this
            ));
        }

        @Override
        public Object invoke(Object proxy, Method methodRef, Object[] args) {
            String name = methodRef.getName();
            if ("getMethod".equals(name)) {
                return method;
            }
            if ("getRequestURI".equals(name) || "getServletPath".equals(name)) {
                return requestUri;
            }
            if ("getQueryString".equals(name)) {
                return queryString;
            }
            if ("getAttribute".equals(name)) {
                return attributes.get(String.valueOf(args[0]));
            }
            if ("setAttribute".equals(name)) {
                attributes.put(String.valueOf(args[0]), args[1]);
                return null;
            }
            if ("removeAttribute".equals(name)) {
                attributes.remove(String.valueOf(args[0]));
                return null;
            }
            if ("getAttributeNames".equals(name)) {
                return Collections.enumeration(attributes.keySet());
            }
            if ("toString".equals(name)) {
                return "FakeHttpServletRequest";
            }
            return defaultValue(methodRef.getReturnType());
        }
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) {
            return null;
        }
        if (boolean.class.equals(type)) {
            return Boolean.FALSE;
        }
        if (int.class.equals(type)) {
            return Integer.valueOf(0);
        }
        if (long.class.equals(type)) {
            return Long.valueOf(0L);
        }
        if (double.class.equals(type)) {
            return Double.valueOf(0.0);
        }
        if (float.class.equals(type)) {
            return Float.valueOf(0.0F);
        }
        if (short.class.equals(type)) {
            return Short.valueOf((short) 0);
        }
        if (byte.class.equals(type)) {
            return Byte.valueOf((byte) 0);
        }
        if (char.class.equals(type)) {
            return Character.valueOf('\0');
        }
        return null;
    }
}
