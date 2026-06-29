package co.logbrew.sdk;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Jakarta Servlet request tracing test runner for the Java SDK.
 */
public final class LogBrewServletFilterTest {
    private static final String TRACEPARENT =
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";

    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewServletFilterTest().run();
    }

    private void run() throws Exception {
        testServletFilterCorrelatesLogsSpanAndMetric();
        testServletFilterRethrowsAndRecordsServerError();
        System.out.println("java servlet filter tests ok (" + testsRun + " tests)");
    }

    private void testServletFilterCorrelatesLogsSpanAndMetric() throws Exception {
        LogBrewClient client = sampleClient();
        LogBrewServletFilter filter = new LogBrewServletFilter(
            client,
            "servlet_request",
            Map.of("service", "checkout-api")
        );
        FakeHttpServletRequest request = new FakeHttpServletRequest("post", "/checkout/private")
            .queryString("debug=true")
            .header("traceparent", TRACEPARENT)
            .attribute(LogBrewServletFilter.ROUTE_TEMPLATE_ATTRIBUTE, "/checkout/{cartId}");
        FakeHttpServletResponse response = new FakeHttpServletResponse();

        filter.doFilter(request.proxy(), response.proxy(), chain((servletRequest, servletResponse) -> {
            assertCurrentTracePresent();
            ((HttpServletResponse) servletResponse).setStatus(201);
            client.log(
                "evt_log_servlet",
                "2026-06-02T10:00:02Z",
                LogAttributes.create("checkout request started", "info")
                    .metadata(LogBrewTrace.metadataWithCurrentTrace(Map.of("stage", "handler")))
            );
        }));

        String payload = client.previewJson();
        assertContains(payload, "\"type\": \"log\"");
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"type\": \"metric\"");
        assertContains(payload, "\"name\": \"POST /checkout/{cartId}\"");
        assertContains(payload, "\"name\": \"http.server.duration\"");
        assertContains(payload, "\"status\": \"ok\"");
        assertContains(payload, "\"routeTemplate\": \"/checkout/{cartId}\"");
        assertContains(payload, "\"statusCode\": 201");
        assertContains(payload, "\"service\": \"checkout-api\"");
        assertContains(payload, "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"");
        assertContains(payload, "\"parentSpanId\": \"00f067aa0ba902b7\"");
        assertNotContains(payload, "checkout/private");
        assertNotContains(payload, "debug=true");
        assertNotContains(payload, "traceparent");
        assertTrue(LogBrewTrace.current().isEmpty(), "servlet filter closes active trace");
        testsRun++;
    }

    private void testServletFilterRethrowsAndRecordsServerError() throws Exception {
        LogBrewClient client = sampleClient();
        LogBrewServletFilter filter = new LogBrewServletFilter(client);
        FakeHttpServletRequest request = new FakeHttpServletRequest("GET", "/orders/123")
            .queryString("debug=private")
            .header("traceparent", "not-a-traceparent");
        FakeHttpServletResponse response = new FakeHttpServletResponse();
        IOException expected = new IOException("socket contains private host");

        try {
            filter.doFilter(request.proxy(), response.proxy(), chain((servletRequest, servletResponse) -> {
                assertCurrentTracePresent();
                servletRequest.setAttribute(
                    LogBrewServletFilter.SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE,
                    "/orders/{orderId}"
                );
                throw expected;
            }));
            throw new AssertionError("expected servlet filter to rethrow request failure");
        } catch (IOException actual) {
            assertSame(expected, actual, "rethrows original IOException");
        }

        String payload = client.previewJson();
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"type\": \"metric\"");
        assertContains(payload, "\"name\": \"GET /orders/{orderId}\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"statusCode\": 500");
        assertNotContains(payload, "socket contains private host");
        assertNotContains(payload, "debug=private");
        assertNotContains(payload, "traceparent");
        assertTrue(LogBrewTrace.current().isEmpty(), "servlet filter closes trace after error");
        testsRun++;
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static FilterChain chain(ThrowingChain chain) {
        return chain::run;
    }

    private static void assertCurrentTracePresent() {
        assertTrue(LogBrewTrace.current().isPresent(), "active servlet request trace");
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

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError("expected true: " + label);
        }
    }

    private static void assertSame(Object expected, Object actual, String label) {
        if (expected != actual) {
            throw new AssertionError(label + ": expected same object");
        }
    }

    private interface ThrowingChain {
        void run(ServletRequest request, ServletResponse response) throws IOException, ServletException;
    }

    private static final class FakeHttpServletRequest implements InvocationHandler {
        private final String method;
        private final String requestUri;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private final Map<String, Object> attributes = new LinkedHashMap<>();
        private String queryString;

        private FakeHttpServletRequest(String method, String requestUri) {
            this.method = method;
            this.requestUri = requestUri;
        }

        private FakeHttpServletRequest queryString(String value) {
            this.queryString = value;
            return this;
        }

        private FakeHttpServletRequest header(String key, String value) {
            headers.put(key.toLowerCase(Locale.ROOT), value);
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
            if ("getRequestURI".equals(name)) {
                return requestUri;
            }
            if ("getQueryString".equals(name)) {
                return queryString;
            }
            if ("getHeader".equals(name)) {
                return headers.get(String.valueOf(args[0]).toLowerCase(Locale.ROOT));
            }
            if ("getHeaders".equals(name)) {
                String value = headers.get(String.valueOf(args[0]).toLowerCase(Locale.ROOT));
                return value == null ? Collections.emptyEnumeration() : Collections.enumeration(Collections.singleton(value));
            }
            if ("getHeaderNames".equals(name)) {
                return Collections.enumeration(headers.keySet());
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
            if ("getServletPath".equals(name)) {
                return requestUri;
            }
            if ("getContextPath".equals(name)) {
                return "";
            }
            if ("isAsyncStarted".equals(name)) {
                return Boolean.FALSE;
            }
            if ("toString".equals(name)) {
                return "FakeHttpServletRequest";
            }
            return defaultValue(methodRef.getReturnType());
        }
    }

    private static final class FakeHttpServletResponse implements InvocationHandler {
        private int status = 200;

        private HttpServletResponse proxy() {
            return HttpServletResponse.class.cast(Proxy.newProxyInstance(
                HttpServletResponse.class.getClassLoader(),
                new Class<?>[] {HttpServletResponse.class},
                this
            ));
        }

        @Override
        public Object invoke(Object proxy, Method methodRef, Object[] args) {
            String name = methodRef.getName();
            if ("getStatus".equals(name)) {
                return Integer.valueOf(status);
            }
            if ("setStatus".equals(name)) {
                status = ((Integer) args[0]).intValue();
                return null;
            }
            if ("sendError".equals(name)) {
                status = ((Integer) args[0]).intValue();
                return null;
            }
            if ("toString".equals(name)) {
                return "FakeHttpServletResponse";
            }
            return defaultValue(methodRef.getReturnType());
        }
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) {
            if (Enumeration.class.isAssignableFrom(type)) {
                return Collections.emptyEnumeration();
            }
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
