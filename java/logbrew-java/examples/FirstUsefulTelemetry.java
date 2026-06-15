import co.logbrew.sdk.EnvironmentAttributes;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.MetricAttributes;
import co.logbrew.sdk.ProductTimeline;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.ReleaseAttributes;
import co.logbrew.sdk.Traceparent;
import co.logbrew.sdk.TransportResponse;
import java.util.Map;

public final class FirstUsefulTelemetry {
    private static final String TRACEPARENT =
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
    private static final String CHILD_SPAN_ID = "b7ad6b7169203331";
    private static final String SESSION_ID = "sess_checkout_123";
    private static final String ROUTE_TEMPLATE = "/checkout/:cart_id";

    private FirstUsefulTelemetry() {
    }

    public static void main(String[] args) {
        Traceparent.Context context = Traceparent.parse(TRACEPARENT);
        Map<String, String> outgoingHeaders = Traceparent.createHeaders(
            context.traceId(),
            CHILD_SPAN_ID,
            context.traceFlags()
        );
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "checkout-java-service", "0.1.0");

        enqueueFirstUsefulTelemetry(client, context);

        System.out.println(client.previewJson());
        TransportResponse response = client.shutdown(RecordingTransport.alwaysAccept());
        System.err.println(
            "{\"ok\":true,\"status\":"
                + response.statusCode()
                + ",\"attempts\":"
                + response.attempts()
                + ",\"events\":7,\"outgoingTraceparent\":\""
                + outgoingHeaders.get("traceparent")
                + "\"}"
        );
    }

    private static void enqueueFirstUsefulTelemetry(
        LogBrewClient client,
        Traceparent.Context context
    ) {
        client.release(
            "evt_release_checkout_api",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.create("checkout-api@1.4.2")
                .commit("abc123def456")
                .metadata(Map.of("deploySource", "java-service"))
        );
        client.environment(
            "evt_environment_checkout_api",
            "2026-06-02T10:00:01Z",
            EnvironmentAttributes.create("production")
                .region("us-east-1")
                .metadata(Map.of("service", "checkout-api"))
        );
        client.log(
            "evt_log_checkout_started",
            "2026-06-02T10:00:02Z",
            LogAttributes.create("checkout request started", "info")
                .logger("checkout.http")
                .metadata(Map.of(
                    "routeTemplate", ROUTE_TEMPLATE,
                    "sessionId", SESSION_ID,
                    "traceId", context.traceId()
                ))
        );
        client.action(
            "evt_action_checkout_submit",
            "2026-06-02T10:00:03Z",
            ProductTimeline.productAction("checkout.submit")
                .routeTemplate("https://shop.example/checkout/:cart_id?coupon=private#review")
                .sessionId(SESSION_ID)
                .traceId(context.traceId())
                .screen("Checkout")
                .funnel("checkout")
                .step("submit")
                .metadata(Map.of("cartTier", "gold"))
                .toActionAttributes()
        );
        client.action(
            "evt_action_payment_api",
            "2026-06-02T10:00:04Z",
            ProductTimeline.networkMilestone("https://payments.example/payments/:payment_id?card=private")
                .method("post")
                .statusCode(202)
                .durationMs(183.4)
                .sessionId(SESSION_ID)
                .traceId(context.traceId())
                .metadata(Map.of("dependency", "payments"))
                .toActionAttributes()
        );
        client.metric(
            "evt_metric_http_server_duration",
            "2026-06-02T10:00:05Z",
            MetricAttributes.create("http.server.duration", "histogram", 183.4, "ms", "delta")
                .metadata(Map.of(
                    "method", "POST",
                    "routeTemplate", ROUTE_TEMPLATE,
                    "statusCode", 202,
                    "traceId", context.traceId()
                ))
        );
        client.span(
            "evt_span_checkout_request",
            "2026-06-02T10:00:06Z",
            Traceparent.spanAttributesFromTraceparent(
                TRACEPARENT,
                Traceparent.SpanInput.create("POST " + ROUTE_TEMPLATE, CHILD_SPAN_ID, "ok")
                    .durationMs(183.4)
                    .metadata(Map.of(
                        "routeTemplate", ROUTE_TEMPLATE,
                        "sampled", context.sampled(),
                        "sessionId", SESSION_ID
                    ))
            )
        );
    }
}
