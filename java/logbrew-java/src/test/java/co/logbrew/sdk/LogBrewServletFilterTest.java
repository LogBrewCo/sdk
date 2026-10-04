package co.logbrew.sdk;

import jakarta.servlet.FilterChain;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.RequestDispatcher;
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
import java.util.List;
import org.springframework.mock.web.MockAsyncContext;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

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
        testServletFilterRethrowsAndRecordsUnhandledIssue();
        testServletFilterDoesNotInventIssueForStatusOnlyServerError();
        testAsyncCompletionCapturesFinalStatus();
        testAsyncErrorWaitsForCompletionAndKeepsPrivacy(false);
        testAsyncErrorWaitsForCompletionAndKeepsPrivacy(true);
        testAsyncTimeoutWaitsForFinalResponse();
        testAsyncRedispatchKeepsOneTraceAndOneCompletion();
        testIndependentFiltersKeepTheirOwnClients();
        testRoutePrivacyAcrossRequestLifecycles();
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
        assertContains(payload, "\"description\": \"Duration of one completed server request.\"");
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

    private void testServletFilterRethrowsAndRecordsUnhandledIssue() throws Exception {
        LogBrewClient client = sampleClient();
        LogBrewServletFilter filter = new LogBrewServletFilter(client);
        FakeHttpServletRequest request = new FakeHttpServletRequest("GET", "/orders/123")
            .queryString("debug=private")
            .header("traceparent", TRACEPARENT);
        FakeHttpServletResponse response = new FakeHttpServletResponse();
        IOException expected = new IOException("socket contains private host");
        expected.setStackTrace(new StackTraceElement[] {
            new StackTraceElement(
                "app.orders.OrderController",
                "load",
                "file:///opt/example/private/OrderController.java?debug=private",
                73
            )
        });

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
        assertContains(payload, "\"type\": \"issue\"");
        assertContains(payload, "\"name\": \"GET /orders/{orderId}\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"statusCode\": 500");
        assertContains(payload, "\"title\": \"GET /orders/{orderId} failed\"");
        assertContains(payload, "\"type\": \"IOException\"");
        assertContains(payload, "\"type\": \"jakarta_servlet.filter\"");
        assertContains(payload, "\"handled\": false");
        assertContains(payload, "\"filename\": \"OrderController.java\"");
        assertContains(payload, "\"function\": \"load\"");
        assertContains(payload, "\"module\": \"app.orders.OrderController\"");
        assertContains(payload, "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"");
        assertNotContains(payload, "socket contains private host");
        assertNotContains(payload, "/opt/example/private");
        assertNotContains(payload, "debug=private");
        assertNotContains(payload, "traceparent");
        assertTrue(LogBrewTrace.current().isEmpty(), "servlet filter closes trace after error");
        testsRun++;
    }

    private void testServletFilterDoesNotInventIssueForStatusOnlyServerError() throws Exception {
        LogBrewClient client = sampleClient();
        LogBrewServletFilter filter = new LogBrewServletFilter(client);
        FakeHttpServletRequest request = new FakeHttpServletRequest("GET", "/reports/private")
            .attribute(LogBrewServletFilter.ROUTE_TEMPLATE_ATTRIBUTE, "/reports/{reportId}");
        FakeHttpServletResponse response = new FakeHttpServletResponse();

        filter.doFilter(request.proxy(), response.proxy(), chain((servletRequest, servletResponse) ->
            ((HttpServletResponse) servletResponse).setStatus(500)
        ));

        String payload = client.previewJson();
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"type\": \"metric\"");
        assertContains(payload, "\"statusCode\": 500");
        assertNotContains(payload, "\"type\": \"issue\"");
        assertNotContains(payload, "\"exception\"");
        assertNotContains(payload, "\"stackFrames\"");
        assertNotContains(payload, "reports/private");
        testsRun++;
    }

    private void testAsyncCompletionCapturesFinalStatus() throws Exception {
        LogBrewClient client = sampleClient();
        MockHttpServletRequest request = asyncRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        new LogBrewServletFilter(client).doFilter(request, response, (incoming, outgoing) ->
            request.startAsync(incoming, outgoing));

        assertTrue(client.pendingEvents() == 0, "async request stays unfinished after chain returns");
        assertTrue(LogBrewTrace.current().isEmpty(), "initial dispatch releases its trace");
        response.setStatus(503);
        MockAsyncContext context = (MockAsyncContext) request.getAsyncContext();
        context.complete();
        for (AsyncListener listener : context.getListeners()) {
            listener.onComplete(new AsyncEvent(context, request, response));
        }

        assertTrue(client.pendingEvents() == 2, "exactly one span and metric at completion");
        assertContains(client.previewJson(), "\"statusCode\": 503");
        assertNotContains(client.previewJson(), "\"statusCode\": 200");
        assertNotContains(client.previewJson(), "private");
        testsRun++;
    }

    private void testAsyncErrorWaitsForCompletionAndKeepsPrivacy(boolean containerAttribute) throws Exception {
        LogBrewClient client = sampleClient();
        MockHttpServletRequest request = asyncRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        new LogBrewServletFilter(client).doFilter(request, response, (incoming, outgoing) ->
            request.startAsync(incoming, outgoing));
        MockAsyncContext context = (MockAsyncContext) request.getAsyncContext();
        IOException error = new IOException("private async failure");
        if (containerAttribute) {
            request.setAttribute(RequestDispatcher.ERROR_EXCEPTION, error);
        } else {
            for (AsyncListener listener : context.getListeners()) {
                listener.onError(new AsyncEvent(context, request, response, error));
            }
        }
        assertTrue(client.pendingEvents() == 0, "async error does not finish before container response");
        response.setStatus(502);
        context.complete();

        String payload = client.previewJson();
        assertTrue(client.pendingEvents() == 3, "async failure records one issue span and metric");
        assertContains(payload, "\"statusCode\": 502");
        assertContains(payload, "\"type\": \"IOException\"");
        assertContains(payload, "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"");
        assertNotContains(payload, "private");
        assertTrue(LogBrewTrace.current().isEmpty(), "async listener leaves thread trace untouched");
        testsRun++;
    }

    private void testAsyncTimeoutWaitsForFinalResponse() throws Exception {
        LogBrewClient client = sampleClient();
        MockHttpServletRequest request = asyncRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        new LogBrewServletFilter(client).doFilter(request, response, (incoming, outgoing) ->
            request.startAsync(incoming, outgoing));
        MockAsyncContext context = (MockAsyncContext) request.getAsyncContext();
        for (AsyncListener listener : context.getListeners()) {
            listener.onTimeout(new AsyncEvent(context, request, response));
        }
        assertTrue(client.pendingEvents() == 0, "timeout handler retains response ownership");
        response.setStatus(504);
        context.complete();
        assertTrue(client.pendingEvents() == 2, "timeout completion captures span and metric");
        assertContains(client.previewJson(), "\"statusCode\": 504");
        assertNotContains(client.previewJson(), "\"type\": \"issue\"");
        testsRun++;
    }

    private void testAsyncRedispatchKeepsOneTraceAndOneCompletion() throws Exception {
        LogBrewClient client = sampleClient();
        LogBrewServletFilter filter = new LogBrewServletFilter(client);
        MockHttpServletRequest request = asyncRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        LogBrewTraceContext[] originalTrace = new LogBrewTraceContext[1];
        filter.doFilter(request, response, (incoming, outgoing) -> {
            originalTrace[0] = LogBrewTrace.current().orElseThrow();
            request.startAsync(incoming, outgoing);
        });
        MockAsyncContext first = (MockAsyncContext) request.getAsyncContext();
        List<AsyncListener> listeners = List.copyOf(first.getListeners());
        request.setAsyncStarted(false);
        request.setDispatcherType(DispatcherType.ASYNC);
        LogBrewTraceContext caller = LogBrewTraceContext.create(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb");
        LogBrewTrace.Scope scope = LogBrewTrace.activate(caller);
        try {
            filter.doFilter(request, response, (incoming, outgoing) -> {
                assertSame(originalTrace[0], LogBrewTrace.current().orElseThrow(), "redispatch trace identity");
                request.startAsync(incoming, outgoing);
                MockAsyncContext next = (MockAsyncContext) request.getAsyncContext();
                for (AsyncListener listener : listeners) {
                    listener.onStartAsync(new AsyncEvent(next, request, response));
                }
            });
            assertSame(caller, LogBrewTrace.current().orElseThrow(), "dispatch preserves previous trace");
            assertTrue(client.pendingEvents() == 0, "restarted async cycle remains unfinished");
            response.setStatus(201);
            request.getAsyncContext().complete();
            assertSame(caller, LogBrewTrace.current().orElseThrow(), "completion preserves previous trace");
        } finally {
            scope.close();
        }
        assertTrue(client.pendingEvents() == 2, "redispatch queues one span and metric");
        assertContains(client.previewJson(), "\"spanId\": \"" + originalTrace[0].spanId() + "\"");
        assertContains(client.previewJson(), "\"statusCode\": 201");
        testsRun++;
    }

    private void testIndependentFiltersKeepTheirOwnClients() throws Exception {
        LogBrewClient first = sampleClient();
        LogBrewClient second = sampleClient();
        LogBrewServletFilter outer = new LogBrewServletFilter(first);
        LogBrewServletFilter inner = new LogBrewServletFilter(second);
        MockHttpServletRequest request = asyncRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        outer.doFilter(request, response, (incoming, outgoing) ->
            inner.doFilter(incoming, outgoing, (handledRequest, handledResponse) -> response.setStatus(201)));
        assertTrue(first.pendingEvents() == 2, "first client captures its request");
        assertTrue(second.pendingEvents() == 2, "second client captures its request");
        assertTrue(LogBrewTrace.current().isEmpty(), "independent filters close their scopes");
        testsRun++;
    }

    private void testRoutePrivacyAcrossRequestLifecycles() throws Exception {
        Map<String, String> routes = Map.of(
            "https://route.example.invalid/orders/{id}?private=query#private-fragment", "/orders/{id}",
            "/orders/{id}?private=query", "/orders/{id}",
            "/orders/{id}#private-fragment", "/orders/{id}",
            "?private=query", "/",
            "#private-fragment", "/",
            " ", "/",
            "/**?private=query", "/",
            "https://route.example.invalid?private=/query#private-fragment", "/",
            "https://route.example.invalid", "/"
        );
        for (String attribute : List.of(LogBrewServletFilter.ROUTE_TEMPLATE_ATTRIBUTE,
                LogBrewServletFilter.SPRING_BEST_MATCHING_PATTERN_ATTRIBUTE)) {
            for (Map.Entry<String, String> route : routes.entrySet()) {
                for (boolean async : new boolean[] {false, true}) {
                    for (String outcome : List.of("healthy", "servlet_failure", "spring_failure")) {
                        assertPrivateRouteCase(attribute, route.getKey(), route.getValue(), async, outcome);
                    }
                }
            }
        }
        testsRun++;
    }

    private void assertPrivateRouteCase(String attribute, String route, String expected, boolean async, String outcome)
        throws Exception {
        LogBrewClient client = sampleClient();
        LogBrewServletFilter filter = new LogBrewServletFilter(client);
        MockHttpServletRequest request = asyncRequest();
        request.removeAttribute(LogBrewServletFilter.ROUTE_TEMPLATE_ATTRIBUTE);
        request.setAttribute(attribute, route);
        MockHttpServletResponse response = new MockHttpServletResponse();
        IOException failure = new IOException("private failure detail");
        failure.setStackTrace(new StackTraceElement[0]);
        LogBrewTraceContext[] trace = new LogBrewTraceContext[1];
        Runnable[] completion = new Runnable[1];
        try {
            filter.doFilter(request, response, (incoming, outgoing) -> {
                trace[0] = LogBrewTrace.current().orElseThrow();
                if (async) {
                    request.startAsync(incoming, outgoing);
                    completion[0] = LogBrewTrace.wrapCurrent((Runnable) () -> {
                        try {
                            applyRouteOutcome(client, request, response, outcome, failure, true);
                            request.getAsyncContext().complete();
                        } catch (IOException error) {
                            throw new AssertionError(error);
                        }
                    });
                } else {
                    applyRouteOutcome(client, request, response, outcome, failure, false);
                }
            });
        } catch (IOException error) {
            assertSame(failure, error, "application error identity");
        }
        if (async) {
            assertTrue(client.pendingEvents() == 0, "route telemetry waits for async completion");
            completion[0].run();
        }
        boolean failed = !"healthy".equals(outcome);
        String payload = client.previewJson();
        assertTrue(client.pendingEvents() == (failed ? 3 : 2), "route capture keeps all signals");
        assertContains(payload, "\"routeTemplate\": \"" + expected + "\"");
        assertContains(payload, "\"name\": \"GET " + expected + "\"");
        if (failed) {
            assertContains(payload, "\"title\": \"GET " + expected + " failed\"");
            assertContains(payload, "\"type\": \"IOException\"");
        }
        assertContains(payload, "\"spanId\": \"" + trace[0].spanId() + "\"");
        assertContains(payload, "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"");
        assertNotContains(payload, "private");
        assertNotContains(payload, "route.example.invalid");
        assertNotContains(payload, "query");
        assertNotContains(payload, "fragment");
        assertTrue(LogBrewTrace.current().isEmpty(), "route capture closes request scope");
    }

    private static void applyRouteOutcome(LogBrewClient client, MockHttpServletRequest request,
        MockHttpServletResponse response, String outcome, IOException failure, boolean async) throws IOException {
        response.setStatus("healthy".equals(outcome) ? 201 : 500);
        if ("spring_failure".equals(outcome)) {
            assertTrue(new LogBrewSpringExceptionResolver(client).resolveException(request, response, null, failure) == null,
                "Spring keeps exception resolution ownership");
        } else if ("servlet_failure".equals(outcome)) {
            if (!async) {
                throw failure;
            }
            MockAsyncContext context = (MockAsyncContext) request.getAsyncContext();
            for (AsyncListener listener : context.getListeners()) {
                listener.onError(new AsyncEvent(context, request, response, failure));
            }
        }
    }

    private static MockHttpServletRequest asyncRequest() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/orders/private");
        request.setAsyncSupported(true);
        request.addHeader("traceparent", TRACEPARENT);
        request.setQueryString("debug=private");
        request.setAttribute(LogBrewServletFilter.ROUTE_TEMPLATE_ATTRIBUTE, "/orders/{orderId}");
        return request;
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
